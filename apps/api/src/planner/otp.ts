/**
 * Adaptador do OpenTripPlanner 2.x (API GraphQL GTFS: /otp/gtfs/v1).
 *
 * O OTP calcula itinerários com baldeação e caminhada pela malha viária do OSM. Aqui enriquecemos
 * cada trecho de ônibus com os próximos ônibus do nosso pipeline de GPS (mesma fonte do mapa) e
 * normalizamos para o contrato da API.
 *
 * Convenção de implantação: no build-config.json do OTP, o `feedId` de cada feed GTFS deve ser o
 * feed_id numérico da tabela gtfs_feeds (ex.: "1"), para que os gtfsId "1:L101" casem com nossos IDs.
 */
import {
  decodePolyline, encodePolyline, MeasuredLine,
  type Itinerary, type Leg, type PlanRequest, type PlanResponse, type TransitLeg, type WalkLeg,
} from '@mobigo/shared';
import { parseRef } from '../lib/ids.js';
import { computeArrivals } from './arrivals.js';
import type { DirectPlanner, PlannerDeps } from './direct.js';
import { rankItineraries } from './itinerary.js';
import type { Planner } from './index.js';

const QUERY = `
query Plan($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!, $walk: Float!) {
  plan(from: $from, to: $to, date: $date, time: $time, numItineraries: 8, maxWalkDistance: $walk,
       transportModes: [{ mode: BUS }, { mode: WALK }]) {
    itineraries {
      startTime endTime duration walkDistance waitingTime
      legs {
        mode startTime endTime distance duration realTime
        from { name lat lon stop { gtfsId } }
        to   { name lat lon stop { gtfsId } }
        route { gtfsId shortName longName }
        trip { gtfsId tripHeadsign }
        intermediateStops { gtfsId }
        legGeometry { points }
      }
    }
  }
}`;

interface OtpPlace { name: string; lat: number; lon: number; stop: { gtfsId: string } | null }
export interface OtpLeg {
  mode: string; startTime: number; endTime: number; distance: number; duration: number; realTime: boolean;
  from: OtpPlace; to: OtpPlace;
  route: { gtfsId: string; shortName: string; longName: string } | null;
  trip: { gtfsId: string; tripHeadsign: string } | null;
  intermediateStops: { gtfsId: string }[] | null;
  legGeometry: { points: string };
}
export interface OtpItinerary { startTime: number; endTime: number; duration: number; walkDistance: number; waitingTime: number; legs: OtpLeg[] }

const place = (p: OtpPlace) => ({ name: p.name, lon: p.lon, lat: p.lat });

export class OtpPlanner implements Planner {
  constructor(
    private readonly baseUrl: string,
    private readonly deps: PlannerDeps,
    private readonly fallback: DirectPlanner,
  ) {}

