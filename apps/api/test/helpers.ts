import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export async function testApp(): Promise<FastifyInstance> {
  const storageDir = await mkdtemp(join(tmpdir(), 'mobigo-storage-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://mobi:mobi@localhost:5432/mobilidade_test',
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
    STORAGE_DIR: storageDir,
  });
  const app = await buildApp(config);
  await app.ready();
  await app.redis.flushdb();
  return app;
}

let seq = 0;
export async function registerUser(app: FastifyInstance, name = 'Maria da Silva') {
  const email = `user${Date.now()}${seq++}@exemplo.com.br`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { name, email, password: 'senhaSegura1', acceptTerms: true, municipalityIbge: '5208707' },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === 'mobigo_rt')!;
  return { ...body, email, auth: { authorization: `Bearer ${body.accessToken}` }, refreshCookie: cookie.value };
}

export const goianiaPoints = [
  { kind: 'origin', lon: -49.2935, lat: -16.6685, originalName: 'Rua de casa, Campinas' },
  { kind: 'board', stopId: '1:PRACA_A', lon: -49.293, lat: -16.668, originalName: 'Praça A (Campinas)' },
  { kind: 'alight', stopId: '1:BIBLIA', lon: -49.2236, lat: -16.6731, originalName: 'Terminal Praça da Bíblia' },
  { kind: 'destination', lon: -49.224, lat: -16.6735, originalName: 'Trabalho' },
];
