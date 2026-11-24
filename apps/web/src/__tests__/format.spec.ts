import { describe, expect, it } from 'vitest';
import { formatFcfa, formatInt, formatPercent, toInputDate } from '../lib/format';

describe('formats', () => {
  it('FCFA : entiers, espaces insécables, jamais de décimales', () => {
    expect(formatFcfa(6500)).toBe('6\u202f500\u00a0FCFA');
    expect(formatFcfa(1234567)).toBe('1\u202f234\u202f567\u00a0FCFA');
    expect(formatFcfa(0)).toBe('0\u00a0FCFA');
    expect(formatFcfa(1999.6)).toBe('2\u202f000\u00a0FCFA');
    expect(formatFcfa(6500)).not.toMatch(/[.,]\d/);
  });
  it('entiers et pourcentages', () => {
    expect(formatInt(12000)).toBe('12\u202f000');
    expect(formatPercent(0.734)).toBe('73\u00a0%');
  });
  it('date de champ en heure locale', () => {
    expect(toInputDate(new Date(2026, 10, 5))).toBe('2026-11-05');
  });
});
