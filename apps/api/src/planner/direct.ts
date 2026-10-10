/**
 * Planejador interno de LINHAS DIRETAS sobre o GTFS no PostGIS.
 *
 * Responde "quais linhas me levam de A até B sem baldeação", listando TODAS as linhas/sentidos que
 * passam perto da origem e depois perto do destino, cada uma com os próximos ônibus em tempo real.
 * É o modo principal do MVP (ver ADR 0004) e o fallback quando o OpenTripPlanner está indisponível.
 */
import { encodePolyline, haversine, type Itinerary, type PlanRequest, type PlanResponse, type TransitLeg } from '@mobigo/shared';
import type { Db } from '../lib/db.js';
import { ref } from '../lib/ids.js';
import type { FeedRegistry } from '../realtime/gtfs-cache.js';
import { computeArrivals, type ArrivalDeps } from './arrivals.js';
import { WALK_DETOUR, WALK_SPEED_MPS, rankItineraries, walkLeg } from './itinerary.js';
import type { ServiceCalendar } from './services.js';
import type { Planner } from './index.js';

export interface PlannerDeps extends ArrivalDeps {
  db: Db;
  feeds: FeedRegistry;
  calendar: ServiceCalendar;
  maxWalkMeters: number;
}

interface Candidate {
  feed_id: number;
  pattern_id: string;
  route_id: string;
  short_name: string;
  long_name: string;
  headsign: string;
  board_seq: number;
  board_stop: string;
  board_name: string;
  board_lon: number;
  board_lat: number;
  alight_seq: number;
  alight_stop: string;
  alight_name: string;
  alight_lon: number;
  alight_lat: number;
}

export class DirectPlanner implements Planner {
  constructor(private readonly deps: PlannerDeps) {}

  get feeds() { return this.deps.feeds; }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const now = req.departAt ? new Date(req.departAt) : new Date();
    const radius = Math.min(req.maxWalkMeters ?? this.deps.maxWalkMeters, 2000) / WALK_DETOUR;

    // Melhor par embarque→desembarque por padrão, minimizando caminhada + tempo a bordo.
    const { rows } = await this.deps.db.query<Candidate>(
      `WITH o AS (
         SELECT s.feed_id, s.stop_id, s.stop_name, s.geom, ST_Distance(s.geom, ST_MakePoint($1, $2)::geography) AS d
         FROM gtfs_stops s JOIN gtfs_feeds f ON f.feed_id = s.feed_id AND f.active
         WHERE ST_DWithin(s.geom, ST_MakePoint($1, $2)::geography, $5)
       ), d AS (
         SELECT s.feed_id, s.stop_id, s.stop_name, s.geom, ST_Distance(s.geom, ST_MakePoint($3, $4)::geography) AS d
         FROM gtfs_stops s JOIN gtfs_feeds f ON f.feed_id = s.feed_id AND f.active
         WHERE ST_DWithin(s.geom, ST_MakePoint($3, $4)::geography, $5)
       )
       SELECT DISTINCT ON (b.feed_id, b.pattern_id)
         b.feed_id, b.pattern_id, p.route_id, r.route_short_name AS short_name, r.route_long_name AS long_name, p.headsign,
         b.seq AS board_seq, b.stop_id AS board_stop, o.stop_name AS board_name,
         ST_X(o.geom::geometry) AS board_lon, ST_Y(o.geom::geometry) AS board_lat,
         a.seq AS alight_seq, a.stop_id AS alight_stop, d.stop_name AS alight_name,
         ST_X(d.geom::geometry) AS alight_lon, ST_Y(d.geom::geometry) AS alight_lat
       FROM o
       JOIN gtfs_pattern_stops b ON b.feed_id = o.feed_id AND b.stop_id = o.stop_id
       JOIN gtfs_pattern_stops a ON a.feed_id = b.feed_id AND a.pattern_id = b.pattern_id AND a.seq > b.seq
       JOIN d ON d.feed_id = a.feed_id AND d.stop_id = a.stop_id
       JOIN gtfs_patterns p ON p.feed_id = b.feed_id AND p.pattern_id = b.pattern_id
       JOIN gtfs_routes r ON r.feed_id = p.feed_id AND r.route_id = p.route_id
       ORDER BY b.feed_id, b.pattern_id, (o.d + d.d) * $6 / $7 + (a.offset_s - b.offset_s)
       LIMIT 60`,
      [req.from.lon, req.from.lat, req.to.lon, req.to.lat, radius, WALK_DETOUR, WALK_SPEED_MPS],
    );

