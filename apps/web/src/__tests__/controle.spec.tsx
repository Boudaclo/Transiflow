import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OfflineEngine } from '@transport/offline';
import { App } from '../App';
import { __setEngineFactory } from '../lib/poste';
import { setOnline } from '../lib/connectivity';
import { IDS, fakeServer, preparedEngine } from './fakes';
import { loginAs, mockFetch, resetWorld } from './helpers';

// La caméra est remplacée par un bouton qui « présente » le QR courant.
vi.mock('../components/Scanner', () => ({
  Scanner: ({ onCode }: { onCode: (c: string) => void }) => <button type="button" onClick={() => onCode((window as unknown as { __qr: string }).__qr)}>simuler un scan</button>,
}));

afterEach(() => { resetWorld(); vi.restoreAllMocks(); });
const setQr = (q: string) => { (window as unknown as { __qr: string }).__qr = q; };
const renderPage = () => render(<MemoryRouter initialEntries={['/controle']}><App /></MemoryRouter>);
const scan = () => fireEvent.click(screen.getByRole('button', { name: 'simuler un scan' }));
const result = async (title: string) => { const r = await screen.findByTestId('scan-result'); await waitFor(() => expect(r.textContent).toContain(title)); return r; };

describe('Contrôle', () => {
  it('en ligne : valide puis « Déjà utilisé » avec l\'heure de la première validation (réponses du serveur)', async () => {
    loginAs(['controleur'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    let n = 0;
    const { calls } = mockFetch((r) => {
      if (r.url.endsWith('/controle/validations')) {
        n++;
        return n === 1
          ? { body: { result: 'valide', ticket: { number: 55, seats: 2, tripId: IDS.trip, from: 'Ouagadougou', to: 'Koudougou' } } }
          : { body: { result: 'deja_valide', firstValidatedAt: '2026-11-20T08:15:00.000Z', ticket: { number: 55, seats: 2, tripId: IDS.trip } } };
      }
      return undefined;
    });
    // poste non activé : le contrôle en ligne passe par l'API
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `c-${Math.random()}` }));
    renderPage();
    await screen.findByRole('button', { name: 'simuler un scan' });
    setQr('Q'.repeat(190));
    scan();
    const ok = await result('Valide');
    expect(ok.textContent).toContain('Ouagadougou → Koudougou');
    expect(ok.className).toContain('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000); // le même QR, plus tard : deuxième présentation
    scan();
    const ko = await result('Déjà utilisé');
    expect(ko.className).toContain('bad');
    expect(ko.textContent).toMatch(/Première validation à \d{2}:\d{2}/);
    expect(calls.filter((c) => c.url.endsWith('/controle/validations'))).toHaveLength(2);
  });

  it('un refus reste affiché jusqu\'au toucher, un « valide » se referme tout seul', async () => {
    loginAs(['controleur'], { tenantId: IDS.tenant });
    const server = fakeServer('en_attente');
    __setEngineFactory(() => new OfflineEngine({ transport: server.transport, dbName: `c-${Math.random()}` }));
    let first = true;
    mockFetch((r) => {
      if (!r.url.endsWith('/controle/validations')) return undefined;
      const body = first ? { result: 'valide', ticket: { number: 1, seats: 1 } } : { result: 'signature_invalide' };
      first = false;
      return { body };
    });
    renderPage();
    await screen.findByRole('button', { name: 'simuler un scan' });
    setQr('A'.repeat(100)); scan();
    await result('Valide');
    await waitFor(() => expect(screen.queryByTestId('scan-result')).toBeNull(), { timeout: 4000 });
    setQr('B'.repeat(100)); scan();
    const bad = await result('Faux ticket / non reconnu');
    await new Promise((r) => setTimeout(r, 2200));
    expect(screen.getByTestId('scan-result')).toBe(bad); // toujours là
  }, 12000);

  it('HORS LIGNE sur deux postes : vente locale signée → contrôle local valide la 1re fois, refuse la 2e', async () => {
    loginAs(['controleur'], { tenantId: IDS.tenant });
    const server = fakeServer('actif');
    const vente = await preparedEngine('vente', server, 'Guichet');
    const sale = await vente.sellOffline({ tripId: IDS.trip, fromStopId: IDS.a, toStopId: IDS.c, seats: 2, payment: { method: 'especes' } });
    server.publicKeys = [{ id: IDS.signingKey, kind: 'poste', status: 'actif', publicKey: vente.getIdentity()!.publicKey }];
    const ctrl = await preparedEngine('controle', server, 'Quai 1');
    __setEngineFactory(() => ctrl);
    const { calls, net } = mockFetch();
    net.down = true; setOnline(false);
    renderPage();
    await screen.findByRole('button', { name: 'simuler un scan' });
    setQr(sale.qr);
    scan();
    const ok = await result('Valide');
    expect(ok.textContent).toContain('Ticket n° 1');
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    scan();
    const ko = await result('Déjà utilisé');
    expect(ko.className).toContain('bad');
    expect((await ctrl.status()).pendingValidations).toBe(1); // une seule validation à envoyer
    expect(calls.filter((c) => c.url.includes('/controle/validations'))).toHaveLength(0);
    // la saisie manuelle exige le réseau
    expect((screen.getByLabelText('Numéro du ticket') as HTMLInputElement).disabled).toBe(true);
  });

  it('un ticket falsifié est refusé hors ligne', async () => {
    loginAs(['controleur'], { tenantId: IDS.tenant });
    const server = fakeServer('actif');
    const vente = await preparedEngine('vente', server);
    const sale = await vente.sellOffline({ tripId: IDS.trip, fromStopId: IDS.a, toStopId: IDS.c, payment: { method: 'especes' } });
    server.publicKeys = [{ id: IDS.signingKey, kind: 'poste', status: 'actif', publicKey: vente.getIdentity()!.publicKey }];
    const ctrl = await preparedEngine('controle', server);
    __setEngineFactory(() => ctrl);
    mockFetch().net.down = true; setOnline(false);
    renderPage();
    await screen.findByRole('button', { name: 'simuler un scan' });
    const forged = `${sale.qr.slice(0, 40)}${sale.qr[40] === 'A' ? 'B' : 'A'}${sale.qr.slice(41)}`;
    setQr(forged); scan();
    await result('Faux ticket / non reconnu');
  });
});
