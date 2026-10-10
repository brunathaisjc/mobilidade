import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { goianiaPoints, registerUser, testApp } from './helpers.js';

let app: FastifyInstance;
let maria: Awaited<ReturnType<typeof registerUser>>;
let joao: Awaited<ReturnType<typeof registerUser>>;

beforeAll(async () => {
  app = await testApp();
  maria = await registerUser(app, 'Maria da Silva');
  joao = await registerUser(app, 'João Souza');
});
afterAll(async () => { await app.close(); });

async function createRoute(user = maria, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/saved-routes', headers: user.auth,
    payload: { name: 'Casa → Trabalho', preferredRouteIds: ['1:L101'], points: goianiaPoints, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('categorias', () => {
  it('cria, lista com contagem, renomeia e exclui sem apagar as rotas', async () => {
    const cat = (await app.inject({ method: 'POST', url: '/api/categories', headers: maria.auth, payload: { name: 'Trabalho', color: '#d1490b' } })).json();
    const route = await createRoute(maria, { categoryId: cat.id });
    const list = (await app.inject({ method: 'GET', url: '/api/categories', headers: maria.auth })).json();
    expect(list.find((c: { id: string }) => c.id === cat.id).routeCount).toBe(1);

    const dup = await app.inject({ method: 'POST', url: '/api/categories', headers: maria.auth, payload: { name: 'TRABALHO' } });
    expect(dup.statusCode).toBe(409);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/categories/${cat.id}`, headers: maria.auth, payload: { name: 'Emprego' } });
    expect(renamed.json().name).toBe('Emprego');

    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${cat.id}`, headers: maria.auth })).statusCode).toBe(204);
    const after = (await app.inject({ method: 'GET', url: `/api/saved-routes/${route.id}`, headers: maria.auth })).json();
    expect(after.categoryId).toBeNull();
  });

  it('filtra rotas por categoria e "sem categoria"', async () => {
    const cat = (await app.inject({ method: 'POST', url: '/api/categories', headers: maria.auth, payload: { name: 'Faculdade' } })).json();
    const inCat = await createRoute(maria, { categoryId: cat.id, name: 'Para a UFG' });
    const byCat = (await app.inject({ method: 'GET', url: `/api/saved-routes?categoryId=${cat.id}`, headers: maria.auth })).json();
    expect(byCat.map((r: { id: string }) => r.id)).toEqual([inCat.id]);
    const none = (await app.inject({ method: 'GET', url: '/api/saved-routes?categoryId=none', headers: maria.auth })).json();
    expect(none.every((r: { categoryId: string | null }) => r.categoryId === null)).toBe(true);
  });
});

describe('rotas salvas e pontos personalizados', () => {
  it('salva a rota com os pontos em ordem e permite renomear um ponto', async () => {
    const route = await createRoute();
    expect(route.points.map((p: { kind: string }) => p.kind)).toEqual(['origin', 'board', 'alight', 'destination']);
    const board = route.points[1];
    const res = await app.inject({
      method: 'PATCH', url: `/api/saved-routes/${route.id}/points/${board.id}`, headers: maria.auth,
      payload: { customName: 'Ponto da padaria' },
    });
    expect(res.statusCode).toBe(200);
    const renamed = res.json().points[1];
    expect(renamed).toMatchObject({ customName: 'Ponto da padaria', originalName: 'Praça A (Campinas)', displayName: 'Ponto da padaria' });

    const reset = await app.inject({
      method: 'PATCH', url: `/api/saved-routes/${route.id}/points/${board.id}`, headers: maria.auth, payload: { customName: null },
    });
    expect(reset.json().points[1].displayName).toBe('Praça A (Campinas)');
  });

  it('valida ordem dos pontos e limite geográfico de Goiás', async () => {
    const reversed = await app.inject({ method: 'POST', url: '/api/saved-routes', headers: maria.auth,
      payload: { name: 'x', points: [...goianiaPoints].reverse() } });
    expect(reversed.statusCode).toBe(400);
    const outside = await app.inject({ method: 'POST', url: '/api/saved-routes', headers: maria.auth,
      payload: { name: 'SP', points: [{ ...goianiaPoints[0], lon: -46.63, lat: -23.55 }, goianiaPoints[3]] } });
    expect(outside.statusCode).toBe(400);
  });

  it('isola dados entre usuários (sem IDOR)', async () => {
    const route = await createRoute(maria);
    const read = await app.inject({ method: 'GET', url: `/api/saved-routes/${route.id}`, headers: joao.auth });
    expect(read.statusCode).toBe(404);
    const rename = await app.inject({ method: 'PATCH', url: `/api/saved-routes/${route.id}/points/${route.points[0].id}`,
      headers: joao.auth, payload: { customName: 'hackeado' } });
    expect(rename.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/saved-routes/${route.id}`, headers: joao.auth });
    expect(del.statusCode).toBe(404);
    const share = await app.inject({ method: 'POST', url: `/api/saved-routes/${route.id}/shares`, headers: joao.auth, payload: {} });
    expect(share.statusCode).toBe(404);
  });
});

describe('compartilhamento', () => {
  it('gera link público, mostra só o primeiro nome do dono, conta visualizações e permite copiar', async () => {
    const route = await createRoute();
    await app.inject({ method: 'PATCH', url: `/api/saved-routes/${route.id}/points/${route.points[3].id}`, headers: maria.auth,
      payload: { customName: 'Escritório' } });
    const share = (await app.inject({ method: 'POST', url: `/api/saved-routes/${route.id}/shares`, headers: maria.auth, payload: { expiresInDays: 7 } })).json();
    expect(share.url).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/);

    const pub = await app.inject({ method: 'GET', url: `/api/shared/${share.token}` });
    expect(pub.statusCode).toBe(200);
    const body = pub.json();
    expect(body.sharedBy).toBe('Maria');
    expect(JSON.stringify(body)).not.toContain(maria.email);
    expect(body.route.points[3].displayName).toBe('Escritório');

    const copy = await app.inject({ method: 'POST', url: `/api/shared/${share.token}/copy`, headers: joao.auth, payload: {} });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().points[3].customName).toBe('Escritório');

    const shares = (await app.inject({ method: 'GET', url: `/api/saved-routes/${route.id}/shares`, headers: maria.auth })).json();
    expect(shares[0]).toMatchObject({ viewCount: 1, active: true });
  });

  it('link revogado deixa de funcionar', async () => {
    const route = await createRoute();
    const share = (await app.inject({ method: 'POST', url: `/api/saved-routes/${route.id}/shares`, headers: maria.auth, payload: {} })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/shares/${share.id}`, headers: maria.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/shared/${share.token}` })).statusCode).toBe(404);
  });
});
