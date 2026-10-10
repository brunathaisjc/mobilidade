/**
 * Worker de ingestão em tempo real.
 *
 * Para cada feed ativo com URL GTFS-RT: lê as posições, limpa com o VehicleTracker, grava o estado no
 * Redis (que notifica os gateways SSE) e persiste o histórico em lote no PostgreSQL.
 *
 * Alta disponibilidade: rode 2+ réplicas. Um lock no Redis (SET NX PX) garante um único líder por feed;
 * se o líder morrer, outra réplica assume em até LOCK_TTL_MS.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { VehicleUpdate } from '@mobigo/shared';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../lib/db.js';
import { FeedCache } from '../realtime/gtfs-cache.js';
import { GtfsRtSource, type PositionSource } from '../realtime/gtfs-rt.js';
import { RealtimeStore } from '../realtime/store.js';
import { VehicleTracker } from '../realtime/tracker.js';
import { parseRef } from '../lib/ids.js';

const LOCK_TTL_MS = 15_000;
const HISTORY_FLUSH_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

const RENEW_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FeedIngestor {
  private history: VehicleUpdate[] = [];
  private lastFlush = Date.now();
  private lastFeedTimestamp: number | null = null;
  private failures = 0;
  private stats = { cycles: 0, published: 0 };

  constructor(
    private readonly feedId: number,
    private readonly source: PositionSource,
    private readonly cache: FeedCache,
    private readonly tracker: VehicleTracker,
    private readonly store: RealtimeStore,
    private readonly db: Db,
  ) {}

  /** Executa um ciclo; devolve o atraso até o próximo. */
  async cycle(pollMs: number): Promise<number> {
    try {
      const { feedTimestamp, positions } = await this.source.fetch();
      this.failures = 0;
      if (feedTimestamp !== null && feedTimestamp === this.lastFeedTimestamp) return pollMs; // feed não mudou
      this.lastFeedTimestamp = feedTimestamp;
      const updates = positions.map((p) => this.tracker.process(p)).filter((u): u is VehicleUpdate => u !== null);
      await this.store.saveVehicles(updates);
      this.history.push(...updates);
      this.stats.cycles++;
      this.stats.published += updates.length;
      if (Date.now() - this.lastFlush >= HISTORY_FLUSH_MS) await this.flushHistory();
      return pollMs;
    } catch (err) {
      this.failures++;
      const backoff = Math.min(MAX_BACKOFF_MS, pollMs * 2 ** this.failures);
      console.warn(`[feed ${this.feedId}] falha na leitura (${this.failures}x), nova tentativa em ${backoff} ms:`, (err as Error).message);
      return backoff;
    }
  }

  async flushHistory() {
    const batch = this.history;
    this.history = [];
    this.lastFlush = Date.now();
    if (!batch.length) return;
    await this.db.query(
      `INSERT INTO vehicle_positions (ts, feed_id, vehicle_id, trip_id, route_id, geom, distance_along, speed_mps, bearing)
       SELECT to_timestamp(t.ts), $1, t.vehicle_id, t.trip_id, t.route_id, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326), t.dist, t.speed, t.bearing
       FROM unnest($2::float8[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::float8[], $8::float8[], $9::real[], $10::int2[])
         AS t(ts, vehicle_id, trip_id, route_id, lon, lat, dist, speed, bearing)`,
      [this.feedId, batch.map((u) => u.timestamp), batch.map((u) => u.vehicleId),
        batch.map((u) => parseRef(u.tripId)?.id ?? null), batch.map((u) => parseRef(u.routeId)?.id ?? null),
        batch.map((u) => u.lon), batch.map((u) => u.lat), batch.map((u) => u.distanceAlong),
        batch.map((u) => u.speedMps), batch.map((u) => u.bearing)],
    ).catch((err) => console.error(`[feed ${this.feedId}] falha ao gravar histórico:`, err.message));
  }

  logStats() {
    console.log(`[feed ${this.feedId}] ciclos=${this.stats.cycles} publicados=${this.stats.published} rejeitados=${JSON.stringify(this.tracker.rejected)}`);
    this.stats = { cycles: 0, published: 0 };
  }

  async maintenance() {
    if (await this.cache.refreshIfChanged(this.db)) console.log(`[feed ${this.feedId}] GTFS recarregado`);
    this.tracker.prune(Math.floor(Date.now() / 1000));
  }
}

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, 4);
  const redis = new Redis(cfg.REDIS_URL);
  const store = new RealtimeStore(redis);
  const instanceId = randomUUID();
  let running = true;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { running = false; });

  const { rows: feeds } = await db.query(
    `SELECT feed_id, slug, rt_vehicle_positions_url FROM gtfs_feeds WHERE active AND rt_vehicle_positions_url IS NOT NULL`);
  if (!feeds.length) console.warn('nenhum feed ativo com rt_vehicle_positions_url configurada');

  await Promise.all(feeds.map(async (f) => {
    const cache = await new FeedCache(f.feed_id).load(db);
    const ingestor = new FeedIngestor(f.feed_id, new GtfsRtSource(f.slug, f.rt_vehicle_positions_url), cache,
      new VehicleTracker(cache), store, db);
    const lockKey = `lock:ingestor:${f.feed_id}`;
    let lastMaintenance = Date.now();
    console.log(`[feed ${f.feed_id}] ${f.slug}: ${cache.trips.size} viagens, ${cache.shapes.size} shapes em cache`);
    while (running) {
      // Adquire ou renova a liderança deste feed (renovação atômica: só o dono estende o prazo).
      const leader = (await redis.set(lockKey, instanceId, 'PX', LOCK_TTL_MS, 'NX')) === 'OK'
        || (await redis.eval(RENEW_LOCK, 1, lockKey, instanceId, LOCK_TTL_MS)) === 1;
      if (!leader) { await sleep(LOCK_TTL_MS / 3); continue; }
      const delay = await ingestor.cycle(cfg.REALTIME_POLL_MS);
      if (Date.now() - lastMaintenance > 60_000) {
        lastMaintenance = Date.now();
        ingestor.logStats();
        await ingestor.maintenance().catch((e) => console.error(e));
      }
      await sleep(delay);
    }
    await ingestor.flushHistory();
    await redis.eval(RELEASE_LOCK, 1, lockKey, instanceId);
  }));
  await db.end();
  redis.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
