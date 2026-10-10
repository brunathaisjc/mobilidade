import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { randomToken } from '../lib/tokens.js';
import { userText, uuid } from '../lib/validation.js';
import { createRouteBody, insertSavedRoute, loadSavedRoutes } from './saved-routes.js';

const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) });

export async function sharingRoutes(app: FastifyInstance) {
  const shareUrl = (token: string) => `${app.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/r/${token}`;

  const findActiveShare = async (token: string) => {
    const { rows: [share] } = await app.db.query(
      `SELECT s.id, s.saved_route_id, u.name AS owner_name
       FROM route_shares s JOIN saved_routes r ON r.id = s.saved_route_id JOIN users u ON u.id = r.user_id
       WHERE s.token = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())`,
      [token],
    );
    if (!share) throw notFound('Link de compartilhamento');
    return share as { id: string; saved_route_id: string; owner_name: string };
  };

  // ----- Rotas do dono ----------------------------------------------------------------------
  app.post('/saved-routes/:id/shares', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ expiresInDays: z.number().int().min(1).max(365).optional() }).parse(req.body ?? {});
    const token = randomToken(16);
    const { rows: [share] } = await app.db.query(
      `INSERT INTO route_shares (saved_route_id, token, expires_at)
       SELECT r.id, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + $4 * interval '1 day' END
       FROM saved_routes r WHERE r.id = $1 AND r.user_id = $2
       RETURNING id, token, created_at, expires_at`,
      [id, req.user.sub, token, body.expiresInDays ?? null],
    );
    if (!share) throw notFound('Rota');
    return reply.status(201).send({
      id: share.id, url: shareUrl(share.token), token: share.token,
      createdAt: share.created_at, expiresAt: share.expires_at,
    });
  });

  app.get('/saved-routes/:id/shares', { onRequest: [app.authenticate] }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT s.id, s.token, s.created_at, s.expires_at, s.revoked_at, s.view_count
       FROM route_shares s JOIN saved_routes r ON r.id = s.saved_route_id
       WHERE r.id = $1 AND r.user_id = $2 ORDER BY s.created_at DESC`,
      [id, req.user.sub],
    );
    return rows.map((s) => ({
      id: s.id, url: shareUrl(s.token), createdAt: s.created_at, expiresAt: s.expires_at,
      revokedAt: s.revoked_at, viewCount: s.view_count,
      active: !s.revoked_at && (!s.expires_at || s.expires_at > new Date()),
    }));
  });

  app.delete('/shares/:shareId', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { shareId } = z.object({ shareId: uuid }).parse(req.params);
    const { rowCount } = await app.db.query(
      `UPDATE route_shares s SET revoked_at = now() FROM saved_routes r
       WHERE s.id = $1 AND r.id = s.saved_route_id AND r.user_id = $2 AND s.revoked_at IS NULL`,
      [shareId, req.user.sub],
    );
    if (!rowCount) throw notFound('Compartilhamento');
    return reply.status(204).send();
  });

  // ----- Acesso público via link ------------------------------------------------------------
  /**
   * Visualização pública. Expõe apenas o necessário: nome da rota, pontos e o PRIMEIRO nome do dono
   * (minimização de dados — LGPD art. 6º, III). E-mail e foto nunca são expostos.
   */
  app.get('/shared/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = tokenParam.parse(req.params);
    const share = await findActiveShare(token);
    await app.db.query('UPDATE route_shares SET view_count = view_count + 1 WHERE id = $1', [share.id]);
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1', [share.saved_route_id]);
    if (!route) throw notFound('Rota');
    return {
      sharedBy: share.owner_name.split(/\s+/)[0],
      route: {
        name: route.name,
        preferredRouteIds: route.preferredRouteIds,
        points: route.points.map(({ id: _id, ...p }) => p),
      },
    };
  });

  /** Copia a rota compartilhada para a conta de quem recebeu o link. */
  app.post('/shared/:token/copy', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    const body = z.object({ categoryId: uuid.nullable().optional(), name: userText(1, 80).optional() }).parse(req.body ?? {});
    const share = await findActiveShare(token);
    const [src] = await loadSavedRoutes(app.db, 'r.id = $1', [share.saved_route_id]);
    if (!src) throw notFound('Rota');
    const input = createRouteBody.parse({
      name: body.name ?? src.name,
      categoryId: body.categoryId ?? null,
      preferredRouteIds: src.preferredRouteIds,
      points: src.points.map((p) => ({
        kind: p.kind, stopId: p.stopId, lon: p.lon, lat: p.lat, originalName: p.originalName, customName: p.customName,
      })),
    });
    const id = await withTransaction(app.db, (c) => insertSavedRoute(c, req.user.sub, input));
    const [route] = await loadSavedRoutes(app.db, 'r.id = $1', [id]);
    return reply.status(201).send(route);
  });
}
