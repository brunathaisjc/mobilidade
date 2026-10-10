import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createDb, type Db } from './lib/db.js';
import { HttpError, unauthorized } from './lib/errors.js';
import { createStorage, type Storage } from './lib/storage.js';
import { authRoutes } from './modules/auth.js';
import { meRoutes } from './modules/me.js';
import { savedRoutesRoutes } from './modules/saved-routes.js';
import { sharingRoutes } from './modules/sharing.js';
import { transitRoutes } from './modules/transit.js';
import { realtimeRoutes } from './modules/realtime.js';
import { RealtimeHub } from './realtime/hub.js';
import { RealtimeStore } from './realtime/store.js';
import { createPlanner, type Planner } from './planner/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    redis: Redis;
    storage: Storage;
    realtime: RealtimeStore;
    hub: RealtimeHub;
    planner: Planner;
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export interface AppDeps {
  db?: Db;
  redis?: Redis;
  storage?: Storage;
  planner?: Planner;
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // Nunca registrar credenciais ou tokens (LGPD / segurança).
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  const db = deps.db ?? createDb(config.DATABASE_URL);
  const redis = deps.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const storage = deps.storage ?? createStorage(config);
  const realtime = new RealtimeStore(redis);
  const hub = new RealtimeHub(redis.duplicate(), app.log);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('storage', storage);
  app.decorate('realtime', realtime);
  app.decorate('hub', hub);
  app.decorate('planner', deps.planner ?? createPlanner(config, db, realtime));

  await app.register(helmet, {
    contentSecurityPolicy: false, // API JSON; a CSP é aplicada pelo servidor do front-end.
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // permite exibir avatares no front-end
  });
  await app.register(cors, { origin: [config.PUBLIC_WEB_URL], credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: config.ACCESS_TOKEN_TTL } });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
  await app.register(rateLimit, {
    global: true,
    // Limites por IP folgados: no Brasil, operadoras móveis usam CGNAT e muitos usuários compartilham o
    // mesmo IP. Proteção fina contra abuso fica no WAF/CDN (ver docs/06).
    max: 600,
    timeWindow: '1 minute',
    redis: config.NODE_ENV === 'test' ? undefined : redis,
    nameSpace: 'rl:',
    skipOnError: true, // se o Redis cair, preferimos atender a bloquear todo mundo
  });
  if (storage.localRoot) {
    await app.register(fastifyStatic, { root: storage.localRoot, prefix: '/media/', decorateReply: false, maxAge: '365d', immutable: true });
  }

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized('Sessão expirada ou inválida');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Dados inválidos',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ error: 'conflict', message: 'Registro já existe' });
    if (pgCode === '23503') return reply.status(400).send({ error: 'bad_reference', message: 'Referência inválida' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as { code?: string }).code ?? 'request_error', message: (err as Error).message });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply.status(500).send({ error: 'internal_error', message: 'Erro interno. Tente novamente.' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_req, reply) => {
    const checks = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
    const [pg, rd] = checks.map((c) => c.status === 'fulfilled');
    return reply.status(pg ? 200 : 503).send({ postgres: pg, redis: rd });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(meRoutes, { prefix: '/api/me' });
  await app.register(savedRoutesRoutes, { prefix: '/api' });
  await app.register(sharingRoutes, { prefix: '/api' });
  await app.register(transitRoutes, { prefix: '/api' });
  await app.register(realtimeRoutes, { prefix: '/api/realtime' });

  app.addHook('onReady', async () => hub.start());
  app.addHook('onClose', async () => {
    await hub.stop();
    if (!deps.redis) redis.disconnect();
    if (!deps.db) await db.end();
  });

  return app;
}
