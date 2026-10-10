/**
 * Gera um feed GTFS SINTÉTICO de Goiânia para desenvolvimento, testes e demonstração.
 *
 * Os marcos usam coordenadas aproximadas de locais reais (terminais, praças), mas LINHAS, HORÁRIOS
 * E PONTOS SÃO FICTÍCIOS. Substitua pelo feed oficial da operadora/CMTC assim que o acordo de dados
 * for firmado (ver docs/01-visao-do-produto.md, seção Premissas e Riscos).
 *
 * Uso: pnpm --filter @mobigo/api exec tsx src/scripts/generate-sample-gtfs.ts [diretório-saída]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, type LngLat } from '@mobigo/shared';
import { isMain } from '../lib/is-main.js';

const LANDMARKS = {
  PADRE_PELAGIO: { name: 'Terminal Padre Pelágio', at: [-49.3237, -16.656] },
  PRACA_A: { name: 'Praça A (Campinas)', at: [-49.293, -16.668] },
  BANDEIRANTE: { name: 'Praça do Bandeirante', at: [-49.2556, -16.6788] },
  PRACA_CIVICA: { name: 'Praça Cívica', at: [-49.2643, -16.6866] },
  BIBLIA: { name: 'Terminal Praça da Bíblia', at: [-49.2236, -16.6731] },
  NOVO_MUNDO: { name: 'Terminal Novo Mundo', at: [-49.203, -16.664] },
  BANDEIRAS: { name: 'Terminal Bandeiras', at: [-49.2975, -16.715] },
  ISIDORIA: { name: 'Terminal Isidória', at: [-49.256, -16.7065] },
  FLAMBOYANT: { name: 'Shopping Flamboyant', at: [-49.237, -16.7105] },
  RODOVIARIA: { name: 'Rodoviária de Goiânia', at: [-49.2585, -16.6625] },
  UFG: { name: 'UFG – Campus Samambaia', at: [-49.2654, -16.6035] },
} satisfies Record<string, { name: string; at: LngLat }>;
type Landmark = keyof typeof LANDMARKS;

interface LineDef {
  id: string;
  shortName: string;
  longName: string;
  color: string;
  path: Landmark[];
  /** Intervalo entre partidas, em minutos: [dia útil, sábado, domingo]. */
  headways: [number, number, number];
}

const LINES: LineDef[] = [
  { id: 'L101', shortName: '101', longName: 'Eixo Leste–Oeste (Padre Pelágio – Novo Mundo)', color: 'C8102E',
    path: ['PADRE_PELAGIO', 'PRACA_A', 'BANDEIRANTE', 'BIBLIA', 'NOVO_MUNDO'], headways: [8, 15, 20] },
  { id: 'L102', shortName: '102', longName: 'Bandeiras – Praça da Bíblia via Centro', color: '0057B8',
    path: ['BANDEIRAS', 'PRACA_A', 'PRACA_CIVICA', 'BANDEIRANTE', 'BIBLIA'], headways: [12, 20, 30] },
  { id: 'L103', shortName: '103', longName: 'Isidória – UFG Samambaia', color: '00843D',
    path: ['ISIDORIA', 'PRACA_CIVICA', 'BANDEIRANTE', 'RODOVIARIA', 'UFG'], headways: [15, 25, 30] },
  { id: 'L104', shortName: '104', longName: 'Flamboyant – Campinas', color: 'F2A900',
    path: ['FLAMBOYANT', 'ISIDORIA', 'PRACA_CIVICA', 'PRACA_A'], headways: [20, 30, 40] },
];

const STOP_SPACING_M = 450;
const VERTEX_SPACING_M = 80;
const SPEED_MPS = 6; // ~21,6 km/h
const DWELL_S = 20;
const SERVICE_START_S = 5 * 3600;
const SERVICE_END_S = 23 * 3600 + 30 * 60;

const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

function interpolate(a: LngLat, b: LngLat, t: number): LngLat {
  return [+(a[0] + (b[0] - a[0]) * t).toFixed(6), +(a[1] + (b[1] - a[1]) * t).toFixed(6)];
}

/** Pontos intermediários de um trecho entre dois marcos, compartilhados entre linhas e sentidos. */
const corridorStops = new Map<string, { id: string; name: string; at: LngLat }[]>();
function stopsBetween(a: Landmark, b: Landmark) {
  const [x, y] = [a, b].sort() as [Landmark, Landmark];
  const key = `${x}-${y}`;
  if (!corridorStops.has(key)) {
    const pa = LANDMARKS[x].at, pb = LANDMARKS[y].at;
    const n = Math.max(0, Math.round(haversine(pa, pb) / STOP_SPACING_M) - 1);
    corridorStops.set(key, Array.from({ length: n }, (_, i) => ({
      id: `S-${key}-${i + 1}`,
      name: `Entre ${LANDMARKS[x].name} e ${LANDMARKS[y].name} (P${i + 1})`,
      at: interpolate(pa, pb, (i + 1) / (n + 1)),
    })));
  }
  const list = corridorStops.get(key)!;
  return a === x ? list : [...list].reverse();
}

