import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { loginAs, mockFetch, resetWorld } from './helpers';

afterEach(resetWorld);
const at = (p: string) => render(<MemoryRouter initialEntries={[p]}><App /></MemoryRouter>);
const norm = (s: string | null) => (s ?? '').replace(/[\u202f\u00a0]/g, ' ');
const dash = {
  period: { from: '2026-10-22', to: '2026-11-20', days: 30, granularity: 'jour', lineId: null },
  totals: { tickets: 3, seats: 4, revenue: 19500, cancelledTickets: 1, cancelledAmount: 6500, toVerifyTickets: 1, toVerifyAmount: 6500, offlineTickets: 1, offlineRevenue: 6500, averageTicket: 6500 },
  previous: { revenue: 10000, tickets: 2, revenueEvolutionPct: 95, ticketsEvolutionPct: 50 },
  series: [{ date: '2026-11-19', tickets: 1, seats: 1, revenue: 6500 }, { date: new Date().toISOString().slice(0, 10), tickets: 2, seats: 3, revenue: 13000 }],
  fill: { trips: 4, capacity: 200, soldSeats: 4, ratePct: 2 },
  lines: [{ lineId: 'L1', code: 'OUA-BOB', name: 'Ouaga – Bobo', revenue: 13000, tickets: 2, fillRatePct: 3 }, { lineId: 'L2', code: 'OUA-KDG', name: 'Ouaga – Koudougou', revenue: 6500, tickets: 1, fillRatePct: 1 }],
  byPaymentMethod: [{ method: 'especes', tickets: 2, revenue: 13000, toVerifyAmount: 0 }, { method: 'orange_money', tickets: 1, revenue: 6500, toVerifyAmount: 6500 }],
};

describe('Tableau de bord', () => {
  it('affiche les cartes, les lignes et le détail du paiement à vérifier avec les chiffres du serveur', async () => {
    loginAs(['directeur']);
    mockFetch((r) => (r.url.includes('/tableau-de-bord') ? { body: dash } : r.url.includes('/billetterie/tickets') ? { body: { items: [], total: 0, limit: 8, offset: 0 } } : r.url.includes('/anomalies') ? { body: { items: [], total: 0 } } : undefined));
    at('/tableau-de-bord');
    expect(await screen.findByText('Recettes de la période')).toBeTruthy();
    const card = (label: string) => screen.getByText(label).closest('.stat') as HTMLElement;
    expect(norm(card('Recettes de la période').textContent)).toContain('19 500 FCFA');
    expect(norm(card('Recettes du jour').textContent)).toContain('13 000 FCFA');
    expect(norm(card('Tickets vendus').textContent)).toContain('3');
    expect(norm(card('Taux de remplissage').textContent)).toContain('2 %');
    expect(screen.getByText(/1 paiement\(s\) mobile à vérifier/)).toBeTruthy();
    expect(screen.getAllByText('OUA-BOB').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Excel/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /PDF/ })).toBeTruthy();
  });
  it('erreur serveur : message et bouton Réessayer', async () => {
    loginAs(['directeur']);
    mockFetch((r) => (r.url.includes('/tableau-de-bord') ? { status: 500, body: {} } : undefined));
    at('/tableau-de-bord');
    expect(await screen.findByText(/Erreur du serveur/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Réessayer/ })).toBeTruthy();
  });
  it('le comptable (reporting seul) ne voit pas l\'activité de billetterie ni les anomalies et n\'appelle pas ces routes', async () => {
    loginAs(['comptable']);
    const { calls } = mockFetch((r) => (r.url.includes('/tableau-de-bord') ? { body: dash } : undefined));
    at('/tableau-de-bord');
    await screen.findByText('Recettes de la période');
    expect(screen.queryByText('Activité récente')).toBeNull();
    expect(calls.some((c) => c.url.includes('/anomalies') || c.url.includes('/billetterie/tickets'))).toBe(false);
  });
});

