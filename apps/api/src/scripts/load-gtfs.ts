/**
 * Carrega um feed GTFS (diretório descompactado) no PostGIS.
 *
 * - Substitui o feed inteiro dentro de UMA transação: a API continua lendo a versão anterior
 *   (MVCC) até o COMMIT, então a troca de versão não tem janela de indisponibilidade.
 * - Calcula padrões de parada e a distância de cada ponto ao longo do shape (linear referencing),
 *   necessários para a ETA em tempo real e para a quilometragem do itinerário.
 *
 * Uso: pnpm gtfs:load -- --slug rmtc-goiania --name "RMTC Goiânia" --dir ./data/gtfs-sample [--ibge 5208707]
 *      [--vehicle-positions-url http://localhost:8090/gtfs-rt/vehicle-positions]
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse';
import type pg from 'pg';
import { MeasuredLine, gtfsTimeToSeconds, type LngLat } from '@mobigo/shared';
import { loadConfig } from '../config.js';
import { isMain } from '../lib/is-main.js';
import { createDb, withTransaction } from '../lib/db.js';

type Row = Record<string, string>;

async function readCsv(dir: string, file: string, required = true): Promise<Row[]> {
  const path = join(dir, file);
  if (!existsSync(path)) {
    if (required) throw new Error(`Arquivo obrigatório ausente no feed: ${file}`);
    return [];
  }
  const rows: Row[] = [];
  const parser = createReadStream(path).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }));
  for await (const r of parser) rows.push(r as Row);
  return rows;
}

/** INSERT em lote via unnest(): uma ida ao banco por bloco, sem limite de 65535 parâmetros. */
async function bulkInsert(client: pg.PoolClient, table: string, columns: string[], types: string[], rows: unknown[][], batch = 5000) {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const arrays = columns.map((_, c) => chunk.map((r) => r[c] ?? null));
    const unnest = types.map((t, c) => `$${c + 1}::${t}[]`).join(', ');
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) SELECT * FROM unnest(${unnest})`, arrays);
  }
}

const gtfsDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const bool = (v: string | undefined) => v === '1';

export interface LoadOptions {
  slug: string;
  name: string;
  dir: string;
  municipalityIbge?: string;
  vehiclePositionsUrl?: string;
  tripUpdatesUrl?: string;
}

export async function loadGtfs(db: pg.Pool, opts: LoadOptions, log: (m: string) => void = console.log) {
  const dir = resolve(opts.dir);
  const [agency, routes, stops, trips, stopTimes, shapes, calendar, calendarDates, feedInfo] = await Promise.all([
    readCsv(dir, 'agency.txt'),
    readCsv(dir, 'routes.txt'),
    readCsv(dir, 'stops.txt'),
    readCsv(dir, 'trips.txt'),
    readCsv(dir, 'stop_times.txt'),
    readCsv(dir, 'shapes.txt', false),
    readCsv(dir, 'calendar.txt', false),
    readCsv(dir, 'calendar_dates.txt', false),
    readCsv(dir, 'feed_info.txt', false),
  ]);
  log(`lido: ${routes.length} linhas, ${stops.length} pontos, ${trips.length} viagens, ${stopTimes.length} horários`);

  const stopCoords = new Map<string, LngLat>();
  for (const s of stops) {
    // location_type 1 = estação (agrupador); usamos apenas pontos de embarque.
    if (s.location_type && s.location_type !== '0') continue;
    stopCoords.set(s.stop_id!, [Number(s.stop_lon), Number(s.stop_lat)]);
  }

  // Shapes: agrupa e ordena por sequência
  const shapePts = new Map<string, { seq: number; at: LngLat }[]>();
  for (const p of shapes) {
    const list = shapePts.get(p.shape_id!) ?? [];
    list.push({ seq: Number(p.shape_pt_sequence), at: [Number(p.shape_pt_lon), Number(p.shape_pt_lat)] });
    shapePts.set(p.shape_id!, list);
  }
  const shapeLines = new Map<string, MeasuredLine>();
  for (const [id, pts] of shapePts) {
    pts.sort((a, b) => a.seq - b.seq);
    if (pts.length >= 2) shapeLines.set(id, new MeasuredLine(pts.map((p) => p.at)));
  }

  // stop_times agrupados por viagem
  const byTrip = new Map<string, { seq: number; stopId: string; arr: number; dep: number }[]>();
  for (const st of stopTimes) {
    const list = byTrip.get(st.trip_id!) ?? [];
    const arr = gtfsTimeToSeconds(st.arrival_time || st.departure_time!);
    const dep = gtfsTimeToSeconds(st.departure_time || st.arrival_time!);
    list.push({ seq: Number(st.stop_sequence), stopId: st.stop_id!, arr, dep });
    byTrip.set(st.trip_id!, list);
  }

  // Padrões: mesma linha + shape + sequência de pontos + offsets relativos
  type Pattern = { id: string; routeId: string; directionId: number | null; shapeId: string; headsign: string; stops: { stopId: string; dist: number; offset: number }[] };
  const patterns = new Map<string, Pattern>();
  const tripRows: unknown[][] = [];
  const stopTimeRows: unknown[][] = [];
  let skipped = 0;

  for (const t of trips) {
    const sts = byTrip.get(t.trip_id!);
    if (!sts || sts.length < 2) { skipped++; continue; }
    sts.sort((a, b) => a.seq - b.seq);
    if (sts.some((s) => !stopCoords.has(s.stopId))) { skipped++; continue; }
    const start = sts[0]!.dep;
    let shapeId = t.shape_id || '';
    if (!shapeLines.has(shapeId)) {
      // Feed sem shape: gera geometria reta entre pontos (qualidade inferior, mas funcional).
      shapeId = `auto:${createHash('sha1').update(sts.map((s) => s.stopId).join('>')).digest('hex').slice(0, 12)}`;
      if (!shapeLines.has(shapeId)) shapeLines.set(shapeId, new MeasuredLine(sts.map((s) => stopCoords.get(s.stopId)!)));
    }
    const key = [t.route_id, t.direction_id ?? '', shapeId, ...sts.map((s) => `${s.stopId}@${s.arr - start}/${s.dep - start}`)].join('|');
    const patternId = `${t.route_id}:${t.direction_id ?? 'x'}:${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
    if (!patterns.has(patternId)) {
      const line = shapeLines.get(shapeId)!;
      let from = 0;
      const pstops = sts.map((s) => {
        // Projeção monotônica: cada ponto é buscado à frente do anterior (evita casar com o sentido oposto).
        from = line.locateForward(stopCoords.get(s.stopId)!, from).distance;
        return { stopId: s.stopId, dist: Math.round(from * 10) / 10, offset: s.dep - start };
      });
      patterns.set(patternId, {
        id: patternId, routeId: t.route_id!, directionId: t.direction_id ? Number(t.direction_id) : null,
        shapeId, headsign: t.trip_headsign ?? '', stops: pstops,
      });
    }
    tripRows.push([t.trip_id, t.route_id, t.service_id, patternId, shapeId, t.trip_headsign ?? '',
      t.direction_id ? Number(t.direction_id) : null, start, sts[sts.length - 1]!.arr]);
    for (const s of sts) stopTimeRows.push([t.trip_id, s.seq, s.stopId, s.arr, s.dep]);
  }
  if (skipped) log(`aviso: ${skipped} viagens ignoradas (sem horários ou com pontos inexistentes)`);

  const usedShapes = new Set([...patterns.values()].map((p) => p.shapeId));

  return withTransaction(db, async (client) => {
    const version = feedInfo[0]?.feed_version ?? new Date().toISOString().slice(0, 10);
    const { rows: [feed] } = await client.query<{ feed_id: number }>(
      `INSERT INTO gtfs_feeds (slug, name, municipality_ibge, rt_vehicle_positions_url, rt_trip_updates_url, version, loaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
         municipality_ibge = COALESCE(EXCLUDED.municipality_ibge, gtfs_feeds.municipality_ibge),
         rt_vehicle_positions_url = COALESCE(EXCLUDED.rt_vehicle_positions_url, gtfs_feeds.rt_vehicle_positions_url),
         rt_trip_updates_url = COALESCE(EXCLUDED.rt_trip_updates_url, gtfs_feeds.rt_trip_updates_url),
         version = EXCLUDED.version, loaded_at = now()
       RETURNING feed_id`,
      [opts.slug, opts.name, opts.municipalityIbge ?? null, opts.vehiclePositionsUrl ?? null, opts.tripUpdatesUrl ?? null, version],
    );
    const feedId = feed!.feed_id;
    for (const table of ['gtfs_stop_times', 'gtfs_trips', 'gtfs_pattern_stops', 'gtfs_patterns', 'gtfs_shapes',
      'gtfs_calendar_dates', 'gtfs_calendar', 'gtfs_stops', 'gtfs_routes', 'gtfs_agency']) {
      await client.query(`DELETE FROM ${table} WHERE feed_id = $1`, [feedId]);
    }
    const withFeed = (rows: unknown[][]) => rows.map((r) => [feedId, ...r]);

    await bulkInsert(client, 'gtfs_agency', ['feed_id', 'agency_id', 'agency_name', 'agency_url'], ['int', 'text', 'text', 'text'],
      withFeed(agency.map((a) => [a.agency_id || 'default', a.agency_name, a.agency_url])));
    await bulkInsert(client, 'gtfs_routes',
      ['feed_id', 'route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'],
      ['int', 'text', 'text', 'text', 'text', 'int2', 'text', 'text'],
      withFeed(routes.map((r) => [r.route_id, r.agency_id || null, r.route_short_name ?? '', r.route_long_name ?? '',
        Number(r.route_type), r.route_color || null, r.route_text_color || null])));

    const stopRows = stops.filter((s) => stopCoords.has(s.stop_id!));
    await client.query(
      `INSERT INTO gtfs_stops (feed_id, stop_id, stop_code, stop_name, geom, wheelchair_boarding)
       SELECT $1, id, code, name, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography, wb
       FROM unnest($2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::int2[]) AS t(id, code, name, lon, lat, wb)`,
      [feedId, stopRows.map((s) => s.stop_id), stopRows.map((s) => s.stop_code || null), stopRows.map((s) => s.stop_name),
        stopRows.map((s) => Number(s.stop_lon)), stopRows.map((s) => Number(s.stop_lat)),
        stopRows.map((s) => (s.wheelchair_boarding ? Number(s.wheelchair_boarding) : null))],
    );

    for (const id of usedShapes) {
      const line = shapeLines.get(id)!;
      const wkt = `LINESTRING(${line.coords.map((c) => `${c[0]} ${c[1]}`).join(',')})`;
      await client.query(
        'INSERT INTO gtfs_shapes (feed_id, shape_id, geom, length_m) VALUES ($1, $2, ST_GeomFromText($3, 4326), $4)',
        [feedId, id, wkt, line.length],
      );
    }

    await bulkInsert(client, 'gtfs_calendar',
      ['feed_id', 'service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['int', 'text', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool', 'date', 'date'],
      withFeed(calendar.map((c) => [c.service_id, bool(c.monday), bool(c.tuesday), bool(c.wednesday), bool(c.thursday),
        bool(c.friday), bool(c.saturday), bool(c.sunday), gtfsDate(c.start_date!), gtfsDate(c.end_date!)])));
    await bulkInsert(client, 'gtfs_calendar_dates', ['feed_id', 'service_id', 'date', 'exception_type'], ['int', 'text', 'date', 'int2'],
      withFeed(calendarDates.map((c) => [c.service_id, gtfsDate(c.date!), Number(c.exception_type)])));

    const pats = [...patterns.values()];
    await bulkInsert(client, 'gtfs_patterns', ['feed_id', 'pattern_id', 'route_id', 'direction_id', 'shape_id', 'headsign'],
      ['int', 'text', 'text', 'int2', 'text', 'text'],
      withFeed(pats.map((p) => [p.id, p.routeId, p.directionId, p.shapeId, p.headsign])));
    await bulkInsert(client, 'gtfs_pattern_stops', ['feed_id', 'pattern_id', 'seq', 'stop_id', 'dist_m', 'offset_s'],
      ['int', 'text', 'int2', 'text', 'float8', 'int4'],
      withFeed(pats.flatMap((p) => p.stops.map((s, i) => [p.id, i, s.stopId, s.dist, s.offset]))));
    await bulkInsert(client, 'gtfs_trips',
      ['feed_id', 'trip_id', 'route_id', 'service_id', 'pattern_id', 'shape_id', 'headsign', 'direction_id', 'start_s', 'end_s'],
      ['int', 'text', 'text', 'text', 'text', 'text', 'text', 'int2', 'int4', 'int4'], withFeed(tripRows));
    await bulkInsert(client, 'gtfs_stop_times', ['feed_id', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_s', 'departure_s'],
      ['int', 'text', 'int4', 'text', 'int4', 'int4'], withFeed(stopTimeRows));

    await client.query('ANALYZE gtfs_stops, gtfs_pattern_stops, gtfs_trips');
    const summary = { feedId, version, routes: routes.length, stops: stopRows.length, patterns: pats.length, trips: tripRows.length };
    log(`feed "${opts.slug}" carregado: ${JSON.stringify(summary)}`);
    return summary;
  });
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      slug: { type: 'string', default: 'rmtc-goiania-amostra' },
      name: { type: 'string', default: 'RMTC Goiânia (amostra sintética)' },
      dir: { type: 'string', default: join(process.cwd(), '../../data/gtfs-sample') },
      ibge: { type: 'string', default: '5208707' },
      'vehicle-positions-url': { type: 'string' },
      'trip-updates-url': { type: 'string' },
    },
  });
  const db = createDb(loadConfig().DATABASE_URL, 2);
  loadGtfs(db, {
    slug: values.slug!, name: values.name!, dir: values.dir!, municipalityIbge: values.ibge,
    vehiclePositionsUrl: values['vehicle-positions-url'], tripUpdatesUrl: values['trip-updates-url'],
  })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.end());
}
