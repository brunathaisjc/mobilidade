import { describe, expect, it } from 'vitest';
import { progressAlong, unitHash } from './simulator.js';

describe('simulador', () => {
  const stops = [{ dist: 0, offset: 0 }, { dist: 500, offset: 100 }, { dist: 1500, offset: 300 }];
  it('interpola a posição ao longo do padrão pelo tempo decorrido', () => {
    expect(progressAlong(stops, 50)).toBe(250);
    expect(progressAlong(stops, 200)).toBe(1000);
    expect(progressAlong(stops, -1)).toBeNull();
    expect(progressAlong(stops, 301)).toBeNull();
  });
  it('hash determinístico em [0,1)', () => {
    expect(unitHash('a')).toBe(unitHash('a'));
    expect(unitHash('a')).toBeGreaterThanOrEqual(0);
    expect(unitHash('a')).toBeLessThan(1);
  });
});