describe('Lignes et clients', () => {
  it('le chauffeur voit les lignes en lecture seule (pas de bouton de création)', async () => {
    loginAs(['chauffeur']);
    mockFetch((r) => (r.url.endsWith('/lignes') ? { body: [{ id: 'L1', code: 'OUA-BOB', name: 'Ouaga – Bobo', active: true, stopsCount: 3 }] } : undefined));
    at('/lignes');
    expect(await screen.findByText('Ouaga – Bobo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nouvelle ligne/ })).toBeNull();
  });
  it('l\'exploitation peut créer une ligne ; état vide avec action', async () => {
    loginAs(['exploitation']);
    mockFetch((r) => (r.url.endsWith('/lignes') ? { body: [] } : undefined));
    at('/lignes');
    expect(await screen.findByText('Aucune ligne')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Nouvelle ligne|Créer la première ligne/ }).length).toBeGreaterThan(0);
  });
  it('fiche client : l\'historique est demandé avec le filtre clientId', async () => {
    loginAs(['caissier']);
    const { calls } = mockFetch(
      (r) => (/\/clients\/c1$/.test(r.url) ? { body: { id: 'c1', fullName: 'Awa Ouedraogo', phone: '+22670123456', email: null, createdAt: '2026-11-01T00:00:00Z' } } : undefined),
      (r) => (r.url.includes('/billetterie/tickets') ? { body: { items: [], total: 0, limit: 8, offset: 0 } } : undefined),
    );
    at('/clients/c1');
    expect(await screen.findByRole('heading', { name: 'Awa Ouedraogo' })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/billetterie/tickets') && c.url.includes('clientId=c1'))).toBe(true));
  });
});

describe('Administration', () => {
  const users = [{ id: 'u1', email: 'dir@demo.bf', fullName: 'Directeur Démo', active: true, roles: ['directeur'] }, { id: 'u2', email: 'cai@demo.bf', fullName: 'Caissier Démo', active: true, roles: ['caissier'] }];
  it('journal d\'audit lisible : actions en français et noms des auteurs', async () => {
    loginAs(['directeur']);
    mockFetch(
      (r) => (r.url.endsWith('/users') ? { body: users } : undefined),
      (r) => (r.url.includes('/audit') ? { body: { items: [{ id: 9, userId: 'u1', action: 'ticket.cancelled', objectType: 'ticket', objectId: 'x', before: { status: 'vendu' }, after: { status: 'annule', reason: 'Erreur de saisie' }, createdAt: '2026-11-20T09:00:00Z' }], total: 1, limit: 15, offset: 0 } } : undefined),
    );
    at('/administration?onglet=audit');
    expect(await screen.findByText('Ticket annulé')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Directeur Démo')).toBeTruthy());
    expect(screen.getByText(/Erreur de saisie/)).toBeTruthy();
    expect(screen.getByText(/lecture seule/)).toBeTruthy();
  });
  it('postes : un poste en attente peut être activé', async () => {
    loginAs(['directeur']);
    const { calls } = mockFetch(
      (r) => (r.method === 'GET' && r.url.endsWith('/postes') ? { body: [{ id: 'd1', name: 'Guichet gare', kind: 'vente', status: 'en_attente', lastSeenAt: null, ticketsSynced: 0, rangesReserved: 0, createdAt: '2026-11-20T08:00:00Z', revokeReason: null }] } : undefined),
      (r) => (r.url.endsWith('/postes/d1/activation') ? { body: {} } : undefined),
    );
    at('/administration?onglet=postes');
    fireEvent.click(await screen.findByRole('button', { name: 'Activer' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/postes/d1/activation') && c.method === 'POST')).toBe(true));
  });
  it('mot de passe oublié côté administrateur : nouveau mot de passe envoyé au serveur', async () => {
    loginAs(['directeur']);
    const { calls } = mockFetch(
      (r) => (r.url.endsWith('/users') ? { body: users } : undefined),
      (r) => (r.url.endsWith('/users/u2/mot-de-passe') ? { status: 204, body: undefined } : undefined),
    );
    at('/administration');
    const row = (await screen.findByText('Caissier Démo')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Mot de passe' }));
    const input = await screen.findByLabelText('Nouveau mot de passe');
    fireEvent.change(input, { target: { value: 'NouveauSecret-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/users/u2/mot-de-passe'))?.body).toEqual({ password: 'NouveauSecret-2026' }));
  });
  it('super-administrateur : espace Compagnies, pas d\'accès aux données d\'une compagnie', async () => {
    loginAs(['super_admin'], { tenantId: undefined } as never);
    mockFetch((r) => (r.url.endsWith('/tenants') ? { body: [{ id: 't1', name: 'Compagnie démo A', slug: 'demo-a', active: true, createdAt: '2026-11-01T00:00:00Z' }] } : undefined));
    at('/billetterie');
    expect(await screen.findByText('Accès refusé')).toBeTruthy();
  });
});
