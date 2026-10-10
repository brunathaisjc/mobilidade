/**
 * Simulador de frota: publica um feed GTFS-Realtime (VehiclePositions) a partir dos horários do GTFS.
 *
 * Usado em desenvolvimento, demonstração e testes de carga enquanto o feed oficial não está disponível.
 * Reproduz de propósito as falhas reais de AVL para exercitar o pipeline:
 *   - atraso por viagem (0–4 min, determinístico);
 *   - ruído de GPS (~12 m) e, raramente, saltos grandes (reflexo em prédios);
 *   - perda de sinal: ~5% dos veículos ficam "mudos" por até 2 minutos.
 *
 * Uso: pnpm simulator  →  http://localhost:8090/gtfs-rt/vehicle-positions
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { isMain } from '../lib/is-main.js';
import { createDb, type Db } from '../lib/db.js';
import { ACTIVE_SERVICES_SQL, dowColumn, previousServiceDay, serviceClock } from '../lib/service-time.js';
import { FeedCache } from '../realtime/gtfs-cache.js';
import { encodeVehiclePositions } from '../realtime/gtfs-rt.js';
import type { RawPosition } from '../realtime/tracker.js';

/** Número pseudoaleatório estável em [0, 1) a partir de uma string. */
export function unitHash(s: string): number {
  return createHash('sha1').update(s).digest().readUInt32BE(0) / 2 ** 32;
}

function gaussian(seed: string): number {
  const u = Math.max(1e-9, unitHash(`${seed}:u`));
  const v = unitHash(`${seed}:v`);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Distância ao longo do shape em que a viagem está, dado o tempo decorrido desde a partida. */
export function progressAlong(stops: { dist: number; offset: number }[], elapsed: number): number | null {
  if (elapsed < 0 || !stops.length) return null;
  const last = stops[stops.length - 1]!;
  if (elapsed > last.offset) return null;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (elapsed <= b.offset) {
      const span = b.offset - a.offset;
      return span <= 0 ? b.dist : a.dist + ((b.dist - a.dist) * (elapsed - a.offset)) / span;
    }
  }
  return last.dist;
}

export interface SimOptions {
  gpsNoiseM: number;
  dropoutRatio: number;
  omitTripRatio: number;
}

export async function simulatePositions(db: Db, cache: FeedCache, now: Date, opts: SimOptions): Promise<RawPosition[]> {
  const nowS = Math.floor(now.getTime() / 1000);
  const today = serviceClock(now);
  const out: RawPosition[] = [];
  for (const day of [today, previousServiceDay(today)]) {
    const { rows } = await db.query<{ service_id: string }>(ACTIVE_SERVICES_SQL(dowColumn(day.dow)), [cache.feedId, day.date]);
    const services = new Set(rows.map((r) => r.service_id));
    for (const [tripId, trip] of cache.trips) {
      if (!services.has(trip.serviceId)) continue;
      const delay = Math.round(unitHash(`${tripId}:${day.date}:delay`) * 240);
      const elapsed = day.seconds - trip.startS - delay;
      if (elapsed < 0 || day.seconds > trip.endS + delay + 60) continue;
      const pattern = cache.patterns.get(trip.patternId);
      const line = cache.shape(trip.shapeId);
      if (!pattern || !line) continue;
      const dist = progressAlong(pattern.stops, elapsed);
      if (dist === null) continue;

      const vehicleId = `GO-${(unitHash(tripId) * 90000 + 10000).toFixed(0)}`;
      // Perda de sinal em janelas de 2 min (túnel, sombra de prédio, falha de modem).
      if (unitHash(`${vehicleId}:${Math.floor(nowS / 120)}`) < opts.dropoutRatio) continue;

      const { point } = line.pointAt(dist);
      const seed = `${vehicleId}:${nowS}`;
      // Raramente (1%) um salto de ~300 m simula reflexo de sinal (multipath).
      const noise = unitHash(`${seed}:jump`) < 0.01 ? 300 : opts.gpsNoiseM;
      const dLat = (gaussian(`${seed}:lat`) * noise) / 111_320;
      const dLon = (gaussian(`${seed}:lon`) * noise) / (111_320 * Math.cos((point[1] * Math.PI) / 180));
      const omitTrip = unitHash(`${vehicleId}:omit`) < opts.omitTripRatio;
      out.push({
        vehicleId,
        tripId: omitTrip ? null : tripId,
        routeId: trip.routeId,
        lat: +(point[1] + dLat).toFixed(6),
        lon: +(point[0] + dLon).toFixed(6),
        // Leitura com 0–8 s de idade, fixa por veículo (rastreadores reais reportam em ciclos próprios).
        timestamp: nowS - Math.floor(unitHash(`${vehicleId}:lag`) * 8),
      });
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      feed: { type: 'string', default: 'rmtc-goiania-amostra' },
      port: { type: 'string', default: process.env.SIMULATOR_PORT ?? '8090' },
      noise: { type: 'string', default: '12' },
      dropout: { type: 'string', default: '0.05' },
      'omit-trip': { type: 'string', default: '0' },
      'time-offset-h': { type: 'string', default: '0' },
    },
  });
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, 2);
  const { rows: [feed] } = await db.query('SELECT feed_id FROM gtfs_feeds WHERE slug = $1', [values.feed]);
  if (!feed) throw new Error(`feed "${values.feed}" não encontrado; rode pnpm gtfs:load antes`);
  const cache = await new FeedCache(feed.feed_id).load(db);
  const opts: SimOptions = { gpsNoiseM: Number(values.noise), dropoutRatio: Number(values.dropout), omitTripRatio: Number(values['omit-trip']) };
  // Permite demonstrar o sistema fora do horário de operação (ex.: --time-offset-h=-6 às 2h da manhã).
  const offsetMs = Number(values['time-offset-h']) * 3_600_000;

  const server = createServer(async (req, res) => {
    if (req.url !== '/gtfs-rt/vehicle-positions') {
      res.writeHead(404).end();
      return;
    }
    try {
      const now = new Date(Date.now() + offsetMs);
      const positions = await simulatePositions(db, cache, now, opts);
      const body = encodeVehiclePositions(positions.map((p) => ({ ...p, timestamp: p.timestamp - offsetMs / 1000 })), Math.floor(Date.now() / 1000));
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' }).end(Buffer.from(body));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end();
    }
  });
  server.listen(Number(values.port), () =>
    console.log(`simulador GTFS-RT em http://localhost:${values.port}/gtfs-rt/vehicle-positions (${cache.trips.size} viagens)`));
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
