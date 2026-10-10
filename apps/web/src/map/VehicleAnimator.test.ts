import { describe, expect, it } from 'vitest';
import type { LngLat, VehicleUpdate } from '@mobigo/shared';
import { VehicleAnimator, busIconId } from './VehicleAnimator';

const coords: LngLat[] = Array.from({ length: 51 }, (_, i) => [-49.30 + i * 0.001, -16.67]); // ~5,3 km
const T0 = 1_760_000_000_000; // ms

function update(over: Partial<VehicleUpdate> = {}): VehicleUpdate {
  return {
    vehicleId: 'V1', routeId: '1:L101', tripId: '1:T', shapeId: '1:S', lon: 0, lat: 0, bearing: 90,
    distanceAlong: 1000, speedMps: 10, timestamp: T0 / 1000, source: 'realtime', ...over,
  };
}

function setup() {
  const a = new VehicleAnimator();
  a.setShape('1:S', coords, '#1f6feb');
  return a;
}

describe('VehicleAnimator', () => {
  it('ignora veículos de shapes que não estão no mapa', () => {
    const a = setup();
    a.upsert(update({ shapeId: '1:OUTRO' }), T0);
    expect(a.size).toBe(0);
  });

  it('anda continuamente entre leituras de GPS (sem esperar a próxima)', () => {
    const a = setup();
    a.upsert(update(), T0);
    const positions: number[] = [];
    for (let t = 0; t <= 5000; t += 250) {
      a.frame(T0 + t);
      positions.push(a.displayDistance('V1')!);
    }
    for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!);
    expect(positions.at(-1)!).toBeGreaterThan(1030); // avançou ~ 10 m/s × 5 s (com suavização)
    expect(positions.at(-1)!).toBeLessThan(1055);
  });

  it('corrige a posição suavemente quando o GPS discorda da estimativa (sem teleporte)', () => {
    const a = setup();
    a.upsert(update(), T0);
    a.frame(T0);
    a.frame(T0 + 5000);
    const before = a.displayDistance('V1')!;
    // GPS diz que o ônibus estava 80 m atrás do previsto (parou num semáforo)
    a.upsert(update({ distanceAlong: 970, speedMps: 0, timestamp: T0 / 1000 + 5 }), T0 + 5000);
    a.frame(T0 + 5100);
    const next = a.displayDistance('V1')!;
    expect(Math.abs(next - before)).toBeLessThan(15); // um quadro move pouco
    for (let t = 5100; t <= 9000; t += 100) a.frame(T0 + t);
    expect(Math.abs(a.displayDistance('V1')! - 970)).toBeLessThan(2); // converge para o GPS
  });

  it('marca como estimado sem GPS e remove após o limite de dead reckoning', () => {
    const a = setup();
    a.upsert(update(), T0);
    expect(a.frame(T0 + 1000).features[0]!.properties).toMatchObject({ stale: false, opacity: 1, icon: busIconId('#1f6feb') });
    expect(a.frame(T0 + 90_000).features[0]!.properties.stale).toBe(true);
    expect(a.frame(T0 + 301_000).features).toHaveLength(0);
  });

  it('não ultrapassa o fim da linha', () => {
    const a = setup();
    a.upsert(update({ distanceAlong: 5200, speedMps: 15 }), T0);
    for (let t = 0; t < 60_000; t += 1000) a.frame(T0 + t);
    const f = a.frame(T0 + 60_000).features[0]!;
    expect(f.geometry.coordinates[0]).toBeCloseTo(-49.25, 3);
  });
});
