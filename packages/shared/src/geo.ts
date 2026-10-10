/**
 * Geometria em coordenadas WGS84 ([lon, lat]) para uso no servidor e no navegador.
 *
 * As distâncias usam a fórmula de haversine, cujo erro é < 0,5% em trechos urbanos,
 * suficiente para quilometragem de itinerário e animação de veículos sem depender do PostGIS.
 */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumo inicial de a para b, em graus (0 = norte, sentido horário). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Linha com distâncias acumuladas pré-calculadas. Construa uma vez por shape e reutilize:
 * a busca de posição passa a ser O(log n) em vez de O(n) por quadro de animação.
 */
export class MeasuredLine {
  readonly coords: LngLat[];
  readonly cumulative: number[];
  readonly length: number;

  constructor(coords: LngLat[]) {
    if (coords.length < 2) throw new Error('MeasuredLine requer ao menos 2 coordenadas');
    this.coords = coords;
    this.cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
      this.cumulative.push(this.cumulative[i - 1]! + haversine(coords[i - 1]!, coords[i]!));
    }
    this.length = this.cumulative[this.cumulative.length - 1]!;
  }

  /** Ponto e rumo a `distance` metros do início (limitado ao comprimento da linha). */
  pointAt(distance: number): { point: LngLat; bearing: number } {
    const d = Math.max(0, Math.min(this.length, distance));
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const a = this.coords[lo]!;
    const b = this.coords[hi]!;
    const segLen = this.cumulative[hi]! - this.cumulative[lo]!;
    const t = segLen === 0 ? 0 : (d - this.cumulative[lo]!) / segLen;
    return {
      point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      bearing: bearing(a, b),
    };
  }

  /**
   * Projeta um ponto (ex.: GPS ruidoso) na linha e devolve a distância ao longo dela
   * e o desvio perpendicular aproximado. É a versão em memória de ST_LineLocatePoint.
   *
   * `hintDistance` restringe a busca a uma janela em torno da última posição conhecida,
   * evitando "saltos" para o trecho de volta em linhas circulares ou com ida e volta sobrepostas.
   */
  locate(p: LngLat, hintDistance?: number, windowMeters = 1500): { distance: number; offset: number } {
    if (hintDistance === undefined) return this.project(p, 0, this.length);
    const windowed = this.project(p, hintDistance - windowMeters, hintDistance + windowMeters);
    return Number.isFinite(windowed.offset) ? windowed : this.project(p, 0, this.length);
  }

  /**
   * Projeção restrita ao trecho a partir de `fromDistance`. Usada para pontos de parada em sequência:
   * cada ponto só pode estar à frente do anterior, o que resolve linhas circulares que passam duas
   * vezes pelo mesmo lugar (empate fica com a primeira passagem).
   */
  locateForward(p: LngLat, fromDistance: number): { distance: number; offset: number } {
    const r = this.project(p, fromDistance, this.length);
    return Number.isFinite(r.offset) ? r : { distance: fromDistance, offset: Number.POSITIVE_INFINITY };
  }

  private project(p: LngLat, from: number, to: number): { distance: number; offset: number } {
    let best = { distance: 0, offset: Number.POSITIVE_INFINITY };
    const cosLat = Math.cos(toRad(p[1]));
    for (let i = 1; i < this.coords.length; i++) {
      const segStart = this.cumulative[i - 1]!;
      const segEnd = this.cumulative[i]!;
      if (segEnd < from || segStart > to) continue;
      const a = this.coords[i - 1]!;
      const b = this.coords[i]!;
      // Projeção plana local (equiretangular): precisa o bastante para segmentos de poucas centenas de metros.
      const ax = a[0] * cosLat, ay = a[1];
      const bx = b[0] * cosLat, by = b[1];
      const px = p[0] * cosLat, py = p[1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const segLen = segEnd - segStart;
      let t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      // Respeita os limites [from, to] dentro do próprio segmento.
      if (segLen > 0) t = Math.max((from - segStart) / segLen, Math.min((to - segStart) / segLen, t));
      t = Math.max(0, Math.min(1, t));
      const proj: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const offset = haversine(p, proj);
      if (offset < best.offset) best = { distance: segStart + segLen * t, offset };
    }
    return best;
  }

  /** Recorta o trecho entre duas distâncias (para desenhar só a parte embarcada da linha). */
  slice(from: number, to: number): LngLat[] {
    const a = Math.max(0, Math.min(from, to));
    const b = Math.min(this.length, Math.max(from, to));
    const out: LngLat[] = [this.pointAt(a).point];
    for (let i = 0; i < this.coords.length; i++) {
      const c = this.cumulative[i]!;
      if (c > a && c < b) out.push(this.coords[i]!);
    }
    out.push(this.pointAt(b).point);
    return out;
  }
}

/** Decodifica polyline do Google (precisão 5), formato usado pelo OpenTripPlanner em legGeometry. */
export function decodePolyline(encoded: string, precision = 5): LngLat[] {
  const factor = 10 ** precision;
  const out: LngLat[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let result = 0, shift = 0, byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

export function encodePolyline(coords: LngLat[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0, prevLng = 0, out = '';
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    out += enc(iLat - prevLat) + enc(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

/** Caixa delimitadora aproximada do estado de Goiás (com folga), usada para validar coordenadas. */
export const GOIAS_BBOX = { minLon: -53.3, minLat: -19.6, maxLon: -45.8, maxLat: -12.3 } as const;

export function isInsideGoias([lon, lat]: LngLat): boolean {
  return (
    lon >= GOIAS_BBOX.minLon && lon <= GOIAS_BBOX.maxLon &&
    lat >= GOIAS_BBOX.minLat && lat <= GOIAS_BBOX.maxLat
  );
}
