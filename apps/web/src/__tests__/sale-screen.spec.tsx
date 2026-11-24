import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OfflineEngine } from '@transport/offline';
import { decodeTicketQr } from '@transport/shared';
import { __setEngineFactory } from '../lib/poste';
import { setOnline } from '../lib/connectivity';
import { App } from '../App';
import { IDS, fakeServer, preparedEngine } from './fakes';
import { loginAs, mockFetch, resetWorld } from './helpers';

afterEach(() => { resetWorld(); });
const renderPage = () => render(<MemoryRouter initialEntries={['/billetterie']}><App /></MemoryRouter>);
const buttonNamed = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const priceReady = () => waitFor(() => expect(norm(screen.getByTestId('price').textContent)).toBe('6 500 FCFA'));
const norm = (s: string | null) => (s ?? '').replace(/[\u202f\u00a0]/g, ' ');

describe('Vente rapide', () => {
  it('affiche le prix calculé en grand, avec ligne, horaire et arrêts par défaut', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `t-${Math.random()}` }));
    mockFetch();
    renderPage();
    await priceReady(); // premier → dernier arrêt, 1 place, plein tarif
    fireEvent.click(buttonNamed('Une place de plus'));
    expect(norm(screen.getByTestId('price').textContent)).toBe('13 000 FCFA');
    expect(screen.getByTestId('seats').textContent).toBe('2');
    fireEvent.click(buttonNamed('Une place de moins'));
    fireEvent.click(buttonNamed('Une place de moins')); // jamais moins d'une place
    expect(screen.getByTestId('seats').textContent).toBe('1');
  });

  it('mobile money : « Encaisser » reste bloqué tant que la référence manque', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `t-${Math.random()}` }));
    mockFetch();
    renderPage();
    await priceReady();
    expect(buttonNamed('Encaisser').disabled).toBe(false);
    fireEvent.click(buttonNamed('Orange Money'));
    expect(buttonNamed('Encaisser').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Référence de la transaction'), { target: { value: 'OM-883201' } });
    expect(buttonNamed('Encaisser').disabled).toBe(false);
  });

  it('en ligne : envoie la vente (UUID du poste, jamais de tenant_id) et affiche le ticket avec son QR', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `t-${Math.random()}` }));
    const { calls } = mockFetch((r) => (r.method === 'POST' && r.url.endsWith('/billetterie/ventes')
      ? { status: 201, body: { id: (r.body as { ticketId: string }).ticketId, number: 101, qr: 'Q'.repeat(190), seats: 2, total: 13000, category: 'plein_tarif', soldAt: new Date().toISOString(), trip: { lineName: 'Ouagadougou – Bobo-Dioulasso', departureAt: new Date().toISOString() }, from: { name: 'Ouagadougou' }, to: { name: 'Bobo-Dioulasso' }, payment: { method: 'especes' } } }
      : undefined));
    renderPage();
    await priceReady();
    fireEvent.click(buttonNamed('Une place de plus'));
    fireEvent.click(buttonNamed('Encaisser'));
    expect(await screen.findByTestId('ticket-screen')).toBeTruthy();
    expect(screen.getAllByText('N° 101').length).toBeGreaterThan(0); // écran + ticket imprimable
    expect(screen.getAllByTestId('qr').length).toBeGreaterThan(0);
    const sale = calls.find((c) => c.url.endsWith('/billetterie/ventes'))!;
    expect(sale.body).toMatchObject({ tripId: IDS.trip, fromStopId: IDS.a, toStopId: IDS.c, seats: 2, category: 'plein_tarif', payment: { method: 'especes' } });
    expect((sale.body as { ticketId: string }).ticketId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(sale.body)).not.toContain('tenant');
    // « Nouvelle vente » revient au formulaire
    fireEvent.click(screen.getByRole('button', { name: /Nouvelle vente/ }));
    expect(await screen.findByTestId('price')).toBeTruthy();
  });

  it('coupure pendant l\'encaissement : on ne vend pas deux fois en silence, on propose de réessayer (même UUID)', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `t-${Math.random()}` }));
    const m = mockFetch();
    renderPage();
    await priceReady();
    m.net.down = true;
    fireEvent.click(buttonNamed('Encaisser'));
    expect(await screen.findByText(/La vente a peut-être été enregistrée/, {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    const ids = new Set(m.calls.filter((c) => c.url.endsWith('/billetterie/ventes')).map((c) => (c.body as { ticketId: string }).ticketId));
    expect(ids.size).toBe(1); // tous les essais portent le même identifiant : le serveur ne crée qu'une vente
  }, 15000);

  it('hors ligne avec un poste actif : vente locale signée, numéro de la plage, rien envoyé au serveur', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('actif');
    const engine = await preparedEngine('vente', server);
    __setEngineFactory(() => engine);
    const { calls, net } = mockFetch();
    net.down = true;
    setOnline(false);
    renderPage();
    await priceReady();
    fireEvent.click(buttonNamed('Encaisser'));
    expect(await screen.findByTestId('ticket-screen')).toBeTruthy();
    expect(screen.getAllByText('N° 1').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sera envoyée au serveur/)).toBeTruthy();
    expect(calls.filter((c) => c.url.includes('/billetterie/ventes'))).toHaveLength(0);
    const st = await engine.status();
    expect(st.pendingSales).toBe(1);
    const [sale] = await engine.listSales();
    expect(decodeTicketQr(sale!.qr)).toBeTruthy();
    // le bandeau le dit
    await waitFor(() => expect(screen.getByTestId('netbar').textContent).toMatch(/Hors ligne.*1 élément en attente/));
  });

  it('hors ligne sans poste activé : la vente est bloquée avec une explication', async () => {
    loginAs(['caissier'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    const engine = new OfflineEngine({ transport: server.transport, dbName: `t-${Math.random()}` });
    await engine.init('P', 'vente'); await engine.refreshReference();
    __setEngineFactory(() => engine);
    mockFetch().net.down = true;
    setOnline(false);
    renderPage();
    await priceReady();
    expect(await screen.findByText(/pas encore activé/)).toBeTruthy();
    expect(buttonNamed('Encaisser').disabled).toBe(true);
  });
});
