import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerUser, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await testApp(); });
afterAll(async () => { await app.close(); });

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = '----mobigo' + Date.now();
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('perfil', () => {
  it('atualiza nome e município', async () => {
    const u = await registerUser(app);
    const res = await app.inject({ method: 'PATCH', url: '/api/me', headers: u.auth, payload: { name: 'Maria S.', municipalityIbge: '5201108' } });
    expect(res.json()).toMatchObject({ name: 'Maria S.', municipalityIbge: '5201108' });
    const bad = await app.inject({ method: 'PATCH', url: '/api/me', headers: u.auth, payload: { municipalityIbge: '3550308' } });
    expect(bad.statusCode).toBe(400); // São Paulo: fora de Goiás
  });

  it('envia foto de perfil: redimensiona para 512px WebP e remove metadados EXIF (inclusive GPS)', async () => {
    const u = await registerUser(app);
    const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366cc' } })
      .jpeg().withExif({ IFD0: { Artist: 'Fulano', ImageDescription: 'casa' } }).toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const { payload, headers } = multipart('foto.jpg', 'image/jpeg', jpeg);
    const res = await app.inject({ method: 'PUT', url: '/api/me/avatar', headers: { ...headers, ...u.auth }, payload });
    expect(res.statusCode).toBe(200);
    const url: string = res.json().avatarUrl;
    expect(url).toMatch(/^\/media\/avatars\/.+\.webp$/);

    const img = await app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();
  });

  it('rejeita arquivo que não é imagem, mesmo com content-type de imagem', async () => {
    const u = await registerUser(app);
    const { payload, headers } = multipart('virus.jpg', 'image/jpeg', Buffer.from('#!/bin/sh\necho oi'));
    const res = await app.inject({ method: 'PUT', url: '/api/me/avatar', headers: { ...headers, ...u.auth }, payload });
    expect(res.statusCode).toBe(400);
  });

  it('exporta dados (portabilidade) e exclui a conta (LGPD)', async () => {
    const u = await registerUser(app);
    const exp = await app.inject({ method: 'GET', url: '/api/me/export', headers: u.auth });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().user.email).toBe(u.email);
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: u.auth })).statusCode).toBe(204);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: 'senhaSegura1' } });
    expect(login.statusCode).toBe(401);
  });
});
