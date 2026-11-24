import { describe, expect, it } from 'vitest';
import { scanToDisplay } from '../lib/scan';

describe('résultat de scan → affichage', () => {
  it('valide : vert avec trajet et places', () => {
    const d = scanToDisplay('valide', { number: 42, seats: 2, from: 'Ouagadougou', to: 'Bobo-Dioulasso' });
    expect(d).toMatchObject({ tone: 'ok', valid: true, title: 'Valide' });
    expect(d.detail).toContain('Ouagadougou → Bobo-Dioulasso');
    expect(d.detail).toContain('2 places');
  });
  it('déjà utilisé : rouge avec l\'heure de la première validation', () => {
    const d = scanToDisplay('deja_valide', { number: 7, seats: 1 }, '2026-11-20T08:15:00.000Z');
    expect(d).toMatchObject({ tone: 'bad', valid: false, title: 'Déjà utilisé' });
    expect(d.detail).toMatch(/Première validation à \d{2}:\d{2}/);
  });
  it('mauvais départ : orange', () => {
    expect(scanToDisplay('mauvais_depart', { number: 7, seats: 1, departureAt: '2026-11-20T10:00:00.000Z' })).toMatchObject({ tone: 'warn', valid: false, title: 'Mauvais départ' });
  });
  it.each(['signature_invalide', 'inconnu', 'illisible'])('%s : rouge « Faux ticket / non reconnu »', (r) => {
    expect(scanToDisplay(r)).toMatchObject({ tone: 'bad', valid: false, title: 'Faux ticket / non reconnu' });
  });
  it('billet annulé : rouge', () => {
    expect(scanToDisplay('annule', { number: 3, seats: 1 })).toMatchObject({ tone: 'bad', title: 'Ticket annulé' });
  });
  it('valide sous réserve (hors ligne) : le dit', () => {
    expect(scanToDisplay('valide', { number: 3, seats: 1 }, undefined, true).sub).toContain('à confirmer');
  });
});
