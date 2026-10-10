# ADR 0002 — PostgreSQL + PostGIS (+ TimescaleDB) e Redis

- **Status:** aceita · **Data:** 2026-10-10

## Contexto
O GTFS é relacional (linhas → viagens → horários ← pontos, calendário com exceções), e as perguntas centrais misturam JOINs com geografia: "pontos a 600 m daqui servidos por linhas que passam depois perto do destino, válidas hoje". O GPS gera um fluxo contínuo de escritas que sobrescrevem o estado anterior.

## Decisão
- **PostgreSQL 16 + PostGIS** como fonte da verdade (usuários, rotas salvas, GTFS, histórico).
  - `geography` + GiST para proximidade (`ST_DWithin`, KNN `<->`).
  - Referência linear (distância do ponto ao longo do shape) calculada na carga e guardada em `gtfs_pattern_stops.dist_m`.
  - `pg_trgm` + `unaccent` para busca de pontos por nome.
- **TimescaleDB** para `vehicle_positions` (compressão, retenção, *continuous aggregates*), **opcional**: a migração detecta a extensão e, sem ela, mantém tabela comum (para usar `pg_partman` em provedores que não oferecem Timescale).
- **Redis** para o estado quente (última posição, pub/sub, *rate limit*, cache). Sem persistência: é reconstruível.

## Alternativas
- **MongoDB (2dsphere):** atende ponto e polígono, mas não tem referência linear nem JOIN eficiente para o calendário GTFS. Desnormalizar `stop_times` multiplicaria escritas a cada nova programação.
- **Gravar posições direto no PostgreSQL e ler de lá:** ~300–1.500 *updates*/s geram *bloat* e vacuum constantes. O Redis faz isso em O(1) e ainda distribui por pub/sub.

## Consequências
+ Consultas de rota em uma ida ao banco; sem custo de licença; serviços gerenciados no Brasil.
+ A perda do Redis degrada para horário programado, sem perda de dados.
− Duas tecnologias de dados para operar. Mitigação: o Redis é gerenciado e sem estado durável.
