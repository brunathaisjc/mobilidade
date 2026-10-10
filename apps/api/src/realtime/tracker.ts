/**
 * Converte leituras GPS brutas em posições "limpas" sobre o traçado da linha.
 *
 * Problemas tratados (comuns em AVL de ônibus):
 *  - ruído de 10–50 m e reflexo em prédios (multipath): projeção no shape (map-matching linear);
 *  - saltos absurdos (>120 m fora da via): leitura descartada, mantém a última boa;
 *  - "andar para trás" por jitter: posição travada no máximo já atingido;
 *  - leituras duplicadas ou fora de ordem: descartadas pelo timestamp;
 *  - feed sem trip_id: o sentido é inferido pelo shape mais próximo e confirmado pelo movimento;
 *  - perda de sinal: tratada no consumidor (dead reckoning em eta.ts e na animação do cliente).
 */
import { MeasuredLine, smoothSpeed, type VehicleUpdate } from '@mobigo/shared';
import { ref } from '../lib/ids.js';

export interface RawPosition {
  vehicleId: string;
  tripId?: string | null;
  routeId?: string | null;
  lat: number;
  lon: number;
  /** epoch em segundos */
  timestamp: number;
  speedMps?: number | null;
}

export interface TripInfo {
  routeId: string;
  shapeId: string;
}

export interface TrackerData {
  feedId: number;
  trip(tripId: string): TripInfo | undefined;
  /** Shapes candidatos de uma linha (ambos os sentidos/variantes), para feeds sem trip_id. */
  routeShapes(routeId: string): string[];
  shape(shapeId: string): MeasuredLine | undefined;
}

interface State {
  shapeId: string;
  routeId: string;
  tripId: string;
  distance: number;
  speed: number | null;
  timestamp: number;
}

export const MAX_GPS_OFFSET_M = 120;
export const BACKWARD_TOLERANCE_M = 30;
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

export type RejectReason = 'stale' | 'unknown_trip' | 'off_route' | 'no_shape' | 'jump';

export class VehicleTracker {
  private readonly states = new Map<string, State>();
  readonly rejected: Record<RejectReason, number> = { stale: 0, unknown_trip: 0, off_route: 0, no_shape: 0, jump: 0 };

  constructor(private readonly data: TrackerData) {}

  process(raw: RawPosition): VehicleUpdate | null {
    const prev = this.states.get(raw.vehicleId);
    if (prev && raw.timestamp <= prev.timestamp) {
      this.rejected.stale++;
      return null;
    }
    const resolved = this.resolve(raw, prev);
    if (!resolved) return null;
    const { tripId, routeId, shapeId, line, located } = resolved;

    if (located.offset > MAX_GPS_OFFSET_M) {
      this.rejected.off_route++;
      return null;
    }

    const sameTrip = prev && prev.tripId === tripId && prev.shapeId === shapeId;
    let distance = located.distance;
    let speed = raw.speedMps ?? null;
    if (sameTrip) {
      const dt = raw.timestamp - prev.timestamp;
      // Avanço fisicamente impossível (> 108 km/h em via urbana): salto de GPS, descarta a leitura.
      if (dt > 0 && (distance - prev.distance) / dt > MAX_PLAUSIBLE_SPEED_MPS) {
        this.rejected.jump++;
        return null;
      }
      // Recuo (jitter/reflexo): ônibus não anda de ré na linha; trava no máximo já atingido.
      distance = Math.max(distance, prev.distance);
      const sample = dt > 0 && dt <= 120 ? (distance - prev.distance) / dt : null;
      speed = sample === null ? prev.speed : smoothSpeed(prev.speed, sample);
    }

    this.states.set(raw.vehicleId, { shapeId, routeId, tripId, distance, speed, timestamp: raw.timestamp });
    const { point, bearing } = line.pointAt(distance);
    const feedId = this.data.feedId;
    return {
      vehicleId: raw.vehicleId,
      routeId: ref(feedId, routeId),
      tripId: ref(feedId, tripId),
      shapeId: ref(feedId, shapeId),
      // Publicamos a posição projetada na via: o ícone nunca aparece "dentro de um quarteirão".
      lon: +point[0].toFixed(6),
      lat: +point[1].toFixed(6),
      bearing: Math.round(bearing),
      distanceAlong: Math.round(distance),
      speedMps: speed === null ? 0 : +speed.toFixed(2),
      timestamp: raw.timestamp,
      source: 'realtime',
    };
  }

  private resolve(raw: RawPosition, prev: State | undefined) {
    const p: [number, number] = [raw.lon, raw.lat];
    if (raw.tripId) {
      const trip = this.data.trip(raw.tripId);
      if (!trip) {
        this.rejected.unknown_trip++;
        return null;
      }
      const line = this.data.shape(trip.shapeId);
      if (!line) {
        this.rejected.no_shape++;
        return null;
      }
      const hint = prev?.tripId === raw.tripId ? prev.distance : undefined;
      return { tripId: raw.tripId, routeId: trip.routeId, shapeId: trip.shapeId, line, located: line.locate(p, hint) };
    }
    // Sem trip_id: escolhe o shape da linha mais próximo; em empate (ida/volta sobrepostas),
    // prefere o que mantém o sentido de movimento observado.
    if (!raw.routeId) {
      this.rejected.unknown_trip++;
      return null;
    }
    let best: { shapeId: string; line: MeasuredLine; located: { distance: number; offset: number }; score: number } | null = null;
    for (const shapeId of this.data.routeShapes(raw.routeId)) {
      const line = this.data.shape(shapeId);
      if (!line) continue;
      const continuing = prev?.shapeId === shapeId;
      const located = line.locate(p, continuing ? prev!.distance : undefined);
      let score = located.offset;
      if (continuing) score += located.distance >= prev!.distance - BACKWARD_TOLERANCE_M ? -15 : 40;
      if (!best || score < best.score) best = { shapeId, line, located, score };
    }
    if (!best) {
      this.rejected.no_shape++;
      return null;
    }
    return { tripId: `inferred:${raw.routeId}:${raw.vehicleId}`, routeId: raw.routeId, shapeId: best.shapeId, line: best.line, located: best.located };
  }

  /** Remove estado de veículos sem leitura há mais de `maxAgeS` (evita vazamento de memória). */
  prune(nowS: number, maxAgeS = 900) {
    for (const [id, s] of this.states) if (nowS - s.timestamp > maxAgeS) this.states.delete(id);
  }
}
