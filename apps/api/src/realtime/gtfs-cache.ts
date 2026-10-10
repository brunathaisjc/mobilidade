/**
 * Cópia em memória dos dados GTFS necessários a cada leitura de GPS (viagens, shapes, padrões).
 * Consultar o banco a cada ping de GPS (~1.500/s no estado) seria o gargalo; aqui é O(1).
 * Recarregada quando a versão do feed muda (gtfs_feeds.loaded_at).
 */
import { MeasuredLine, type LngLat } from '@mobigo/shared';
import type { Db } from '../lib/db.js';
import type { TrackerData, TripInfo } from './tracker.js';

export interface PatternStop { seq: number; stopId: string; dist: number; offset: number }
export interface PatternInfo { patternId: string; routeId: string; shapeId: string; headsign: string; stops: PatternStop[] }
export interface CachedTrip extends TripInfo { patternId: string; serviceId: string; startS: number; endS: number }

export class FeedCache implements TrackerData {
  readonly trips = new Map<string, CachedTrip>();
  readonly shapes = new Map<string, MeasuredLine>();
  readonly patterns = new Map<string, PatternInfo>();
  private readonly shapesByRoute = new Map<string, string[]>();
  loadedAt: Date | null = null;

  constructor(readonly feedId: number) {}

  trip(tripId: string) { return this.trips.get(tripId); }
  shape(shapeId: string) { return this.shapes.get(shapeId); }
  routeShapes(routeId: string) { return this.shapesByRoute.get(routeId) ?? []; }

  async load(db: Db) {
    const [{ rows: [feed] }, shapes, patterns, stops, trips] = await Promise.all([
      db.query('SELECT loaded_at FROM gtfs_feeds WHERE feed_id = $1', [this.feedId]),
      db.query<{ shape_id: string; coords: LngLat[] }>(
        `SELECT shape_id, (ST_AsGeoJSON(geom, 6)::json -> 'coordinates') AS coords FROM gtfs_shapes WHERE feed_id = $1`, [this.feedId]),
      db.query('SELECT pattern_id, route_id, shape_id, headsign FROM gtfs_patterns WHERE feed_id = $1', [this.feedId]),
      db.query('SELECT pattern_id, seq, stop_id, dist_m, offset_s FROM gtfs_pattern_stops WHERE feed_id = $1 ORDER BY pattern_id, seq', [this.feedId]),
      db.query('SELECT trip_id, route_id, shape_id, pattern_id, service_id, start_s, end_s FROM gtfs_trips WHERE feed_id = $1', [this.feedId]),
    ]);
    this.shapes.clear(); this.patterns.clear(); this.trips.clear(); this.shapesByRoute.clear();
    for (const s of shapes.rows) this.shapes.set(s.shape_id, new MeasuredLine(s.coords));
    for (const p of patterns.rows) {
      this.patterns.set(p.pattern_id, { patternId: p.pattern_id, routeId: p.route_id, shapeId: p.shape_id, headsign: p.headsign, stops: [] });
      const list = this.shapesByRoute.get(p.route_id) ?? [];
      if (!list.includes(p.shape_id)) list.push(p.shape_id);
      this.shapesByRoute.set(p.route_id, list);
    }
    for (const s of stops.rows) {
      this.patterns.get(s.pattern_id)?.stops.push({ seq: s.seq, stopId: s.stop_id, dist: s.dist_m, offset: s.offset_s });
    }
    for (const t of trips.rows) {
      this.trips.set(t.trip_id, {
        routeId: t.route_id, shapeId: t.shape_id, patternId: t.pattern_id, serviceId: t.service_id, startS: t.start_s, endS: t.end_s,
      });
    }
    this.loadedAt = feed?.loaded_at ?? null;
    return this;
  }

  /** Recarrega se o feed foi atualizado desde a última carga. */
  async refreshIfChanged(db: Db): Promise<boolean> {
    const { rows: [feed] } = await db.query('SELECT loaded_at FROM gtfs_feeds WHERE feed_id = $1', [this.feedId]);
    if (feed?.loaded_at?.getTime() === this.loadedAt?.getTime()) return false;
    await this.load(db);
    return true;
  }
}

/** Caches por feed, carregados sob demanda e verificados periodicamente (processo da API). */
export class FeedRegistry {
  private readonly feeds = new Map<number, Promise<FeedCache>>();
  private lastCheck = 0;

  constructor(private readonly db: Db, private readonly checkEveryMs = 60_000) {}

  async get(feedId: number): Promise<FeedCache> {
    let entry = this.feeds.get(feedId);
    if (!entry) {
      entry = new FeedCache(feedId).load(this.db);
      entry.catch(() => this.feeds.delete(feedId));
      this.feeds.set(feedId, entry);
    }
    const cache = await entry;
    if (Date.now() - this.lastCheck > this.checkEveryMs) {
      this.lastCheck = Date.now();
      await Promise.all([...this.feeds.values()].map(async (p) => (await p).refreshIfChanged(this.db)));
    }
    return cache;
  }
}
