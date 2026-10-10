# 05 — API

Base: `/api`. JSON UTF-8. Autenticação: `Authorization: Bearer <accessToken>` (JWT HS256, 15 min). A renovação é feita pelo cookie httpOnly `mobigo_rt` em `POST /api/auth/refresh`.

## Convenções

- **IDs de transporte** sempre prefixados pelo feed: `"1:L101"` (linha), `"1:PRACA_A"` (ponto), `"1:L101-0"` (shape).
- **Datas** em ISO 8601 UTC. **Distâncias** em metros. **Durações** em segundos.
- **Erros** sempre no formato:
  ```json
  { "error": "validation_error", "message": "Dados inválidos", "issues": [{ "path": "password", "message": "use letras e números" }] }
  ```
  | HTTP | `error` | Quando |
  |---|---|---|
  | 400 | `validation_error`, `bad_request` | Entrada inválida |
  | 401 | `unauthorized` | Sem token, token expirado ou credenciais erradas |
  | 404 | `not_found` | Não existe **ou não pertence a você** (não revelamos qual dos dois) |
  | 409 | `conflict` | E-mail ou nome de categoria já usado |
  | 429 | — | *Rate limit* (cabeçalhos `x-ratelimit-*`) |
- **Rate limit** por IP: 600 req/min no geral; 10/min nos endpoints de autenticação; 60/min em `/plan`; 120 conexões/min em `/realtime/stream`. Os limites são folgados porque operadoras móveis usam CGNAT (muitos usuários no mesmo IP); a proteção fina contra bots fica no WAF.

## Autenticação

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/auth/register` | `{ name, email, password, acceptTerms: true, municipalityIbge? }` | `201 { user, accessToken }` + cookie |
| POST | `/auth/login` | `{ email, password }` | `200 { user, accessToken }` + cookie |
| POST | `/auth/refresh` | — (cookie) | `200 { user, accessToken }` + novo cookie (rotação) |
| POST | `/auth/logout` | — (cookie) | `204` (revoga a cadeia) |
| POST | `/auth/change-password` 🔒 | `{ currentPassword, newPassword }` | `200 { accessToken }` (encerra as outras sessões) |

Senha: 8 a 128 caracteres, com letras e números. Reapresentar um refresh token já usado revoga **toda a cadeia** e exige novo login.

## Perfil 🔒

| Método | Rota | Descrição |
|---|---|---|
| GET | `/me` | Dados da conta |
| PATCH | `/me` | `{ name?, municipalityIbge? \| null }` |
| PUT | `/me/avatar` | `multipart/form-data`, campo `file` (≤ 5 MB). Vira WebP 512×512, sem metadados |
| DELETE | `/me/avatar` | Remove a foto |
| GET | `/me/export` | Todos os dados da pessoa em JSON (portabilidade) |
| DELETE | `/me` | Exclui a conta e tudo o que depende dela |

`User`:
```json
{ "id": "uuid", "name": "Maria da Silva", "email": "maria@exemplo.com.br", "municipalityIbge": "5208707",
  "avatarUrl": "https://cdn…/avatars/<id>/<aleatório>.webp", "createdAt": "2026-10-10T15:03:45.055Z" }
