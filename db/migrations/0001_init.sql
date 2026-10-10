-- Mobi GO — esquema inicial
-- Convenções: snake_case, timestamps em timestamptz (UTC), geografia em SRID 4326.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() não é IMMUTABLE; este wrapper permite usá-lo em índices de busca por nome.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ============================================================================
-- Contas de usuário
-- ============================================================================
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  -- Código IBGE do município (7 dígitos). Opcional: só para estatística agregada de demanda.
  municipality_ibge char(7) CHECK (municipality_ibge ~ '^52[0-9]{5}$'),
  avatar_key        text,
  terms_version     text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Refresh tokens opacos com rotação; guardamos apenas o hash SHA-256.
-- family_id permite revogar toda a cadeia se um token antigo for reutilizado (detecção de roubo).
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- ============================================================================
-- Rotas salvas, categorias, pontos nomeados e compartilhamento
-- ============================================================================
CREATE TABLE route_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  color      text NOT NULL DEFAULT '#1f6feb' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  icon       text NOT NULL DEFAULT 'bookmark' CHECK (char_length(icon) <= 30),
  position   smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX route_categories_user_name_uq ON route_categories (user_id, lower(name));

CREATE TABLE saved_routes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id        uuid REFERENCES route_categories(id) ON DELETE SET NULL,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Linhas preferidas no momento em que a rota foi salva (ex.: {"1:L101","1:L102"}).
  preferred_route_ids text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_routes_user_idx ON saved_routes (user_id, category_id);
CREATE TRIGGER saved_routes_touch BEFORE UPDATE ON saved_routes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Pontos da rota (origem, embarque, desembarque, destino...) com nome personalizado pelo usuário.
CREATE TABLE saved_route_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_route_id uuid NOT NULL REFERENCES saved_routes(id) ON DELETE CASCADE,
  seq            smallint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('origin', 'board', 'alight', 'waypoint', 'destination')),
  stop_id        text,
  geom           geography(Point, 4326) NOT NULL,
  original_name  text NOT NULL,
  custom_name    text CHECK (char_length(custom_name) BETWEEN 1 AND 60),
  UNIQUE (saved_route_id, seq)
);

CREATE TABLE route_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_route_id uuid NOT NULL REFERENCES saved_routes(id) ON DELETE CASCADE,
  -- 128 bits aleatórios em base64url: não enumerável.
  token          text NOT NULL UNIQUE CHECK (char_length(token) >= 22),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  view_count     integer NOT NULL DEFAULT 0
);
CREATE INDEX route_shares_route_idx ON route_shares (saved_route_id);

-- ============================================================================
-- GTFS estático (multi-feed: um feed por sistema/município — RMTC, Anápolis, Rio Verde...)
-- ============================================================================
CREATE TABLE gtfs_feeds (
  feed_id                  serial PRIMARY KEY,
  slug                     text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name                     text NOT NULL,
  municipality_ibge        char(7),
  timezone                 text NOT NULL DEFAULT 'America/Sao_Paulo',
  rt_vehicle_positions_url text,
  rt_trip_updates_url      text,
  active                   boolean NOT NULL DEFAULT true,
  version                  text,
  loaded_at                timestamptz
);

CREATE TABLE gtfs_agency (
  feed_id     int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  agency_id   text NOT NULL,
  agency_name text NOT NULL,
  agency_url  text,
  PRIMARY KEY (feed_id, agency_id)
);

CREATE TABLE gtfs_routes (
  feed_id          int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  route_id         text NOT NULL,
  agency_id        text,
  route_short_name text NOT NULL DEFAULT '',
  route_long_name  text NOT NULL DEFAULT '',
  route_type       smallint NOT NULL,
  route_color      text,
  route_text_color text,
  PRIMARY KEY (feed_id, route_id)
);

CREATE TABLE gtfs_stops (
  feed_id   int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  stop_id   text NOT NULL,
  stop_code text,
  stop_name text NOT NULL,
  geom      geography(Point, 4326) NOT NULL,
  wheelchair_boarding smallint,
  PRIMARY KEY (feed_id, stop_id)
);
CREATE INDEX gtfs_stops_geom_gist ON gtfs_stops USING gist (geom);
CREATE INDEX gtfs_stops_name_trgm ON gtfs_stops USING gin (immutable_unaccent(lower(stop_name)) gin_trgm_ops);

CREATE TABLE gtfs_shapes (
  feed_id  int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  shape_id text NOT NULL,
  geom     geometry(LineString, 4326) NOT NULL,
  length_m double precision NOT NULL,
  PRIMARY KEY (feed_id, shape_id)
);

CREATE TABLE gtfs_calendar (
  feed_id    int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  service_id text NOT NULL,
  monday boolean NOT NULL, tuesday boolean NOT NULL, wednesday boolean NOT NULL,
  thursday boolean NOT NULL, friday boolean NOT NULL, saturday boolean NOT NULL, sunday boolean NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  PRIMARY KEY (feed_id, service_id)
);

