import type { FastifyInstance, FastifyReply } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/tokens.js';
import { userText } from '../lib/validation.js';

const REFRESH_COOKIE = 'mobigo_rt';

// Parâmetros OWASP 2024 para Argon2id (m=19 MiB, t=2, p=1): ~50 ms por hash em CPU de servidor.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
// Hash fixo para igualar o tempo de resposta quando o e-mail não existe (evita enumeração de contas).
const DUMMY_HASH = await hash('dummy-password-for-timing', ARGON2);

const password = z.string().min(8, 'mínimo de 8 caracteres').max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'use letras e números');

const registerBody = z.object({
  name: userText(2, 120),
  email: z.string().trim().toLowerCase().email().max(254),
  password,
  municipalityIbge: z.string().regex(/^52\d{5}$/, 'código IBGE de município goiano').optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'é preciso aceitar os termos de uso e a política de privacidade' }) }),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  municipalityIbge: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export function toPublicUser(app: FastifyInstance, row: {
  id: string; name: string; email: string; municipality_ibge: string | null; avatar_key: string | null; created_at: Date;
}): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    municipalityIbge: row.municipality_ibge,
    avatarUrl: row.avatar_key ? app.storage.publicUrl(row.avatar_key) : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const cfg = app.config;
  const refreshTtlMs = cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000;

  async function issueSession(reply: FastifyReply, userId: string, familyId?: string) {
    const token = randomToken();
    await app.db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, now() + $4 * interval '1 millisecond')`,
      [userId, familyId ?? null, sha256(token), refreshTtlMs],
    );
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: cfg.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: refreshTtlMs / 1000,
    });
    return app.jwt.sign({ sub: userId });
  }

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', authLimit, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const passwordHash = await hash(body.password, ARGON2);
    const { rows } = await app.db.query(
      `INSERT INTO users (email, password_hash, name, municipality_ibge, terms_version, terms_accepted_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email, municipality_ibge, avatar_key, created_at`,
      [body.email, passwordHash, body.name, body.municipalityIbge ?? null, cfg.TERMS_VERSION],
    );
    if (!rows[0]) throw conflict('Já existe uma conta com este e-mail');
    const accessToken = await issueSession(reply, rows[0].id);
    return reply.status(201).send({ user: toPublicUser(app, rows[0]), accessToken });
  });

  app.post('/login', authLimit, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const { rows } = await app.db.query(
      'SELECT id, name, email, municipality_ibge, avatar_key, created_at, password_hash FROM users WHERE email = $1',
      [body.email],
    );
    const user = rows[0];
    const ok = await verify(user?.password_hash ?? DUMMY_HASH, body.password);
    if (!user || !ok) throw unauthorized('E-mail ou senha incorretos');
    const accessToken = await issueSession(reply, user.id);
    return { user: toPublicUser(app, user), accessToken };
  });

  /** Rotação de refresh token com detecção de reuso (OWASP / RFC 9700 §4.14). */
  app.post('/refresh', authLimit, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized();
    const { rows } = await app.db.query(
      'SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    const current = rows[0];
    if (!current) throw unauthorized();
    if (current.revoked_at) {
      // Token já usado: alguém pode ter copiado o cookie. Encerra a cadeia inteira.
      await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [current.family_id]);
      req.log.warn({ userId: current.user_id }, 'reuso de refresh token detectado; sessão revogada');
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized('Sessão encerrada por segurança. Entre novamente.');
    }
    if (current.expires_at < new Date()) throw unauthorized('Sessão expirada');

    // Marca como revogado de forma atômica: duas requisições simultâneas não podem ambas rotacionar.
    const { rowCount } = await app.db.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [current.id]);
    if (rowCount !== 1) throw unauthorized();
    const accessToken = await issueSession(reply, current.user_id, current.family_id);
    await app.db.query(
      `UPDATE refresh_tokens SET replaced_by = (SELECT id FROM refresh_tokens WHERE family_id = $1 ORDER BY created_at DESC LIMIT 1)
       WHERE id = $2`, [current.family_id, current.id]);
    const { rows: [user] } = await app.db.query(
      'SELECT id, name, email, municipality_ibge, avatar_key, created_at FROM users WHERE id = $1', [current.user_id]);
    if (!user) throw unauthorized();
    return { user: toPublicUser(app, user), accessToken };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await app.db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
        [sha256(token)],
      );
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return reply.status(204).send();
  });

  app.post('/change-password', { ...authLimit, onRequest: [app.authenticate] }, async (req, reply) => {
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).parse(req.body);
    const { rows: [user] } = await app.db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (!user || !(await verify(user.password_hash, body.currentPassword))) throw badRequest('Senha atual incorreta');
    await app.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hash(body.newPassword, ARGON2), req.user.sub]);
    // Encerra todas as outras sessões.
    await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.sub]);
    const accessToken = await issueSession(reply, req.user.sub);
    return { accessToken };
  });
}
