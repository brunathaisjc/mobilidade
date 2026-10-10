import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerUser, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await testApp(); });
afterAll(async () => { await app.close(); });

describe('cadastro e login', () => {
  it('cadastra, devolve token de acesso e cookie de sessão httpOnly', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'João Pereira', email: 'Joao@Exemplo.com.br', password: 'abc12345', acceptTerms: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ name: 'João Pereira', email: 'joao@exemplo.com.br', avatarUrl: null });
    expect(body.user).not.toHaveProperty('password_hash');
    const cookie = res.cookies.find((c) => c.name === 'mobigo_rt');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });
  });

  it('rejeita e-mail duplicado, senha fraca e falta de aceite dos termos', async () => {
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { name: 'Outro', email: 'joao@exemplo.com.br', password: 'abc12345', acceptTerms: true } });
    expect(dup.statusCode).toBe(409);
    const weak = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { name: 'Fraco', email: 'fraco@exemplo.com.br', password: 'abcdefgh', acceptTerms: true } });
    expect(weak.statusCode).toBe(400);
    const terms = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { name: 'Sem termos', email: 'termos@exemplo.com.br', password: 'abc12345', acceptTerms: false } });
    expect(terms.statusCode).toBe(400);
    expect(terms.json().issues[0].path).toBe('acceptTerms');
  });

  it('faz login e recusa senha errada com a mesma mensagem de e-mail inexistente', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'joao@exemplo.com.br', password: 'abc12345' } });
    expect(ok.statusCode).toBe(200);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'joao@exemplo.com.br', password: 'errada123' } });
    const ghost = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ninguem@exemplo.com.br', password: 'errada123' } });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().message).toBe(ghost.json().message);
  });
});

describe('sessão', () => {
  it('rotaciona o refresh token e revoga a família inteira se um token antigo for reutilizado', async () => {
    const u = await registerUser(app);
    const first = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { mobigo_rt: u.refreshCookie } });
    expect(first.statusCode).toBe(200);
    const rotated = first.cookies.find((c) => c.name === 'mobigo_rt')!.value;
    expect(rotated).not.toBe(u.refreshCookie);

    // Reuso do token antigo (ex.: cookie roubado) → 401 e revogação da cadeia
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { mobigo_rt: u.refreshCookie } });
    expect(reuse.statusCode).toBe(401);
    const afterReuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { mobigo_rt: rotated } });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('logout invalida o refresh token', async () => {
    const u = await registerUser(app);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { mobigo_rt: u.refreshCookie } });
    expect(out.statusCode).toBe(204);
    const again = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { mobigo_rt: u.refreshCookie } });
    expect(again.statusCode).toBe(401);
  });

  it('protege rotas autenticadas', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer invalido' } })).statusCode).toBe(401);
  });
});