    const built = await Promise.all(rows.map((c) => this.buildItinerary(c, req, now)));
    const itineraries: Omit<Itinerary, 'color' | 'dashed'>[] = built.filter((i): i is NonNullable<typeof i> => i !== null);

    // Trajeto curto: caminhar também é uma opção legítima (e às vezes a mais rápida).
    const direct = haversine([req.from.lon, req.from.lat], [req.to.lon, req.to.lat]) * WALK_DETOUR;
    if (direct <= (req.maxWalkMeters ?? this.deps.maxWalkMeters) * 1.5) {
      const leg = walkLeg(req.from, req.to);
      itineraries.push({
        id: 'walk', legs: [leg], lines: [], totalDistanceMeters: leg.distanceMeters, walkDistanceMeters: leg.distanceMeters,
        waitSeconds: 0, durationSeconds: leg.durationSeconds, departureTime: now.toISOString(),
        arrivalTime: new Date(now.getTime() + leg.durationSeconds * 1000).toISOString(), realtime: false,
      });
    }

    return { itineraries: rankItineraries(itineraries), generatedAt: new Date().toISOString(), engine: 'gtfs-direct' };
  }

  private async buildItinerary(c: Candidate, req: PlanRequest, now: Date): Promise<Omit<Itinerary, 'color' | 'dashed'> | null> {
    const cache = await this.deps.feeds.get(c.feed_id);
    const pattern = cache.patterns.get(c.pattern_id);
    const line = pattern && cache.shape(pattern.shapeId);
    if (!pattern || !line) return null;
    const boardIndex = pattern.stops.findIndex((s) => s.seq === c.board_seq);
    const alightIndex = pattern.stops.findIndex((s) => s.seq === c.alight_seq);
    const board = pattern.stops[boardIndex];
    const alight = pattern.stops[alightIndex];
    if (!board || !alight) return null;

    const walk1 = walkLeg(req.from, { name: c.board_name, lon: c.board_lon, lat: c.board_lat });
    const walk2 = walkLeg({ name: c.alight_name, lon: c.alight_lon, lat: c.alight_lat }, req.to);
    const arrivals = await computeArrivals(this.deps, { feedId: c.feed_id, pattern, boardIndex, now, limit: 6 });
    // Primeiro ônibus que a pessoa consegue pegar, considerando a caminhada até o ponto (30 s de folga).
    const catchable = arrivals.filter((a) => a.waitSeconds >= walk1.durationSeconds - 30);
    const first = catchable[0];
    if (!first) return null; // sem ônibus nas próximas 2 h (fim da operação)

    const rideSeconds = alight.offset - board.offset;
    const rideMeters = Math.round(alight.dist - board.dist);
    const waitAtStop = Math.max(0, first.waitSeconds - walk1.durationSeconds);
    const transit: TransitLeg = {
      mode: 'BUS',
      routeId: ref(c.feed_id, c.route_id),
      routeShortName: c.short_name,
      routeLongName: c.long_name,
      headsign: c.headsign,
      shapeId: ref(c.feed_id, pattern.shapeId),
      board: { stopId: ref(c.feed_id, c.board_stop), name: c.board_name, lon: c.board_lon, lat: c.board_lat, distanceAlong: board.dist },
      alight: { stopId: ref(c.feed_id, c.alight_stop), name: c.alight_name, lon: c.alight_lon, lat: c.alight_lat, distanceAlong: alight.dist },
      stopsCount: alightIndex - boardIndex,
      distanceMeters: rideMeters,
      durationSeconds: rideSeconds,
      geometry: encodePolyline(line.slice(board.dist, alight.dist)),
      nextArrivals: catchable,
    };
    const duration = walk1.durationSeconds + waitAtStop + rideSeconds + walk2.durationSeconds;
    return {
      id: `${c.feed_id}:${c.pattern_id}:${c.board_stop}:${c.alight_stop}`,
      legs: [walk1, transit, walk2],
      lines: [c.short_name],
      totalDistanceMeters: walk1.distanceMeters + rideMeters + walk2.distanceMeters,
      walkDistanceMeters: walk1.distanceMeters + walk2.distanceMeters,
      waitSeconds: waitAtStop,
      durationSeconds: duration,
      departureTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + duration * 1000).toISOString(),
      realtime: first.source !== 'scheduled',
    };
  }
}
