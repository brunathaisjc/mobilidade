/**
 * Próximos ônibus de um padrão em um ponto de embarque, combinando GPS e horário programado.
 *
 * Funciona com feeds que trazem trip_id (casamento exato veículo↔viagem) e com feeds que não trazem
 * (comum em AVL de operadoras): nesse caso os horários programados anteriores ao último ônibus
 * rastreado são considerados "cobertos" pelo GPS e omitidos, evitando listar o mesmo ônibus duas vezes.
 */
import { etaToStop, scheduledRunTime, type Arrival, type VehicleUpdate } from '@mobigo/shared';
import type { Db } from '../lib/db.js';
import { parseRef, ref } from '../lib/ids.js';
import { previousServiceDay, serviceClock } from '../lib/service-time.js';
import type { PatternInfo } from '../realtime/gtfs-cache.js';
import type { ServiceCalendar } from './services.js';

export interface ArrivalQuery {
  feedId: number;
  pattern: PatternInfo;
  /** Índice do ponto de embarque em pattern.stops */
  boardIndex: number;
  now: Date;
  horizonS?: number;
  limit?: number;
}

export interface ArrivalDeps {
  db: Db;
  calendar: ServiceCalendar;
  vehiclesByRoute(routeRef: string): Promise<VehicleUpdate[]>;
}

const iso = (epochS: number) => new Date(epochS * 1000).toISOString();

export async function computeArrivals(deps: ArrivalDeps, q: ArrivalQuery): Promise<Arrival[]> {
  const { feedId, pattern, boardIndex, now } = q;
  const horizon = q.horizonS ?? 2 * 3600;
  const limit = q.limit ?? 5;
  const board = pattern.stops[boardIndex]!;
  const nowS = Math.floor(now.getTime() / 1000);

  // 1. Viagens programadas (dia de serviço atual + anterior para viagens após a meia-noite)
  const today = serviceClock(now);
  const days = [today, previousServiceDay(today)];
  const scheduled: { tripId: string; atS: number }[] = [];
  for (const day of days) {
    const services = await deps.calendar.active(feedId, day);
    if (!services.length) continue;
    const { rows } = await deps.db.query<{ trip_id: string; start_s: number }>(
      `SELECT trip_id, start_s FROM gtfs_trips
       WHERE feed_id = $1 AND pattern_id = $2 AND service_id = ANY($3)
         AND start_s + $4 BETWEEN $5 AND $6
       ORDER BY start_s LIMIT 30`,
      [feedId, pattern.patternId, services, board.offset, day.seconds - 900, day.seconds + horizon],
    );
    for (const r of rows) scheduled.push({ tripId: r.trip_id, atS: day.midnightEpoch + r.start_s + board.offset });
  }
  const scheduledByTrip = new Map(scheduled.map((s) => [s.tripId, s.atS]));

  // 2. Veículos rastreados no mesmo shape, antes do ponto
  const shapeRef = ref(feedId, pattern.shapeId);
  const vehicles = (await deps.vehiclesByRoute(ref(feedId, pattern.routeId))).filter((v) => v.shapeId === shapeRef);
  const arrivals: Arrival[] = [];
  const coveredTrips = new Set<string>();
  let lastInferredS = -Infinity;
  for (const v of vehicles) {
    const intermediate = pattern.stops.filter((s, i) => i < boardIndex && s.dist > v.distanceAlong).length;
    const tripId = parseRef(v.tripId)?.id ?? '';
    const inferred = tripId.startsWith('inferred:');
    // Mesmo que já tenha passado do ponto, a viagem está "coberta": não deve reaparecer como programada.
    if (!inferred) coveredTrips.add(tripId);
    const eta = etaToStop({ distanceAlong: v.distanceAlong, speedMps: v.speedMps, timestamp: v.timestamp }, board.dist, intermediate, nowS,
      (a, b) => scheduledRunTime(pattern.stops, a, b));
    if (!eta) continue;
    const atS = nowS + eta.seconds;
    if (inferred) lastInferredS = Math.max(lastInferredS, atS);
    const sched = inferred ? undefined : scheduledByTrip.get(tripId);
    arrivals.push({
      tripId: inferred ? '' : ref(feedId, tripId),
      vehicleId: v.vehicleId,
      waitSeconds: eta.seconds,
      arrivalTime: iso(atS),
      scheduledTime: sched ? iso(sched) : null,
      source: eta.source,
    });
  }

  // 3. Horários programados ainda não cobertos por GPS
  for (const s of scheduled) {
    if (coveredTrips.has(s.tripId)) continue;
    if (s.atS < nowS - 60) continue; // provavelmente já passou (sem GPS para confirmar)
    if (s.atS <= lastInferredS + 60) continue;
    arrivals.push({
      tripId: ref(feedId, s.tripId),
      vehicleId: null,
      waitSeconds: Math.max(0, s.atS - nowS),
      arrivalTime: iso(Math.max(s.atS, nowS)),
      scheduledTime: iso(s.atS),
      source: 'scheduled',
    });
  }

  return arrivals.sort((a, b) => a.waitSeconds - b.waitSeconds).slice(0, limit);
}