CREATE TABLE gtfs_calendar_dates (
  feed_id        int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  service_id     text NOT NULL,
  date           date NOT NULL,
  exception_type smallint NOT NULL CHECK (exception_type IN (1, 2)),
  PRIMARY KEY (feed_id, service_id, date)
);

-- Padrão de parada = sequência única de pontos de um shape/sentido. Muitas viagens compartilham o mesmo
-- padrão; o planejador busca combinações embarque→desembarque nos padrões (milhares de linhas),
-- não em stop_times (milhões), e só depois expande para as viagens concretas.
CREATE TABLE gtfs_patterns (
  feed_id      int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  pattern_id   text NOT NULL,
  route_id     text NOT NULL,
  direction_id smallint,
  shape_id     text NOT NULL,
  headsign     text NOT NULL DEFAULT '',
  PRIMARY KEY (feed_id, pattern_id),
  FOREIGN KEY (feed_id, route_id) REFERENCES gtfs_routes (feed_id, route_id) ON DELETE CASCADE,
  FOREIGN KEY (feed_id, shape_id) REFERENCES gtfs_shapes (feed_id, shape_id) ON DELETE CASCADE
);

CREATE TABLE gtfs_pattern_stops (
  feed_id     int  NOT NULL,
  pattern_id  text NOT NULL,
  seq         smallint NOT NULL,
  stop_id     text NOT NULL,
  -- Distância do ponto ao longo do shape (m) e tempo programado desde o início da viagem (s).
  dist_m      double precision NOT NULL,
  offset_s    integer NOT NULL,
  PRIMARY KEY (feed_id, pattern_id, seq),
  FOREIGN KEY (feed_id, pattern_id) REFERENCES gtfs_patterns (feed_id, pattern_id) ON DELETE CASCADE
);
CREATE INDEX gtfs_pattern_stops_stop_idx ON gtfs_pattern_stops (feed_id, stop_id);

CREATE TABLE gtfs_trips (
  feed_id      int  NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  trip_id      text NOT NULL,
  route_id     text NOT NULL,
  service_id   text NOT NULL,
  pattern_id   text NOT NULL,
  shape_id     text NOT NULL,
  headsign     text NOT NULL DEFAULT '',
  direction_id smallint,
  -- Horário de partida no primeiro ponto (s desde o início do dia de serviço; pode passar de 86400).
  start_s      integer NOT NULL,
  end_s        integer NOT NULL,
  PRIMARY KEY (feed_id, trip_id)
);
CREATE INDEX gtfs_trips_pattern_idx ON gtfs_trips (feed_id, pattern_id, start_s);
CREATE INDEX gtfs_trips_active_idx ON gtfs_trips (feed_id, start_s, end_s);

-- stop_times completo é mantido para auditoria e exportação; o planejador usa pattern_stops + start_s,
-- válido porque viagens de um mesmo padrão compartilham os mesmos offsets (verificado no loader).
CREATE TABLE gtfs_stop_times (
  feed_id        int  NOT NULL,
  trip_id        text NOT NULL,
  stop_sequence  integer NOT NULL,
  stop_id        text NOT NULL,
  arrival_s      integer NOT NULL,
  departure_s    integer NOT NULL,
  PRIMARY KEY (feed_id, trip_id, stop_sequence),
  FOREIGN KEY (feed_id, trip_id) REFERENCES gtfs_trips (feed_id, trip_id) ON DELETE CASCADE
);

-- ============================================================================
-- Histórico de posições (telemetria). O estado "quente" vive no Redis.
-- ============================================================================
CREATE TABLE vehicle_positions (
  ts             timestamptz NOT NULL,
  feed_id        int  NOT NULL,
  vehicle_id     text NOT NULL,
  trip_id        text,
  route_id       text,
  geom           geometry(Point, 4326) NOT NULL,
  distance_along double precision,
  speed_mps      real,
  bearing        smallint,
  gps_offset_m   real
);
CREATE INDEX vehicle_positions_vehicle_ts_idx ON vehicle_positions (feed_id, vehicle_id, ts DESC);

-- Com TimescaleDB disponível (imagem timescale/timescaledb-ha), vira hypertable com compressão e retenção.
-- Sem ele (ex.: RDS/Cloud SQL), a tabela segue como está; use pg_partman — ver docs/adr/0002.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      PERFORM create_hypertable('vehicle_positions', 'ts', chunk_time_interval => interval '1 day');
      EXECUTE 'ALTER TABLE vehicle_positions SET (timescaledb.compress, timescaledb.compress_segmentby = ''feed_id, vehicle_id'')';
      PERFORM add_compression_policy('vehicle_positions', interval '3 days');
      PERFORM add_retention_policy('vehicle_positions', interval '180 days');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB indisponível (%), mantendo tabela comum', SQLERRM;
    END;
  END IF;
END $$;
