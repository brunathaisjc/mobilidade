# ADR 0005 — Tempo real com Server-Sent Events

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
O cliente precisa receber posições de ônibus continuamente e quase não envia nada ao servidor (só escolhe as linhas, o que cabe na URL).

## Decisão
- **SSE** (`text/event-stream`) em `GET /api/realtime/stream?routes=…`:
  - unidirecional, HTTP comum: passa por proxies corporativos, CDNs e HTTP/2 (multiplexação, sem limite de 6 conexões);
  - reconexão automática do `EventSource` com `retry: 3000`;
  - *heartbeat* a cada 15 s e lotes de 500 ms (menos eventos e menos bateria).
- **Fan-out**: cada instância da API abre **uma** conexão Redis em `PSUBSCRIBE rt:ch:*` e distribui em memória para as conexões da linha.
- **Fallback**: após 3 falhas seguidas, o cliente passa a fazer *polling* em `/api/realtime/vehicles` a cada 10 s.

## Alternativas
- **WebSocket:** bidirecional (desnecessário aqui), exige *upgrade* (alguns proxies bloqueiam) e reconexão/heartbeat manuais.
- **Polling puro:** simples, mas com latência e custo por requisição maiores. Fica como fallback.
- **MQTT/WebTransport:** mais complexidade de infraestrutura sem benefício para este caso.

## Consequências
+ Escala horizontal trivial (qualquer instância serve qualquer cliente), sem *sticky sessions*.
− Conexões longas exigem *timeouts* de balanceador ≥ 1 h e `proxy_buffering off` no Nginx (configurado).
