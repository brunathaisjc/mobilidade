import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isInsideGoias, type PlanRequest } from '@mobigo/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { parseRef, ref } from '../lib/ids.js';
import { lat, lon } from '../lib/validation.js';

const GEOCODE_TTL_S = 7 * 86_400;

const planQuery = z.object({
  fromLat: lat, fromLon: lon, toLat: lat, toLon: lon,
  fromName: z.string().max(200).default('Origem'),
  toName: z.string().max(200).default('Destino'),
  departAt: z.string().datetime({ offset: true }).optional(),
  maxWalkMeters: z.coerce.number().int().min(100).max(2000).optional(),
});

export interface PlaceResult { id: string; name: string; detail: string; lon: number; lat: number; kind: 'stop' | 'address' }

export async function transitRoutes(app: FastifyInstance) {
  app.get('/plan', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const q = planQuery.parse(req.query);
    const from = { name: q.fromName, lon: q.fromLon, lat: q.fromLat };
    const to = { name: q.toName, lon: q.toLon, lat: q.toLat };
    if (!isInsideGoias([from.lon, from.lat]) || !isInsideGoias([to.lon, to.lat])) {
      throw badRequest('Origem e destino precisam estar no estado de Goiás');
    }
    const request: PlanRequest = { from, to, departAt: q.departAt, maxWalkMeters: q.maxWalkMeters };
    return app.planner.plan(request);
  });

  /** Geometria completa de um shape — usada pelo cliente para animar o ônibus ao longo da linha. */
  app.get('/shapes/:shapeRef', async (req, reply) => {
    const { shapeRef } = z.object({ shapeRef: z.string().max(200) }).parse(req.params);
    const parsed = parseRef(shapeRef);
    if (!parsed) throw notFound('Shape');
    const cache = await app.planner.feeds.get(parsed.feedId).catch(() => null);
    const line = cache?.shape(parsed.id);
    if (!line) throw notFound('Shape');
    // Shapes só mudam com nova versão do feed: cache no navegador/CDN por 1 h com revalidação.
    const etag = `"${shapeRef}@${cache!.loadedAt?.getTime() ?? 0}"`;
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    reply.header('Cache-Control', 'public, max-age=3600').header('ETag', etag);
    return { shapeId: shapeRef, coordinates: line.coords, lengthMeters: Math.round(line.length) };
  });

  app.get('/stops/nearby', async (req) => {
    const q = z.object({ lat, lon, radius: z.coerce.number().int().min(50).max(2000).default(500) }).parse(req.query);
    const { rows } = await app.db.query(
      `SELECT s.feed_id, s.stop_id, s.stop_name, ST_X(s.geom::geometry) AS lon, ST_Y(s.geom::geometry) AS lat,
              round(ST_Distance(s.geom, ST_MakePoint($1, $2)::geography)) AS distance,
              COALESCE((SELECT array_agg(DISTINCT r.route_short_name ORDER BY r.route_short_name)
                        FROM gtfs_pattern_stops ps
                        JOIN gtfs_patterns p ON p.feed_id = ps.feed_id AND p.pattern_id = ps.pattern_id
                        JOIN gtfs_routes r ON r.feed_id = p.feed_id AND r.route_id = p.route_id
                        WHERE ps.feed_id = s.feed_id AND ps.stop_id = s.stop_id), '{}') AS lines
       FROM gtfs_stops s JOIN gtfs_feeds f ON f.feed_id = s.feed_id AND f.active
       WHERE ST_DWithin(s.geom, ST_MakePoint($1, $2)::geography, $3)
       ORDER BY s.geom <-> ST_MakePoint($1, $2)::geography
       LIMIT 30`,
      [q.lon, q.lat, q.radius],
    );
    return rows.map((r) => ({
      stopId: ref(r.feed_id, r.stop_id), name: r.stop_name, lon: r.lon, lat: r.lat, distanceMeters: Number(r.distance), lines: r.lines,
    }));
  });

  /**
   * Busca de lugares: pontos de ônibus (PostGIS, trigramas) + endereços via geocodificador
   * compatível com Photon (auto-hospedado com dados OSM de Goiás — custo zero por requisição).
   * Resultados do geocodificador ficam 7 dias no Redis: buscas repetidas ("rodoviária") não saem da rede.
   */
  app.get('/places/search', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { q, lat: nearLat, lon: nearLon } = z.object({ q: z.string().trim().min(2).max(100), lat: lat.optional(), lon: lon.optional() }).parse(req.query);
    const { rows } = await app.db.query(
      `SELECT s.feed_id, s.stop_id, s.stop_name, ST_X(s.geom::geometry) AS lon, ST_Y(s.geom::geometry) AS lat, f.name AS feed_name
       FROM gtfs_stops s JOIN gtfs_feeds f ON f.feed_id = s.feed_id AND f.active
       WHERE immutable_unaccent(lower(s.stop_name)) % immutable_unaccent(lower($1))
          OR immutable_unaccent(lower(s.stop_name)) LIKE '%' || immutable_unaccent(lower($1)) || '%'
       ORDER BY similarity(immutable_unaccent(lower(s.stop_name)), immutable_unaccent(lower($1))) DESC
       LIMIT 6`,
      [q],
    );
    const stops: PlaceResult[] = rows.map((r) => ({
      id: ref(r.feed_id, r.stop_id), name: r.stop_name, detail: `Ponto de ônibus · ${r.feed_name}`, lon: r.lon, lat: r.lat, kind: 'stop',
    }));
    const addresses = app.config.GEOCODER_URL ? await geocode(app, q, nearLat, nearLon) : [];
    return [...addresses.slice(0, 6), ...stops].slice(0, 10);
  });
}

async function geocode(app: FastifyInstance, q: string, nearLat?: number, nearLon?: number): Promise<PlaceResult[]> {
  const key = `geo:q:${q.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')}`;
  const cached = await app.redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached);
  const url = new URL('/api', app.config.GEOCODER_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '8');
  url.searchParams.set('bbox', '-53.3,-19.6,-45.8,-12.3'); // Goiás
  if (nearLat !== undefined && nearLon !== undefined) {
    url.searchParams.set('lat', String(nearLat));
    url.searchParams.set('lon', String(nearLon));
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'mobigo/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] };
    const results: PlaceResult[] = body.features
      .filter((f) => isInsideGoias(f.geometry.coordinates))
      .map((f, i) => {
        const p = f.properties;
        const street = [p.street, p.housenumber].filter(Boolean).join(', ');
        return {
          id: `addr:${p.osm_type ?? ''}${p.osm_id ?? i}`,
          name: p.name ?? street ?? q,
          detail: [p.name ? street : '', p.district, p.city].filter(Boolean).join(' · '),
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: 'address' as const,
        };
      });
    await app.redis.set(key, JSON.stringify(results), 'EX', GEOCODE_TTL_S).catch(() => undefined);
    return results;
  } catch (err) {
    app.log.warn({ err }, 'geocodificador indisponível; retornando só pontos de ônibus');
    return [];
  }
}
