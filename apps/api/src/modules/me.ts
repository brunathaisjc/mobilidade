import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/tokens.js';
import { userText } from '../lib/validation.js';
import { toPublicUser } from './auth.js';

const USER_COLUMNS = 'id, name, email, municipality_ibge, avatar_key, created_at';
const AVATAR_SIZE = 512;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);

/**
 * Normaliza a foto de perfil: aplica a orientação EXIF, recorta quadrado, converte para WebP e
 * descarta TODOS os metadados (EXIF pode conter a localização GPS de onde a foto foi tirada).
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' });
  const meta = await image.metadata().catch(() => null);
  if (!meta?.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw badRequest('Envie uma imagem JPEG, PNG, WebP ou HEIC');
  }
  return image
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();
}

export async function meRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  const loadUser = async (id: string) => {
    const { rows } = await app.db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Usuário');
    return rows[0];
  };

  app.get('/', async (req) => toPublicUser(app, await loadUser(req.user.sub)));

  app.patch('/', async (req) => {
    const body = z.object({
      name: userText(2, 120).optional(),
      municipalityIbge: z.string().regex(/^52\d{5}$/).nullable().optional(),
    }).strict().parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE users SET
         name = COALESCE($2::text, name),
         municipality_ibge = CASE WHEN $3::boolean THEN $4::char(7) ELSE municipality_ibge END
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [req.user.sub, body.name ?? null, body.municipalityIbge !== undefined, body.municipalityIbge ?? null],
    );
    return toPublicUser(app, rows[0]);
  });

  app.put('/avatar', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Nenhum arquivo enviado');
    const raw = await file.toBuffer().catch((e: { code?: string }) => {
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('A imagem deve ter no máximo 5 MB');
      throw e;
    });
    const webp = await processAvatar(raw);
    // Chave aleatória por upload: permite cache imutável na CDN e evita adivinhar URLs.
    const key = `avatars/${req.user.sub}/${randomToken(12)}.webp`;
    await app.storage.put(key, webp, 'image/webp');
    const { rows: [old] } = await app.db.query('SELECT avatar_key FROM users WHERE id = $1', [req.user.sub]);
    const { rows } = await app.db.query(`UPDATE users SET avatar_key = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [req.user.sub, key]);
    if (old?.avatar_key) await app.storage.delete(old.avatar_key).catch((err) => req.log.warn({ err }, 'falha ao remover avatar antigo'));
    return toPublicUser(app, rows[0]);
  });

  app.delete('/avatar', async (req) => {
    const { rows: [old] } = await app.db.query('SELECT avatar_key FROM users WHERE id = $1', [req.user.sub]);
    const { rows } = await app.db.query(`UPDATE users SET avatar_key = NULL WHERE id = $1 RETURNING ${USER_COLUMNS}`, [req.user.sub]);
    if (old?.avatar_key) await app.storage.delete(old.avatar_key);
    return toPublicUser(app, rows[0]);
  });

  /** LGPD art. 18, II e V: acesso e portabilidade dos dados pessoais. */
  app.get('/export', async (req, reply) => {
    const user = await loadUser(req.user.sub);
    const [categories, routes, points, shares] = await Promise.all([
      app.db.query('SELECT id, name, color, icon, position, created_at FROM route_categories WHERE user_id = $1', [req.user.sub]),
      app.db.query('SELECT id, category_id, name, preferred_route_ids, created_at, updated_at FROM saved_routes WHERE user_id = $1', [req.user.sub]),
      app.db.query(
        `SELECT p.saved_route_id, p.seq, p.kind, p.stop_id, ST_X(p.geom::geometry) AS lon, ST_Y(p.geom::geometry) AS lat,
                p.original_name, p.custom_name
         FROM saved_route_points p JOIN saved_routes r ON r.id = p.saved_route_id WHERE r.user_id = $1`, [req.user.sub]),
      app.db.query(
        `SELECT s.saved_route_id, s.created_at, s.expires_at, s.revoked_at, s.view_count
         FROM route_shares s JOIN saved_routes r ON r.id = s.saved_route_id WHERE r.user_id = $1`, [req.user.sub]),
    ]);
    reply.header('Content-Disposition', 'attachment; filename="meus-dados-mobigo.json"');
    return {
      exportedAt: new Date().toISOString(),
      user: toPublicUser(app, user),
      categories: categories.rows,
      savedRoutes: routes.rows,
      points: points.rows,
      shares: shares.rows,
    };
  });

  /** LGPD art. 18, VI: eliminação. Remove a conta e, em cascata, rotas, pontos e compartilhamentos. */
  app.delete('/', async (req, reply) => {
    const { rows: [user] } = await app.db.query('DELETE FROM users WHERE id = $1 RETURNING avatar_key', [req.user.sub]);
    if (user?.avatar_key) await app.storage.delete(user.avatar_key).catch(() => undefined);
    reply.clearCookie('mobigo_rt', { path: '/api/auth' });
    return reply.status(204).send();
  });
}
