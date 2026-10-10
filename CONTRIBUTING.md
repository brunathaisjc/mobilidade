# Contribuindo

## Fluxo
1. Abra ou escolha uma issue (modelos em `.github/ISSUE_TEMPLATE`). Funcionalidades nascem como **história de usuário com critérios de aceite**.
2. Crie uma branch curta a partir de `main`: `feat/rotas-reordenar-categorias`, `fix/eta-feriado`.
3. Commits no padrão **Conventional Commits** (`feat(api): …`, `fix(web): …`, `docs: …`), em português.
4. Abra o PR usando o template, com CI verde e uma revisão aprovada.
5. Decisão de arquitetura → novo ADR em `docs/adr/` (modelo `0000-modelo.md`).

## Padrões de código
- TypeScript estrito (`noUncheckedIndexedAccess`). Sem `any` em código novo.
- Validação de toda entrada externa com **Zod** na borda (rotas da API, variáveis de ambiente).
- SQL sempre parametrizado. Consultas de dados do usuário **sempre** filtram por `user_id`.
- Lógica compartilhada entre servidor e navegador (geometria, ETA, cores) fica em `packages/shared`, com teste.
- Mensagens ao usuário em português claro. Datas e números formatados em pt-BR, fuso `America/Sao_Paulo`.
- Acessibilidade: elementos interativos nativos (`button`, `a`, `input`), rótulos visíveis, alvo de toque ≥ 44 px, cor nunca como único canal.
- Logs sem dados pessoais.

## Migrações de banco
- Nunca edite uma migração já aplicada; crie `db/migrations/NNNN_descricao.sql`.
- Deploy sem indisponibilidade: **expandir → migrar dados → contrair** em releases separadas.

## Definition of Done
Ver [docs/07-plano-de-testes.md](docs/07-plano-de-testes.md#4-critérios-de-pronto-definition-of-done).