export async function generateSampleGtfs(outDir: string) {
  await mkdir(outDir, { recursive: true });
  const stops = new Map<string, { name: string; at: LngLat }>();
  for (const [id, l] of Object.entries(LANDMARKS)) stops.set(id, { name: l.name, at: l.at });

  const shapesRows: (string | number)[][] = [['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled']];
  const tripsRows: (string | number)[][] = [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id']];
  const stRows: (string | number)[][] = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']];
  const fmt = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');

  for (const line of LINES) {
    for (const direction of [0, 1] as const) {
      const path = direction === 0 ? line.path : [...line.path].reverse();
      const shapeId = `${line.id}-${direction}`;
      // Sequência de pontos de parada e geometria densificada
      const seqStops: { id: string; at: LngLat }[] = [];
      const coords: LngLat[] = [];
      for (let i = 0; i < path.length; i++) {
        const lm = path[i]!;
        seqStops.push({ id: lm, at: LANDMARKS[lm].at });
        if (i === path.length - 1) { coords.push(LANDMARKS[lm].at); break; }
        const next = path[i + 1]!;
        const a = LANDMARKS[lm].at, b = LANDMARKS[next].at;
        const steps = Math.max(1, Math.ceil(haversine(a, b) / VERTEX_SPACING_M));
        for (let s = 0; s < steps; s++) coords.push(interpolate(a, b, s / steps));
        for (const st of stopsBetween(lm, next)) {
          stops.set(st.id, { name: st.name, at: st.at });
          seqStops.push({ id: st.id, at: st.at });
        }
      }
      let dist = 0;
      coords.forEach((c, i) => {
        if (i > 0) dist += haversine(coords[i - 1]!, c);
        shapesRows.push([shapeId, c[1], c[0], i + 1, dist.toFixed(1)]);
      });

      // Offsets de tempo por ponto (mesmos para todas as viagens deste padrão)
      const offsets: number[] = [0];
      for (let i = 1; i < seqStops.length; i++) {
        offsets.push(offsets[i - 1]! + Math.round(haversine(seqStops[i - 1]!.at, seqStops[i]!.at) / SPEED_MPS) + DWELL_S);
      }
      const headsign = LANDMARKS[path[path.length - 1]!].name;
      (['UTIL', 'SAB', 'DOM'] as const).forEach((service, si) => {
        const headway = line.headways[si]! * 60;
        // Defasagem por sentido para que ida e volta não partam no mesmo minuto
        for (let t = SERVICE_START_S + direction * Math.round(headway / 2); t <= SERVICE_END_S; t += headway) {
          const tripId = `${line.id}-${direction}-${service}-${fmt(t).replace(/:/g, '')}`;
          tripsRows.push([line.id, service, tripId, headsign, direction, shapeId]);
          seqStops.forEach((s, i) => {
            const at = fmt(t + offsets[i]!);
            stRows.push([tripId, at, at, s.id, i + 1]);
          });
        }
      });
    }
  }

  const files: Record<string, string> = {
    'agency.txt': csv([
      ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
      ['EXEMPLO', 'Operadora Exemplo (dados fictícios)', 'https://example.org', 'America/Sao_Paulo', 'pt'],
    ]),
    'feed_info.txt': csv([
      ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'],
      ['Mobi GO (amostra sintética)', 'https://example.org', 'pt', '20260101', '20271231', 'sample-2026.10'],
    ]),
    'routes.txt': csv([
      ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'],
      ...LINES.map((l) => [l.id, 'EXEMPLO', l.shortName, l.longName, 3, l.color, 'FFFFFF']),
    ]),
    'stops.txt': csv([
      ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'wheelchair_boarding'],
      ...[...stops.entries()].map(([id, s]) => [id, s.name, s.at[1], s.at[0], 1]),
    ]),
    'calendar.txt': csv([
      ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['UTIL', 1, 1, 1, 1, 1, 0, 0, '20260101', '20271231'],
      ['SAB', 0, 0, 0, 0, 0, 1, 0, '20260101', '20271231'],
      ['DOM', 0, 0, 0, 0, 0, 0, 1, '20260101', '20271231'],
    ]),
    'calendar_dates.txt': csv([
      ['service_id', 'date', 'exception_type'],
      // Feriados: opera com tabela de domingo (ex.: 24/10 aniversário de Goiânia, 15/11, 25/12)
      ...['20261012', '20261024', '20261102', '20261115', '20261120', '20261225'].flatMap((d) => {
        const dow = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T12:00:00Z`).getUTCDay();
        const regular = dow === 0 ? 'DOM' : dow === 6 ? 'SAB' : 'UTIL';
        return regular === 'DOM' ? [] : [[regular, d, 2], ['DOM', d, 1]];
      }),
    ]),
    'shapes.txt': csv(shapesRows),
    'trips.txt': csv(tripsRows),
    'stop_times.txt': csv(stRows),
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(outDir, name), content);
  return { stops: stops.size, trips: tripsRows.length - 1, stopTimes: stRows.length - 1 };
}

if (isMain(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(process.argv[2] ?? join(here, '../../../../data/gtfs-sample'));
  generateSampleGtfs(out).then((r) => console.log(`GTFS de amostra gerado em ${out}:`, r));
}