```

## Planejamento

### `GET /plan`
| Parâmetro | Obrigatório | Descrição |
|---|---|---|
| `fromLat`, `fromLon`, `toLat`, `toLon` | sim | Precisam estar dentro de Goiás |
| `fromName`, `toName` | não | Rótulos exibidos |
| `departAt` | não | ISO 8601 com fuso. Padrão: agora |
| `maxWalkMeters` | não | 100–2000 (padrão 800) |

Resposta (resumida):
```json
{
  "engine": "gtfs-direct",
  "generatedAt": "2026-10-10T15:01:12.000Z",
  "itineraries": [{
    "id": "1:L101:0:…", "color": "#1f6feb", "dashed": false, "lines": ["101"],
    "totalDistanceMeters": 7810, "walkDistanceMeters": 90,
    "waitSeconds": 531, "durationSeconds": 2280,
    "departureTime": "…", "arrivalTime": "2026-10-10T15:39:11Z", "realtime": true,
    "legs": [
      { "mode": "WALK", "distanceMeters": 45, "durationSeconds": 38, "geometry": "<polyline>", "from": {…}, "to": {…} },
      { "mode": "BUS", "routeId": "1:L101", "routeShortName": "101", "routeLongName": "Eixo Leste–Oeste…",
        "headsign": "Terminal Novo Mundo", "shapeId": "1:L101-0",
        "board": { "stopId": "1:PRACA_A", "name": "Praça A (Campinas)", "lon": -49.293, "lat": -16.668, "distanceAlong": 3532.1 },
        "alight": { … }, "stopsCount": 17, "distanceMeters": 7640, "durationSeconds": 1620, "geometry": "<polyline>",
        "nextArrivals": [
          { "tripId": "1:L101-0-SAB-114500", "vehicleId": "GO-89603", "waitSeconds": 614,
            "arrivalTime": "…", "scheduledTime": "…", "source": "realtime" },
          { "tripId": "1:L101-0-SAB-120000", "vehicleId": null, "waitSeconds": 1291, "source": "scheduled", … }
        ] },
      { "mode": "WALK", … }
    ]
  }]
}
```
- `color` é distinta para cada itinerário. Acima de 10 opções, a paleta se repete com `dashed: true`.
- `source`: `realtime` (GPS ≤ 60 s), `estimated` (GPS entre 60 s e 5 min, posição extrapolada) ou `scheduled` (sem GPS).
- `geometry` usa o formato *Encoded Polyline* (precisão 5), igual ao do OpenTripPlanner.

### Apoio
| Método | Rota | Descrição |
|---|---|---|
| GET | `/shapes/:shapeId` | Traçado completo `{ coordinates: [[lon,lat],…], lengthMeters }`. `Cache-Control: max-age=3600` + `ETag` |
| GET | `/stops/nearby?lat&lon&radius` | Pontos próximos com as linhas que atendem cada um |
| GET | `/places/search?q&lat?&lon?` | Pontos (PostGIS, sem diferenciar acentos) + endereços (geocodificador, se configurado) |

## Tempo real

### `GET /realtime/stream?routes=1:L101,1:L102` (Server-Sent Events)
Até 20 linhas por conexão. Eventos:

```
retry: 3000

id: 1
event: snapshot
data: [VehicleUpdate, …]          ← estado atual ao conectar

id: 2
event: vehicles
data: [VehicleUpdate, …]          ← lotes a cada ≤ 500 ms (último estado de cada veículo)

: ping                             ← a cada 15 s (mantém proxies abertos)
```

`VehicleUpdate`:
```json
{ "vehicleId": "GO-68511", "routeId": "1:L101", "tripId": "1:L101-0-SAB-111500", "shapeId": "1:L101-0",
  "lon": -49.237891, "lat": -16.675646, "bearing": 79, "distanceAlong": 9612, "speedMps": 6.11,
  "timestamp": 1791643855, "source": "realtime" }
```
`lon`/`lat` já vêm **projetados na via**. Para animar, o cliente usa `shapeId` + `distanceAlong` + `speedMps`.

### `GET /realtime/vehicles?routes=…`
Mesmo conteúdo do `snapshot`, para clientes em *polling* (fallback).

## Rotas salvas 🔒

| Método | Rota | Corpo / descrição |
|---|---|---|
| GET | `/categories` | Lista com `routeCount` |
| POST | `/categories` | `{ name, color?, icon? }` (máx. 30 por conta) |
| PATCH | `/categories/:id` | `{ name?, color?, icon?, position? }` |
| DELETE | `/categories/:id` | As rotas ficam "sem categoria" |
| GET | `/saved-routes?categoryId=<uuid\|none>` | Lista com os pontos |
| POST | `/saved-routes` | `{ name, categoryId?, preferredRouteIds[], points[] }`. `points` começa em `origin` e termina em `destination` (2 a 12 pontos, todos em Goiás) |
| GET | `/saved-routes/:id` | Uma rota |
| PATCH | `/saved-routes/:id` | `{ name?, categoryId? \| null, preferredRouteIds? }` |
| PATCH | `/saved-routes/:id/points/:pointId` | `{ customName: "Casa" \| null }` |
| DELETE | `/saved-routes/:id` | — |

Ponto:
```json
{ "id": "uuid", "seq": 0, "kind": "origin", "stopId": null, "lon": -49.29, "lat": -16.67,
  "originalName": "Rua 10, Campinas", "customName": "Casa", "displayName": "Casa" }
```

## Compartilhamento

| Método | Rota | Descrição |
|---|---|---|
| POST 🔒 | `/saved-routes/:id/shares` | `{ expiresInDays? }` → `{ id, url, token, expiresAt }` |
| GET 🔒 | `/saved-routes/:id/shares` | Links com `viewCount` e `active` |
| DELETE 🔒 | `/shares/:shareId` | Revoga |
| GET | `/shared/:token` | Público: `{ sharedBy: "Maria", route: { name, points } }` |
| POST 🔒 | `/shared/:token/copy` | Copia para a conta de quem está logado |

## Operação

| Rota | Uso |
|---|---|
| `GET /health` | *Liveness* (o processo responde) |
| `GET /ready` | *Readiness*: `{ postgres, redis }`. Retorna 503 se o PostgreSQL estiver fora |
