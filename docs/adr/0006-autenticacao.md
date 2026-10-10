# ADR 0006 — Autenticação e sessão

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
O cadastro é aberto a toda a população, com público de dispositivos variados e alvo atraente para *credential stuffing*. O app é uma SPA.

## Decisão
- Senhas com **Argon2id** (m=19 MiB, t=2, p=1 — recomendação OWASP).
- **Access token JWT** de 15 min, mantido **só em memória** no cliente (fora do `localStorage`, imune a roubo por XSS persistente).
- **Refresh token opaco** (256 bits) em cookie `httpOnly; Secure; SameSite=Strict; Path=/api/auth`. No banco fica só o SHA-256.
- **Rotação a cada uso com detecção de reuso**: reapresentar um token já usado revoga a família inteira (indício de roubo).
- Mesma resposta e tempo para e-mail inexistente ou senha errada (sem enumeração de contas).
- *Rate limit* de 10/min por IP nos endpoints de autenticação.

## Alternativas
- **Sessão com estado no servidor (cookie de sessão):** simples e boa, mas exige uma consulta ao Redis/BD por requisição. O JWT curto evita isso no caminho quente (consulta de rotas).
- **Login apenas via gov.br:** reduz a responsabilidade com senhas, mas exclui quem não tem conta gov.br nível prata/ouro. Planejado como **opção adicional** (roadmap).

## Consequências
+ Proteção contra XSS (token em memória) e CSRF (SameSite=Strict + Path restrito).
− Cada nova aba faz um `refresh` ao abrir (custo baixo).
