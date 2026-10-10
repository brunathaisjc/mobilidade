/** Adaptador GTFS-Realtime (VehiclePositions). Outros formatos (APIs proprietárias de AVL) implementam PositionSource. */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { RawPosition } from './tracker.js';

const { transit_realtime } = GtfsRealtimeBindings;

export interface PositionSource {
  readonly name: string;
  fetch(): Promise<{ feedTimestamp: number | null; positions: RawPosition[] }>;
}

export function decodeVehiclePositions(buffer: Uint8Array): { feedTimestamp: number | null; positions: RawPosition[] } {
  const msg = transit_realtime.FeedMessage.decode(buffer);
  const feedTimestamp = msg.header?.timestamp ? Number(msg.header.timestamp) : null;
  const positions: RawPosition[] = [];
  for (const e of msg.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const { latitude, longitude, speed } = v.position;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) continue;
    positions.push({
      vehicleId: v.vehicle?.id || v.vehicle?.label || e.id,
      tripId: v.trip?.tripId || null,
      routeId: v.trip?.routeId || null,
      lat: latitude,
      lon: longitude,
      timestamp: v.timestamp ? Number(v.timestamp) : feedTimestamp ?? Math.floor(Date.now() / 1000),
      speedMps: speed ?? null,
    });
  }
  return { feedTimestamp, positions };
}

export function encodeVehiclePositions(positions: RawPosition[], feedTimestamp: number): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', incrementality: transit_realtime.FeedHeader.Incrementality.FULL_DATASET, timestamp: feedTimestamp },
    entity: positions.map((p) => ({
      id: p.vehicleId,
      vehicle: {
        trip: p.tripId || p.routeId ? { tripId: p.tripId ?? undefined, routeId: p.routeId ?? undefined } : undefined,
        vehicle: { id: p.vehicleId, label: p.vehicleId },
        position: { latitude: p.lat, longitude: p.lon, speed: p.speedMps ?? undefined },
        timestamp: p.timestamp,
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}

export class GtfsRtSource implements PositionSource {
  constructor(readonly name: string, private readonly url: string, private readonly headers: Record<string, string> = {}) {}

  async fetch() {
    const res = await fetch(this.url, { headers: this.headers, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`GTFS-RT ${this.name}: HTTP ${res.status}`);
    return decodeVehiclePositions(new Uint8Array(await res.arrayBuffer()));
  }
}
