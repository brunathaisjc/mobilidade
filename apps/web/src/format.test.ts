import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, formatWait } from './format';

describe('formatação', () => {
  it('duração', () => {
    expect(formatDuration(59)).toBe('1 min');
    expect(formatDuration(38 * 60)).toBe('38 min');
    expect(formatDuration(65 * 60)).toBe('1 h 05 min');
  });
  it('distância em padrão brasileiro', () => {
    expect(formatDistance(430)).toBe('430 m');
    expect(formatDistance(7810)).toBe('7,8 km');
  });
  it('espera', () => {
    expect(formatWait(30)).toBe('chegando');
    expect(formatWait(301)).toBe('em 5 min');
  });
});
