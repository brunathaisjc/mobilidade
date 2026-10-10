# ADR 0001 — Monorepo TypeScript

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
API, workers de tempo real e app web compartilham regras críticas: geometria sobre o traçado, ETA, limites de *dead reckoning* e o contrato da API. Se o servidor e o cliente divergirem nessas regras, o ícone do ônibus e a previsão exibida se contradizem.

## Decisão
Monorepo **pnpm workspaces** com **TypeScript estrito** de ponta a ponta:
`packages/shared` (geometria, ETA, cores, tipos do contrato), `apps/api` (Fastify + workers) e `apps/web` (React + Vite).
As constantes `STALE_AFTER_S` e `MAX_DEAD_RECKONING_S` vêm do mesmo módulo para o servidor e o cliente.

## Alternativas
- **Python (FastAPI) no back-end + TS no front:** forte em dados, mas duplicaria geometria e ETA em duas linguagens.
- **Go no ingestor:** mais desempenho por núcleo, mas a carga estimada (≤ 1.500 msg/s) cabe em um processo Node com folga. Reavaliar se houver 10× mais.

## Consequências
+ Um único conjunto de tipos; refatorações seguras; testes da mesma lógica nos dois lados.
+ Contratação mais simples (uma linguagem).
− Node não é a melhor escolha para processamento geoespacial pesado. Esse trabalho fica no PostGIS e no OTP (Java).