  get feeds() { return this.deps.feeds; }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const now = req.departAt ? new Date(req.departAt) : new Date();
    let data: { plan: { itineraries: OtpItinerary[] } };
    try {
      const local = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(now); // "2026-10-10 14:05"
      const [date, time] = local.split(' ');
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/otp/gtfs/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: QUERY,
          variables: { from: { lat: req.from.lat, lon: req.from.lon }, to: { lat: req.to.lat, lon: req.to.lon }, date, time,
            walk: req.maxWalkMeters ?? this.deps.maxWalkMeters },
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`OTP HTTP ${res.status}`);
      const body = await res.json() as { data?: typeof data; errors?: unknown };
      if (!body.data) throw new Error(`OTP GraphQL: ${JSON.stringify(body.errors)}`);
      data = body.data;
    } catch (err) {
      console.warn('OTP indisponível, usando planejador direto:', (err as Error).message);
      return this.fallback.plan(req);
    }
    const itineraries = await Promise.all(data.plan.itineraries.map((it, i) => this.convert(it, i, now)));
    return { itineraries: rankItineraries(itineraries), generatedAt: new Date().toISOString(), engine: 'otp' };
  }

  async convert(it: OtpItinerary, index: number, now: Date): Promise<Omit<Itinerary, 'color' | 'dashed'>> {
    const legs: Leg[] = [];
    let firstWait = 0;
    let realtime = false;
    let prevEnd = it.startTime;
    for (const l of it.legs) {
      if (l.mode !== 'BUS' || !l.route || !l.trip || !l.from.stop || !l.to.stop) {
        const walk: WalkLeg = {
          mode: 'WALK', from: place(l.from), to: place(l.to), distanceMeters: Math.round(l.distance),
          durationSeconds: Math.round(l.duration), geometry: l.legGeometry.points,
        };
        legs.push(walk);
        prevEnd = l.endTime;
        continue;
      }
      const leg = await this.transitLeg(l, now);
      if (!legs.some((x) => x.mode === 'BUS')) {
        firstWait = Math.max(0, Math.round((l.startTime - prevEnd) / 1000));
        realtime = l.realTime || leg.nextArrivals.some((a) => a.source !== 'scheduled');
      }
      legs.push(leg);
      prevEnd = l.endTime;
    }
    const walk = legs.filter((l): l is WalkLeg => l.mode === 'WALK').reduce((s, l) => s + l.distanceMeters, 0);
    return {
      id: `otp-${index}-${it.startTime}`,
      legs,
      lines: legs.filter((l): l is TransitLeg => l.mode === 'BUS').map((l) => l.routeShortName),
      totalDistanceMeters: Math.round(legs.reduce((s, l) => s + l.distanceMeters, 0)),
      walkDistanceMeters: Math.round(walk),
      waitSeconds: firstWait,
      durationSeconds: Math.round(it.duration),
      departureTime: new Date(it.startTime).toISOString(),
      arrivalTime: new Date(it.endTime).toISOString(),
      realtime,
    };
  }

  private async transitLeg(l: OtpLeg, now: Date): Promise<TransitLeg> {
    const trip = parseRef(l.trip!.gtfsId);
    const boardStop = parseRef(l.from.stop!.gtfsId);
    const alightStop = parseRef(l.to.stop!.gtfsId);
    let shapeRef = '';
    let boardDist = 0;
    let alightDist = Math.round(l.distance);
    let nextArrivals: TransitLeg['nextArrivals'] = [];
    if (trip && boardStop && alightStop) {
      const cache = await this.deps.feeds.get(trip.feedId).catch(() => null);
      const t = cache?.trip(trip.id);
      const pattern = t && cache!.patterns.get(t.patternId);
      if (pattern) {
        shapeRef = `${trip.feedId}:${pattern.shapeId}`;
        const bi = pattern.stops.findIndex((s) => s.stopId === boardStop.id);
        const ai = pattern.stops.findIndex((s, i) => i > bi && s.stopId === alightStop.id);
        if (bi >= 0) {
          boardDist = pattern.stops[bi]!.dist;
          nextArrivals = await computeArrivals(this.deps, { feedId: trip.feedId, pattern, boardIndex: bi, now, limit: 6 });
        }
        if (ai >= 0) alightDist = pattern.stops[ai]!.dist;
      }
    }
    if (!shapeRef) {
      // Sem padrão conhecido: usa a geometria do próprio OTP como "shape" da animação.
      const coords = decodePolyline(l.legGeometry.points);
      shapeRef = `otp:${l.trip!.gtfsId}`;
      if (coords.length >= 2) alightDist = Math.round(new MeasuredLine(coords).length);
    }
    return {
      mode: 'BUS',
      routeId: l.route!.gtfsId,
      routeShortName: l.route!.shortName ?? '',
      routeLongName: l.route!.longName ?? '',
      headsign: l.trip!.tripHeadsign ?? '',
      shapeId: shapeRef,
      board: { stopId: l.from.stop!.gtfsId, ...place(l.from), distanceAlong: boardDist },
      alight: { stopId: l.to.stop!.gtfsId, ...place(l.to), distanceAlong: alightDist },
      stopsCount: (l.intermediateStops?.length ?? 0) + 1,
      distanceMeters: Math.round(l.distance),
      durationSeconds: Math.round(l.duration),
      geometry: l.legGeometry.points || encodePolyline([[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]]),
      nextArrivals,
    };
  }
}
