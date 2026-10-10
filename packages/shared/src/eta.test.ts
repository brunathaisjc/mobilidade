import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEED_MPS, DWELL_PER_STOP_S, MAX_DEAD_RECKONING_S, clampSpeed, etaToStop,
  gtfsTimeToSeconds, projectVehicle, scheduledRunTime, secondsToGtfsTime, smoothSpeed,
} from './eta.js';
import { colorForIndex, ITINERARY_PALETTE } from './colors.js';

const now = 1_760_000_000;

describe('etaToStop', () => {
  it('usa GPS recente como fonte realtime', () => {
    const r = etaToStop({ distanceAlong: 1000, speedMps: 10, timestamp: now - 5 }, 2000, 2, now);
    expect(r).toEqual({ seconds: 100 + 2 * DWELL_PER_STOP_S - 5, source: 'realtime' });
  });

  it('aplica dead reckoning quando o GPS está desatualizado', () => {
    const r = etaToStop({ distanceAlong: 1000, speedMps: 10, timestamp: now - 90 }, 2500, 0, now);
    expect(r?.source).toBe('estimated');
    expect(r?.seconds).toBe(60); // andou 900 m estimados; faltam 600 m a 10 m/s
  });

  it('descarta veículos sem sinal há mais que o limite', () => {
    expect(etaToStop({ distanceAlong: 0, speedMps: 8, timestamp: now - MAX_DEAD_RECKONING_S - 1 }, 500, 0, now)).toBeNull();
  });

  it('descarta veículo que já passou do ponto, mas tolera erro de GPS', () => {
    expect(etaToStop({ distanceAlong: 2100, speedMps: 8, timestamp: now }, 2000, 0, now)).toBeNull();
    expect(etaToStop({ distanceAlong: 2020, speedMps: 8, timestamp: now }, 2000, 0, now)?.seconds).toBe(0);
  });
});

describe('scheduledRunTime', () => {
  const stops = [{ dist: 0, offset: 0 }, { dist: 500, offset: 100 }, { dist: 1500, offset: 300 }];
  it('interpola entre pontos', () => {
    expect(scheduledRunTime(stops, 250, 1000)).toBe(150);
    expect(scheduledRunTime(stops, 0, 1500)).toBe(300);
  });
  it('ETA usa o tempo programado a partir da posição real', () => {
    const r = etaToStop({ distanceAlong: 250, speedMps: 1, timestamp: now - 10 }, 1500, 2, now,
      (a, b) => scheduledRunTime(stops, a, b));
    expect(r).toEqual({ seconds: 250 - 10, source: 'realtime' });
  });
});

describe('velocidade', () => {
  it('usa padrão quando não há velocidade e limita extremos', () => {
    expect(clampSpeed(null)).toBe(DEFAULT_SPEED_MPS);
    expect(clampSpeed(0.1)).toBeGreaterThan(2);
    expect(clampSpeed(50)).toBeLessThanOrEqual(16);
  });

  it('suaviza com EWMA e ignora amostras absurdas (salto de GPS)', () => {
    expect(smoothSpeed(null, 10)).toBe(10);
    expect(smoothSpeed(10, 20)).toBeCloseTo(13);
    expect(smoothSpeed(10, 80)).toBe(10);
  });

  it('projectVehicle mantém posição dentro da janela de frescor', () => {
    expect(projectVehicle({ distanceAlong: 10, speedMps: 5, timestamp: now - 30 }, now)).toEqual({ distanceAlong: 10, source: 'realtime' });
  });
});

describe('horários GTFS', () => {
  it('aceita horários após meia-noite do dia de serviço', () => {
    expect(gtfsTimeToSeconds('25:10:00')).toBe(25 * 3600 + 600);
    expect(secondsToGtfsTime(90_610)).toBe('25:10:10');
  });
  it('rejeita formato inválido', () => {
    expect(() => gtfsTimeToSeconds('7h30')).toThrow();
  });
});

describe('cores', () => {
  it('atribui cores distintas para até 10 itinerários e tracejado depois', () => {
    const colors = Array.from({ length: ITINERARY_PALETTE.length }, (_, i) => colorForIndex(i).color);
    expect(new Set(colors).size).toBe(ITINERARY_PALETTE.length);
    expect(colorForIndex(ITINERARY_PALETTE.length).dashed).toBe(true);
  });
});
