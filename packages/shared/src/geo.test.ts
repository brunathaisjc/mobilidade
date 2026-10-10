import { describe, expect, it } from 'vitest';
import { MeasuredLine, decodePolyline, encodePolyline, haversine, isInsideGoias, type LngLat } from './geo.js';

// Trecho aproximado da Av. Anhanguera (Goiânia), oeste → leste
const line: LngLat[] = [
  [-49.3100, -16.6700],
  [-49.2900, -16.6700],
  [-49.2700, -16.6720],
];

describe('haversine', () => {
  it('mede ~2,13 km para 0,02° de longitude na latitude de Goiânia', () => {
    const d = haversine([-49.31, -16.67], [-49.29, -16.67]);
    expect(d).toBeGreaterThan(2120);
    expect(d).toBeLessThan(2140);
  });
});

describe('MeasuredLine', () => {
  const m = new MeasuredLine(line);

  it('calcula comprimento total como soma dos segmentos', () => {
    expect(m.length).toBeCloseTo(haversine(line[0]!, line[1]!) + haversine(line[1]!, line[2]!), 6);
  });

  it('interpola ponto no meio do primeiro segmento com rumo leste', () => {
    const half = m.cumulative[1]! / 2;
    const { point, bearing } = m.pointAt(half);
    expect(point[0]).toBeCloseTo(-49.3, 4);
    expect(bearing).toBeGreaterThan(89);
    expect(bearing).toBeLessThan(91);
  });

  it('limita distâncias fora do intervalo', () => {
    expect(m.pointAt(-10).point).toEqual(line[0]);
    expect(m.pointAt(1e9).point).toEqual(line[2]);
  });

  it('projeta ponto GPS deslocado ~50 m de volta para a linha', () => {
    const gps: LngLat = [-49.3, -16.6705];
    const { distance, offset } = m.locate(gps);
    expect(offset).toBeGreaterThan(40);
    expect(offset).toBeLessThan(70);
    expect(distance).toBeCloseTo(m.cumulative[1]! / 2, -1);
  });

  it('respeita a janela do hint para não saltar para trechos distantes', () => {
    const near = m.locate([-49.271, -16.672], m.length - 50, 300);
    expect(near.distance).toBeGreaterThan(m.length - 400);
  });

  it('recorta trecho entre duas distâncias preservando vértices internos', () => {
    const s = m.slice(100, m.length - 100);
    expect(s.length).toBe(3);
    expect(s[1]).toEqual(line[1]);
  });
});

describe('polyline', () => {
  it('codifica e decodifica ida e volta', () => {
    const decoded = decodePolyline(encodePolyline(line));
    decoded.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(line[i]![0], 5);
      expect(p[1]).toBeCloseTo(line[i]![1], 5);
    });
  });

  it('decodifica exemplo canônico do Google', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts[0]).toEqual([-120.2, 38.5]);
    expect(pts[2]).toEqual([-126.453, 43.252]);
  });
});

describe('isInsideGoias', () => {
  it('aceita Goiânia, Rio Verde e Anápolis; rejeita São Paulo', () => {
    expect(isInsideGoias([-49.2539, -16.6869])).toBe(true);
    expect(isInsideGoias([-50.9281, -17.7923])).toBe(true);
    expect(isInsideGoias([-48.9526, -16.3281])).toBe(true);
    expect(isInsideGoias([-46.6333, -23.5505])).toBe(false);
  });
});

describe('locateForward', () => {
  it('em linha de ida e volta, encontra a passagem de volta quando o ponto está à frente', () => {
    const loop = new MeasuredLine([[-49.31, -16.67], [-49.29, -16.67], [-49.31, -16.67]]);
    const stop: LngLat = [-49.30, -16.67];
    expect(loop.locateForward(stop, 0).distance).toBeCloseTo(loop.length / 4, -1);
    expect(loop.locateForward(stop, loop.length / 2).distance).toBeCloseTo((loop.length * 3) / 4, -1);
  });
});
