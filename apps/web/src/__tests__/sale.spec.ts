import { describe, expect, it } from 'vitest';
import type { CatalogResponse } from '@transport/offline';
import { categoriesFor, clampSeats, defaultTrip, findFare, remainingSeats, sellableTrips } from '../lib/sale';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60000).toISOString();
const catalog: CatalogResponse = {
  serverTime: at(0),
  lines: [{ id: 'L1', code: 'OUA-BOB', name: 'Ouaga – Bobo', stops: [{ id: 'A', name: 'Ouagadougou', position: 1 }, { id: 'B', name: 'Koudougou', position: 2 }, { id: 'C', name: 'Bobo-Dioulasso', position: 3 }],
    fares: [{ fromStopId: 'A', toStopId: 'C', category: 'plein_tarif', price: 6500 }, { fromStopId: 'A', toStopId: 'B', category: 'plein_tarif', price: 2000 }] }],
  trips: [
    { id: 'T0', lineId: 'L1', lineCode: 'OUA-BOB', departureAt: at(-120), seats: 50, status: 'actif', sold: 0 },
    { id: 'T1', lineId: 'L1', lineCode: 'OUA-BOB', departureAt: at(-10), seats: 50, status: 'actif', sold: 0 },
    { id: 'T2', lineId: 'L1', lineCode: 'OUA-BOB', departureAt: at(60), seats: 10, status: 'actif', sold: 10 },
    { id: 'T3', lineId: 'L1', lineCode: 'OUA-BOB', departureAt: at(120), seats: 50, status: 'annule', sold: 0 },
    { id: 'T4', lineId: 'L1', lineCode: 'OUA-BOB', departureAt: at(180), seats: 50, status: 'retarde', sold: 5 },
  ],
};

describe('vente rapide : règles de choix', () => {
  it('seuls les départs vendables sont proposés (ni annulés, ni partis depuis plus de 30 min)', () => {
    expect(sellableTrips(catalog, 'L1', NOW).map((t) => t.id)).toEqual(['T1', 'T2', 'T4']);
  });
  it('le prochain horaire par défaut est le premier à venir qui a des places', () => {
    const trips = sellableTrips(catalog, 'L1', NOW);
    expect(defaultTrip(trips, {}, NOW)?.id).toBe('T4'); // T2 est complet
  });
  it('les ventes locales en attente réduisent les places restantes', () => {
    expect(remainingSeats(catalog.trips[4]!, 0)).toBe(45);
    expect(remainingSeats(catalog.trips[4]!, 40)).toBe(5);
    expect(remainingSeats(catalog.trips[4]!, 99)).toBe(0);
  });
  it('tarif par trajet et catégorie', () => {
    const line = catalog.lines[0];
    expect(findFare(line, 'A', 'C')?.price).toBe(6500);
    expect(findFare(line, 'B', 'C')).toBeUndefined();
    expect(findFare(line, 'A', 'C', 'enfant')).toBeUndefined();
    expect(categoriesFor(line, 'A', 'C')).toEqual(['plein_tarif']);
  });
  it('le nombre de places reste entre 1, le maximum par vente et les places restantes', () => {
    expect(clampSeats(0, 5)).toBe(1);
    expect(clampSeats(9, 3)).toBe(3);
    expect(clampSeats(50, 100)).toBe(10);
  });
});
