import { describe, expect, it } from 'vitest';
import { MeasuredLine, type LngLat } from '@mobigo/shared';
import { VehicleTracker, type TrackerData } from './tracker.js';

// Linha reta leste-oeste de ~4,3 km com ida (S0) e volta (S1) sobrepostas
const coords: LngLat[] = Array.from({ length: 41 }, (_, i) => [-49.30 + i * 0.001, -16.67]);
const shapes: Record<string, MeasuredLine> = {
  S0: new MeasuredLine(coords),
  S1: new MeasuredLine([...coords].reverse()),
};
const data: TrackerData = {
  feedId: 1,
  trip: (id) => (id === 'T0' ? { routeId: 'R', shapeId: 'S0' } : id === 'T1' ? { routeId: 'R', shapeId: 'S1' } : undefined),
  routeShapes: () => ['S0', 'S1'],
  shape: (id) => shapes[id],
};
const at = (lonOffset: number, latNoiseM = 0): { lon: number; lat: number } => ({
  lon: -49.30 + lonOffset,
  lat: -16.67 + latNoiseM / 111_320,
});

describe('VehicleTracker', () => {
  it('projeta o GPS ruidoso na via e publica IDs prefixados pelo feed', () => {
    const t = new VehicleTracker(data);
    const u = t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.005, 25), timestamp: 100 })!;
    expect(u.lat).toBeCloseTo(-16.67, 5);
    expect(u.distanceAlong).toBeGreaterThan(520);
    expect(u.distanceAlong).toBeLessThan(550);
    expect(u).toMatchObject({ routeId: '1:R', tripId: '1:T0', shapeId: '1:S0', source: 'realtime' });
  });

  it('descarta leituras fora da via, duplicadas e saltos impossíveis', () => {
    const t = new VehicleTracker(data);
    expect(t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.005), timestamp: 100 })).not.toBeNull();
    expect(t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.006, 400), timestamp: 105 })).toBeNull(); // 400 m fora
    expect(t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.006), timestamp: 100 })).toBeNull(); // repetida
    expect(t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.015), timestamp: 110 })).toBeNull(); // ~1 km em 10 s
    expect(t.rejected).toMatchObject({ off_route: 1, stale: 1, jump: 1 });
  });

  it('não deixa o ônibus andar para trás por jitter e suaviza a velocidade', () => {
    const t = new VehicleTracker(data);
    const a = t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.010), timestamp: 100 })!;
    const b = t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.0098), timestamp: 105 })!; // recuo de ~21 m
    expect(b.distanceAlong).toBe(a.distanceAlong);
    const c = t.process({ vehicleId: 'V', tripId: 'T0', ...at(0.0105), timestamp: 115 })!;
    expect(c.distanceAlong).toBeGreaterThan(a.distanceAlong);
    expect(c.speedMps).toBeGreaterThan(0);
  });

  it('sem trip_id, infere o sentido pelo movimento em vias de ida e volta sobrepostas', () => {
    const t = new VehicleTracker(data);
    // Ônibus andando para OESTE (sentido S1)
    t.process({ vehicleId: 'X', routeId: 'R', ...at(0.030), timestamp: 100 });
    t.process({ vehicleId: 'X', routeId: 'R', ...at(0.028), timestamp: 110 });
    const u = t.process({ vehicleId: 'X', routeId: 'R', ...at(0.026), timestamp: 120 })!;
    expect(u.shapeId).toBe('1:S1');
    expect(u.tripId).toBe('1:inferred:R:X');
  });

  it('recusa viagens desconhecidas', () => {
    const t = new VehicleTracker(data);
    expect(t.process({ vehicleId: 'V', tripId: 'NAO-EXISTE', ...at(0.01), timestamp: 1 })).toBeNull();
    expect(t.rejected.unknown_trip).toBe(1);
  });
});
