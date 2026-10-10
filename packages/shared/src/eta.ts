/**
 * Estimativa de chegada de um veículo em um ponto de parada.
 *
 * Fontes, em ordem de preferência:
 *  1. realtime  — posição GPS recente projetada no shape + velocidade suavizada;
 *  2. estimated — GPS desatualizado (túnel, sombra de sinal, falha de modem): a posição é
 *                 extrapolada ao longo do shape ("dead reckoning") por até MAX_DEAD_RECKONING_S;
 *  3. scheduled — sem veículo rastreado: horário programado do GTFS (+ atraso do TripUpdate, se houver).
 */

export type EtaSource = 'realtime' | 'estimated' | 'scheduled';

export const STALE_AFTER_S = 60;
export const MAX_DEAD_RECKONING_S = 300;
export const DEFAULT_SPEED_MPS = 5.5; // ~20 km/h: velocidade comercial típica de ônibus urbano
export const MIN_SPEED_MPS = 2.5;
export const MAX_SPEED_MPS = 16;
export const DWELL_PER_STOP_S = 20;
/** Tolerância para considerar que o veículo ainda não passou do ponto (erro de GPS/projeção). */
export const PASSED_TOLERANCE_M = 40;

export interface VehicleOnShape {
  /** Distância ao longo do shape no momento da última leitura, em metros. */
  distanceAlong: number;
  /** Velocidade suavizada (EWMA) em m/s; pode ser nula logo após o início da viagem. */
  speedMps: number | null;
  /** Epoch em segundos da última leitura válida de GPS. */
  timestamp: number;
}

export function clampSpeed(speed: number | null | undefined): number {
  if (speed === null || speed === undefined || !Number.isFinite(speed) || speed <= 0) return DEFAULT_SPEED_MPS;
  return Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, speed));
}

/** Posição atual estimada do veículo ao longo do shape, aplicando dead reckoning se o GPS estiver velho. */
export function projectVehicle(
  v: VehicleOnShape,
  nowS: number,
): { distanceAlong: number; source: EtaSource } | null {
  const age = Math.max(0, nowS - v.timestamp);
  if (age > MAX_DEAD_RECKONING_S) return null;
  if (age <= STALE_AFTER_S) return { distanceAlong: v.distanceAlong, source: 'realtime' };
  return { distanceAlong: v.distanceAlong + clampSpeed(v.speedMps) * age, source: 'estimated' };
}

/**
 * Tempo de percurso programado entre duas distâncias de um padrão, interpolando os offsets dos pontos.
 * Inclui o tempo parado nos pontos (já embutido nos horários do GTFS).
 */
export function scheduledRunTime(stops: { dist: number; offset: number }[], fromDist: number, toDist: number): number {
  const at = (d: number) => {
    if (!stops.length) return 0;
    if (d <= stops[0]!.dist) return stops[0]!.offset;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!, b = stops[i]!;
      if (d <= b.dist) return b.dist === a.dist ? b.offset : a.offset + ((b.offset - a.offset) * (d - a.dist)) / (b.dist - a.dist);
    }
    return stops[stops.length - 1]!.offset;
  };
  return Math.max(0, at(toDist) - at(fromDist));
}

/**
 * Segundos até o veículo chegar ao ponto localizado em `stopDistanceAlong` no mesmo shape,
 * ou null se ele já passou ou se o dado está velho demais para ser confiável.
 *
 * Com `runTime` (tempo programado entre duas distâncias), a ETA usa o tempo de percurso do GTFS a partir
 * da posição real do ônibus — mais estável que a velocidade instantânea do GPS, que oscila entre 0 (parado
 * no ponto/semáforo) e 15 m/s. Sem ele, usa velocidade suavizada + tempo fixo por parada.
 * Evolução prevista: tempos de percurso históricos por faixa horária (ver docs/09-roadmap.md).
 */
export function etaToStop(
  v: VehicleOnShape,
  stopDistanceAlong: number,
  intermediateStops: number,
  nowS: number,
  runTime?: (fromDist: number, toDist: number) => number,
): { seconds: number; source: EtaSource } | null {
  const p = projectVehicle(v, nowS);
  if (!p) return null;
  const remaining = stopDistanceAlong - p.distanceAlong;
  if (remaining < -PASSED_TOLERANCE_M) return null;
  // Na fonte realtime a posição é a do instante da leitura; desconta a idade da leitura.
  const age = p.source === 'realtime' ? Math.max(0, nowS - v.timestamp) : 0;
  const travel = runTime
    ? runTime(p.distanceAlong, Math.max(p.distanceAlong, stopDistanceAlong))
    : Math.max(0, remaining) / clampSpeed(v.speedMps) + Math.max(0, intermediateStops) * DWELL_PER_STOP_S;
  return { seconds: Math.max(0, Math.round(travel - age)), source: p.source };
}

/** Média móvel exponencial para suavizar a velocidade derivada de leituras GPS consecutivas. */
export function smoothSpeed(previous: number | null, sample: number, alpha = 0.3): number {
  if (!Number.isFinite(sample) || sample < 0 || sample > 30) return previous ?? DEFAULT_SPEED_MPS;
  return previous === null ? sample : previous + alpha * (sample - previous);
}

/** Converte "HH:MM:SS" do GTFS (pode passar de 24h) em segundos desde o início do dia de serviço. */
export function gtfsTimeToSeconds(t: string): number {
  const [h, m, s] = t.trim().split(':').map(Number);
  if ([h, m, s].some((x) => x === undefined || Number.isNaN(x))) throw new Error(`Horário GTFS inválido: ${t}`);
  return h! * 3600 + m! * 60 + s!;
}

export function secondsToGtfsTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}
