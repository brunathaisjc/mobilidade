# 10 — Guia do ambiente local (passo a passo)

Para quem vai rodar o projeto na própria máquina **sem Docker** e quer entender cada peça.
Ponto de partida: **Node.js** e **PostgreSQL** já instalados. Vamos instalar e configurar **pnpm**, **PostGIS** e **Redis**.

| Peça | Para que serve no Mobi GO | Obrigatória? |
|---|---|---|
| Node.js (≥ 22) | Roda a API, os workers e as ferramentas do front-end | Sim |
| pnpm 10 | Gerenciador de pacotes do monorepo (`apps/*`, `packages/*`) | Sim |
| PostgreSQL | Banco principal: contas, rotas salvas, GTFS | Sim |
| PostGIS | Extensão geográfica do PostgreSQL ("pontos a 600 m daqui", distância ao longo da linha) | Sim |
| Redis | Memória rápida: posição atual dos ônibus, distribuição em tempo real, *rate limit* | Sim (sem ele não há ônibus ao vivo) |
| TimescaleDB | Compressão do histórico de GPS | **Não.** A migração detecta a ausência e segue sem ele |

> **Sobre o Node 25:** o projeto exige Node ≥ 22, então o 25 é aceito. Ele é uma versão *Current* (não LTS). Para aprender, serve. Para produção, prefira a LTS mais recente. As dependências nativas (`sharp`, `@node-rs/argon2`) usam binários pré-compilados via Node-API, compatíveis entre versões. O projeto foi testado no Node 22. Se algo falhar no 25, a primeira hipótese é a versão.

---

## 1. pnpm

A partir do Node 25, o `corepack` não vem mais junto com o Node. Instale o pnpm pelo npm:

```bash
npm install -g pnpm@10
pnpm --version          # deve mostrar 10.x
```

No Windows, se o PowerShell bloquear scripts, rode uma vez:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## 2. PostGIS para PostgreSQL 18

Instale a versão do PostGIS **compilada para a sua versão do PostgreSQL** (18): PostGIS 3.6 ou mais recente.

**Windows** (instalador EDB do PostgreSQL)
1. Abra o **Application Stack Builder**, que vem com o PostgreSQL.
2. Escolha o seu servidor PostgreSQL 18.
3. Em **Spatial Extensions**, marque **PostGIS 3.x Bundle for PostgreSQL 18** e conclua o assistente.

**Ubuntu / Debian** (repositório oficial PGDG, o mesmo de onde vem o PostgreSQL 18)
```bash
sudo apt install postgresql-18-postgis-3
```

**macOS**
- **Postgres.app**: o PostGIS já vem incluído.
- **Homebrew**: `brew install postgis`. Confira se ele é compatível com o PostgreSQL que você usa (`brew info postgis`).

### Criar usuário, bancos e extensões

Entre no `psql` como superusuário (`postgres`):

```bash
psql -U postgres        # Linux: sudo -u postgres psql
```

```sql
-- Usuário da aplicação: SEM superusuário (princípio do menor privilégio)
CREATE ROLE mobi LOGIN PASSWORD 'mobi' CREATEDB;
CREATE DATABASE mobilidade OWNER mobi;
CREATE DATABASE mobilidade_test OWNER mobi;   -- usado pelos testes automatizados

-- Extensões precisam de superusuário: crie-as em CADA banco
\c mobilidade
CREATE EXTENSION postgis;
CREATE EXTENSION citext;     -- e-mail sem diferenciar maiúsculas
CREATE EXTENSION pg_trgm;    -- busca aproximada por nome de ponto
CREATE EXTENSION unaccent;   -- busca ignorando acentos ("praca" acha "Praça")
SELECT postgis_full_version();

\c mobilidade_test
CREATE EXTENSION postgis;
CREATE EXTENSION citext;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION unaccent;
\q
```

`citext`, `pg_trgm` e `unaccent` vêm no pacote padrão do PostgreSQL (*contrib*). Só o PostGIS é instalado à parte.

**Para praticar PostGIS** depois de carregar os dados (seção 5):

```sql
-- Pontos de ônibus a até 500 m da Praça Cívica, do mais próximo ao mais distante
SELECT stop_name, round(ST_Distance(geom, ST_MakePoint(-49.2643, -16.6866)::geography)) AS metros
FROM gtfs_stops
WHERE ST_DWithin(geom, ST_MakePoint(-49.2643, -16.6866)::geography, 500)
ORDER BY geom <-> ST_MakePoint(-49.2643, -16.6866)::geography;

-- Comprimento de cada traçado de linha, em km
SELECT shape_id, round(length_m / 1000, 1) AS km FROM gtfs_shapes;
```

Atenção: no PostGIS a ordem é **(longitude, latitude)**, ao contrário do Google Maps, que mostra latitude primeiro.

---

## 3. Redis

### Instalar

**Windows**: o Redis não tem versão oficial nativa para Windows. Opções:
1. **WSL2 (recomendado)**: no PowerShell como administrador, rode `wsl --install` e reinicie. No terminal do Ubuntu:
   ```bash
   sudo apt update && sudo apt install redis-server
   sudo service redis-server start
   ```
   O Windows acessa o Redis do WSL em `localhost:6379`.
2. **Memurai** (Developer Edition): é compatível com Redis e roda nativo no Windows.

**Ubuntu / Debian**
```bash
sudo apt install redis-server
sudo systemctl enable --now redis-server
```

**macOS**
```bash
brew install redis
brew services start redis
```

Teste:
```bash
redis-cli ping          # resposta: PONG
```

### Primeiros passos com o Redis (5 minutos)

