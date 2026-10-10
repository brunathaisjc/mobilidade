import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isInsideGoias } from '@mobigo/shared';
import { withTransaction } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { lat, lon, userText, uuid } from '../lib/validation.js';

const MAX_CATEGORIES = 30;
const MAX_ROUTES = 200;

const categoryBody = z.object({
  name: userText(1, 40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().regex(/^[a-z0-9-]{1,30}$/).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

const pointInput = z.object({
  kind: z.enum(['origin', 'board', 'alight', 'waypoint', 'destination']),
  stopId: z.string().max(120).nullable().optional(),
  lon,
  lat,
  originalName: userText(1, 200),
  customName: userText(1, 60).nullable().optional(),
}).refine((p) => isInsideGoias([p.lon, p.lat]), 'o ponto precisa estar dentro do estado de Goiás');

const routeIdRef = z.string().regex(/^\d+:[^\s]{1,100}$/, 'formato esperado: <feedId>:<routeId>');

const createRouteBody = z.object({
  name: userText(1, 80),
  categoryId: uuid.nullable().optional(),
  preferredRouteIds: z.array(routeIdRef).max(20).default([]),
  points: z.array(pointInput).min(2).max(12),
}).refine((r) => r.points[0]!.kind === 'origin' && r.points[r.points.length - 1]!.kind === 'destination',
  'a rota deve começar na origem e terminar no destino');

const updateRouteBody = z.object({
  name: userText(1, 80).optional(),
  categoryId: uuid.nullable().optional(),
  preferredRouteIds: z.array(routeIdRef).max(20).optional(),
}).strict();

export interface SavedRouteDto {
  id: string;
  name: string;
  categoryId: string | null;
  preferredRouteIds: string[];
  createdAt: string;
  updatedAt: string;
  points: {
    id: string; seq: number; kind: string; stopId: string | null; lon: number; lat: number;
    originalName: string; customName: string | null; displayName: string;
  }[];
}

/** Carrega rotas com pontos em uma única consulta (sem N+1). */
export async function loadSavedRoutes(
  db: pg.Pool | pg.PoolClient, where: string, params: unknown[],
): Promise<SavedRouteDto[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.category_id, r.preferred_route_ids, r.created_at, r.updated_at,
            COALESCE(json_agg(json_build_object(
              'id', p.id, 'seq', p.seq, 'kind', p.kind, 'stopId', p.stop_id,
              'lon', ST_X(p.geom::geometry), 'lat', ST_Y(p.geom::geometry),
              'originalName', p.original_name, 'customName', p.custom_name
            ) ORDER BY p.seq) FILTER (WHERE p.id IS NOT NULL), '[]') AS points
     FROM saved_routes r LEFT JOIN saved_route_points p ON p.saved_route_id = r.id
     WHERE ${where}
     GROUP BY r.id ORDER BY r.updated_at DESC`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    preferredRouteIds: r.preferred_route_ids,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    points: r.points.map((p: SavedRouteDto['points'][number]) => ({ ...p, displayName: p.customName ?? p.originalName })),
  }));
}

export async function insertSavedRoute(
  client: pg.PoolClient, userId: string, body: z.infer<typeof createRouteBody>,
): Promise<string> {
  if (body.categoryId) {
    const { rowCount } = await client.query('SELECT 1 FROM route_categories WHERE id = $1 AND user_id = $2', [body.categoryId, userId]);
    if (!rowCount) throw badRequest('Categoria inexistente');
  }
  const { rows: [count] } = await client.query('SELECT count(*)::int AS n FROM saved_routes WHERE user_id = $1', [userId]);
  if (count.n >= MAX_ROUTES) throw badRequest(`Limite de ${MAX_ROUTES} rotas salvas atingido`);
  const { rows: [route] } = await client.query(
    'INSERT INTO saved_routes (user_id, category_id, name, preferred_route_ids) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, body.categoryId ?? null, body.name, body.preferredRouteIds],
  );
  await client.query(
    `INSERT INTO saved_route_points (saved_route_id, seq, kind, stop_id, geom, original_name, custom_name)
     SELECT $1, t.seq, t.kind, t.stop_id, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography, t.original_name, t.custom_name
     FROM unnest($2::int2[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::text[], $8::text[])
       AS t(seq, kind, stop_id, lon, lat, original_name, custom_name)`,
    [route.id, body.points.map((_, i) => i), body.points.map((p) => p.kind), body.points.map((p) => p.stopId ?? null),
      body.points.map((p) => p.lon), body.points.map((p) => p.lat), body.points.map((p) => p.originalName),
      body.points.map((p) => p.customName ?? null)],
  );
  return route.id;
}

export { createRouteBody };

export async function savedRoutesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  // ----- Categorias -------------------------------------------------------------------------
  app.get('/categories', async (req) => {
    const { rows } = await app.db.query(
      `SELECT c.id, c.name, c.color, c.icon, c.position, count(r.id)::int AS "routeCount"
       FROM route_categories c LEFT JOIN saved_routes r ON r.category_id = c.id
       WHERE c.user_id = $1 GROUP BY c.id ORDER BY c.position, c.name`,
      [req.user.sub],
    );
    return rows;
  });

  app.post('/categories', async (req, reply) => {
    const body = categoryBody.parse(req.body);
    const { rows: [count] } = await app.db.query('SELECT count(*)::int AS n FROM route_categories WHERE user_id = $1', [req.user.sub]);
    if (count.n >= MAX_CATEGORIES) throw badRequest(`Limite de ${MAX_CATEGORIES} categorias atingido`);
    const { rows } = await app.db.query(
      `INSERT INTO route_categories (user_id, name, color, icon, position)
       VALUES ($1, $2, COALESCE($3::text, '#1f6feb'), COALESCE($4::text, 'bookmark'), COALESCE($5::int2, $6::int2))
       RETURNING id, name, color, icon, position`,
      [req.user.sub, body.name, body.color ?? null, body.icon ?? null, body.position ?? null, count.n],
    );
    return reply.status(201).send({ ...rows[0], routeCount: 0 });
  });

  app.patch('/categories/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = categoryBody.partial().strict().parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE route_categories SET name = COALESCE($3::text, name), color = COALESCE($4::text, color),
         icon = COALESCE($5::text, icon), position = COALESCE($6::int2, position)
       WHERE id = $1 AND user_id = $2 RETURNING id, name, color, icon, position`,
      [id, req.user.sub, body.name ?? null, body.color ?? null, body.icon ?? null, body.position ?? null],
    );
    if (!rows[0]) throw notFound('Categoria');
    return rows[0];
  });

  /** Excluir categoria não exclui as rotas: elas ficam "sem categoria" (ON DELETE SET NULL). */
  app.delete('/categories/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rowCount } = await app.db.query('DELETE FROM route_categories WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
    if (!rowCount) throw notFound('Categoria');
    return reply.status(204).send();
  });

  // ----- Rotas salvas -----------------------------------------------------------------------
  app.get('/saved-routes', async (req) => {
    const q = z.object({ categoryId: z.union([uuid, z.literal('none')]).optional() }).parse(req.query);
    if (q.categoryId === 'none') return loadSavedRoutes(app.db, 'r.user_id = $1 AND r.category_id IS NULL', [req.user.sub]);
    if (q.categoryId) return loadSavedRoutes(app.db, 'r.user_id = $1 AND r.category_id = $2', [req.user.sub, q.categoryId]);
    return loadSavedRoutes(app.db, 'r.user_id = $1', [req.user.sub]);
  });

  app.get('/saved-routes/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1 AND r.user_id = $2', [id, req.user.sub]);
    if (!route) throw notFound('Rota');
    return route;
  });

  app.post('/saved-routes', async (req, reply) => {
    const body = createRouteBody.parse(req.body);
    const id = await withTransaction(app.db, (c) => insertSavedRoute(c, req.user.sub, body));
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1', [id]);
    return reply.status(201).send(route);
  });

  app.patch('/saved-routes/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateRouteBody.parse(req.body);
    if (body.categoryId) {
      const { rowCount } = await app.db.query('SELECT 1 FROM route_categories WHERE id = $1 AND user_id = $2', [body.categoryId, req.user.sub]);
      if (!rowCount) throw badRequest('Categoria inexistente');
    }
    const { rowCount } = await app.db.query(
      `UPDATE saved_routes SET
         name = COALESCE($3::text, name),
         category_id = CASE WHEN $4::boolean THEN $5::uuid ELSE category_id END,
         preferred_route_ids = COALESCE($6::text[], preferred_route_ids)
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.sub, body.name ?? null, body.categoryId !== undefined, body.categoryId ?? null, body.preferredRouteIds ?? null],
    );
    if (!rowCount) throw notFound('Rota');
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1', [id]);
    return route;
  });

  /** Nome personalizado de um ponto da rota (ex.: "Casa da vó", "Ponto da padaria"). null volta ao nome original. */
  app.patch('/saved-routes/:id/points/:pointId', async (req) => {
    const { id, pointId } = z.object({ id: uuid, pointId: uuid }).parse(req.params);
    const body = z.object({ customName: userText(1, 60).nullable() }).strict().parse(req.body);
    const { rowCount } = await app.db.query(
      `UPDATE saved_route_points p SET custom_name = $4
       FROM saved_routes r
       WHERE p.id = $1 AND p.saved_route_id = $2 AND r.id = p.saved_route_id AND r.user_id = $3`,
      [pointId, id, req.user.sub, body.customName],
    );
    if (!rowCount) throw notFound('Ponto');
    await app.db.query('UPDATE saved_routes SET updated_at = now() WHERE id = $1', [id]);
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1', [id]);
    return route;
  });

  app.delete('/saved-routes/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rowCount } = await app.db.query('DELETE FROM saved_routes WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
    if (!rowCount) throw notFound('Rota');
    return reply.status(204).send();
  });
}
