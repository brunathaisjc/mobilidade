/**
 * Anima os ônibus ao longo do traçado da linha entre as leituras de GPS (que chegam a cada ~5–15 s).
 *
 * Em vez de "teleportar" o ícone a cada atualização, o ônibus anda continuamente sobre o shape:
 *  1. cada atualização define uma âncora (distância ao longo da linha + instante) e uma velocidade;
 *  2. a cada quadro, a posição-alvo é extrapolada: âncora + velocidade × tempo decorrido;
 *  3. a posição exibida persegue o alvo com suavização exponencial, então correções do GPS
 *     viram acelerações/desacelerações suaves, nunca saltos;
 *  4. sem GPS por mais de STALE_AFTER_S, o ônibus segue por estimativa (dead reckoning) e fica
 *     semitransparente; após MAX_DEAD_RECKONING_S, some do mapa (mesmas regras da ETA no servidor).
 *
 * É independente do MapLibre (testável em Node): `frame()` devolve GeoJSON pronto para o mapa.
 */
import {
  MAX_DEAD_RECKONING_S, MeasuredLine, STALE_AFTER_S, clampSpeed, type LngLat, type VehicleUpdate,
} from '@mobigo/shared';

/** Quanto tempo além da última leitura extrapolamos com a velocidade medida antes de esperar novo GPS. */
const EXTRAPOLATE_MAX_S = 25;
/** Constante de tempo da suavização (s): ~63% da correção em 0,8 s. */
const SMOOTHING_TAU_S = 0.8;
/** Correções maiores que isso (ex.: GPS voltou após longa falha) são aplicadas de imediato. */
const SNAP_DISTANCE_M = 600;

interface Tracked {
  update: VehicleUpdate;
  line: MeasuredLine;
  color: string;
  anchorDist: number;
  anchorMs: number;
  speed: number;
  displayDist: number;
  lastFrameMs: number;
}

export interface VehicleFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: LngLat };
  properties: { vehicleId: string; routeId: string; color: string; icon: string; bearing: number; stale: boolean; opacity: number };
}

export const busIconId = (color: string) => `bus-${color.replace('#', '')}`;

export class VehicleAnimator {
  private readonly lines = new Map<string, MeasuredLine>();
  private readonly colors = new Map<string, string>();
  private readonly vehicles = new Map<string, Tracked>();

  /** Registra o shape e a cor do itinerário; só veículos desses shapes são exibidos. */
  setShape(shapeId: string, coordinates: LngLat[], color: string) {
    if (coordinates.length < 2) return;
    this.lines.set(shapeId, new MeasuredLine(coordinates));
    this.colors.set(shapeId, color);
  }

  clearShapes() {
    this.lines.clear();
    this.colors.clear();
    this.vehicles.clear();
  }

  get shapeIds() { return [...this.lines.keys()]; }
  get size() { return this.vehicles.size; }

  /** `nowMs` = relógio do cliente; o desvio de relógio servidor/cliente é absorvido pela idade da leitura. */
  upsert(u: VehicleUpdate, nowMs = Date.now()) {
    const line = this.lines.get(u.shapeId);
    const color = this.colors.get(u.shapeId);
    if (!line || !color) return;
    const prev = this.vehicles.get(u.vehicleId);
    if (prev && u.timestamp < prev.update.timestamp) return; // fora de ordem
    const ageS = Math.max(0, Math.min(nowMs / 1000 - u.timestamp, EXTRAPOLATE_MAX_S));
    const speed = Math.max(0, u.speedMps);
    const anchorDist = Math.min(line.length, u.distanceAlong + speed * ageS);
    const keep = prev && prev.update.shapeId === u.shapeId && Math.abs(prev.displayDist - anchorDist) < SNAP_DISTANCE_M;
    this.vehicles.set(u.vehicleId, {
      update: u, line, color, anchorDist, anchorMs: nowMs, speed,
      displayDist: keep ? prev.displayDist : anchorDist,
      lastFrameMs: keep ? prev.lastFrameMs : nowMs,
    });
  }

  remove(vehicleId: string) { this.vehicles.delete(vehicleId); }

  frame(nowMs = Date.now()): { type: 'FeatureCollection'; features: VehicleFeature[] } {
    const features: VehicleFeature[] = [];
    for (const [id, v] of this.vehicles) {
      const ageS = nowMs / 1000 - v.update.timestamp;
      if (ageS > MAX_DEAD_RECKONING_S) {
        this.vehicles.delete(id);
        continue;
      }
      const stale = ageS > STALE_AFTER_S;
      const sinceAnchor = (nowMs - v.anchorMs) / 1000;
      const target = stale
        // Dead reckoning: sem GPS, avança na velocidade típica (mesma regra da ETA no servidor).
        ? v.anchorDist + clampSpeed(v.speed) * sinceAnchor
        : v.anchorDist + v.speed * Math.min(sinceAnchor, EXTRAPOLATE_MAX_S);
      const dt = Math.max(0, (nowMs - v.lastFrameMs) / 1000);
      const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU_S);
      v.displayDist = Math.min(v.line.length, v.displayDist + (target - v.displayDist) * alpha);
      v.lastFrameMs = nowMs;
      const { point, bearing } = v.line.pointAt(v.displayDist);
      features.push({
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: point },
        properties: {
          vehicleId: id, routeId: v.update.routeId, color: v.color, icon: busIconId(v.color),
          bearing, stale, opacity: stale ? 0.55 : 1,
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  /** Distância exibida (para testes e para o painel "ônibus a X m do ponto"). */
  displayDistance(vehicleId: string) { return this.vehicles.get(vehicleId)?.displayDist; }
}