O Redis é um **banco em memória de chave → valor**, muito rápido, e é usado para dados "quentes" que mudam o tempo todo. Abra `redis-cli` e experimente:

```text
SET saudacao "olá"            → guarda um texto
GET saudacao                  → "olá"
SET temporario "x" EX 10      → expira sozinho em 10 s
TTL temporario                → segundos restantes
INCR contador                 → 1, 2, 3… (contadores atômicos; é assim que funciona o rate limit)

ZADD ranking 100 ana 80 joao  → conjunto ordenado por pontuação
ZRANGE ranking 0 -1 WITHSCORES

GEOADD lugares -49.2643 -16.6866 "praca-civica"
GEOADD lugares -49.2585 -16.6625 "rodoviaria"
GEODIST lugares praca-civica rodoviaria km
```

**Publicar e assinar (pub/sub)**: abra dois terminais.
```text
# terminal 1
SUBSCRIBE avisos
# terminal 2
PUBLISH avisos "ônibus chegando"
```
O terminal 1 recebe a mensagem na hora. É assim que a API sabe que um ônibus se moveu e avisa os navegadores.

### Como o Mobi GO usa o Redis

Com o projeto rodando (seção 5), observe ao vivo:

```bash
redis-cli --scan --pattern "rt:*"          # chaves de tempo real
redis-cli ZRANGE rt:route:1:L101 0 -1      # ônibus da linha 101 agora
redis-cli GET rt:v:1:<id-do-onibus>        # última posição limpa (JSON)
redis-cli PSUBSCRIBE "rt:ch:*"             # assiste às posições chegando em tempo real
```

| Chave | Tipo | O que guarda |
|---|---|---|
| `rt:v:{feed}:{veículo}` | texto JSON, expira em 5 min | Última posição limpa do ônibus |
| `rt:route:{feed}:{linha}` | conjunto ordenado | Ônibus de cada linha |
| `rt:geo:{feed}` | geográfico | Posições para busca por área |
| canal `rt:ch:{feed}:{linha}` | pub/sub | Cada atualização, entregue às APIs |
| `lock:ingestor:{feed}` | texto, expira em 15 s | Qual instância do ingestor é a líder |

Os dados do Redis são **descartáveis**: se você rodar `FLUSHALL` (apaga tudo), em 5 segundos o ingestor recria tudo. Experimente.

---

## 4. Instalar o projeto

```bash
cd mobigo
pnpm install
pnpm --filter @mobigo/shared build
```

Os valores padrão já apontam para `postgres://mobi:mobi@localhost:5432/mobilidade` e `redis://localhost:6379`. Se você usou outro usuário, senha ou porta, defina a variável **antes** dos comandos:

```bash
# Linux/macOS
export DATABASE_URL=postgres://usuario:senha@localhost:5432/mobilidade
# Windows PowerShell
$env:DATABASE_URL = "postgres://usuario:senha@localhost:5432/mobilidade"
```

---

## 5. Criar as tabelas e carregar os dados de exemplo

```bash
pnpm db:migrate
pnpm --filter @mobigo/api exec tsx src/scripts/generate-sample-gtfs.ts
pnpm gtfs:load -- --vehicle-positions-url http://localhost:8090/gtfs-rt/vehicle-positions
```

Saída esperada: `feed "rmtc-goiania-amostra" carregado: {"feedId":1,…,"trips":1468}`.

---

## 6. Rodar (4 terminais)

| Terminal | Comando | O que faz |
|---|---|---|
| 1 | `pnpm dev:simulator` | Finge ser o GPS dos ônibus (feed GTFS-RT em `localhost:8090`) |
| 2 | `pnpm --filter @mobigo/api ingestor` | Lê o feed, limpa o GPS e grava no Redis |
| 3 | `pnpm dev:api` | API em `http://localhost:3000` |
| 4 | `pnpm dev:web` | App em **http://localhost:5173** |

Abra o app, digite **Praça A** na origem e **Bíblia** no destino.

> Os ônibus só circulam no horário da tabela (5h às 23h30). De madrugada, rode o simulador adiantando o relógio: `pnpm dev:simulator -- --time-offset-h=-8`

Verificações rápidas:
```bash
curl http://localhost:3000/api/ready     # {"postgres":true,"redis":true}
```

---

## 7. Rodar os testes

```bash
pnpm typecheck
pnpm test        # 63 testes; os de integração usam o banco mobilidade_test e o Redis (db 15)
```

---

## 8. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `permission denied to create extension "postgis"` | Extensão criada com o usuário `mobi` | Crie as extensões como `postgres` (seção 2) |
| `extension "postgis" is not available` | PostGIS não instalado para o PostgreSQL 18 | Seção 2. Confira com `SELECT * FROM pg_available_extensions WHERE name='postgis';` |
| `ECONNREFUSED 127.0.0.1:6379` | Redis parado | `redis-cli ping`; inicie o serviço (seção 3) |
| `password authentication failed for user "mobi"` | Senha diferente | Ajuste `DATABASE_URL` (seção 4) |
| App abre, mas nenhum ônibus aparece | Simulador ou ingestor parado, ou fora do horário | Terminais 1 e 2; `--time-offset-h` |
| Mapa cinza, sem ruas | Sem acesso ao servidor de mapas | Rotas e ônibus continuam aparecendo (estilo de contingência). Verifique a internet ou o firewall |
| Erro ao instalar `sharp` ou `argon2` | Binário nativo indisponível para a sua versão do Node | Teste com Node 22 ou 24 LTS (use o `nvm`/`nvm-windows` para ter as duas versões) |
