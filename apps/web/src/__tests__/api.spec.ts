import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '@transport/offline';
import { api, errorMessage } from '../lib/api';
import { isOnline, ping, setOnline } from '../lib/connectivity';
import { getUser } from '../lib/session';
import { loginAs, mockFetch, resetWorld } from './helpers';

afterEach(resetWorld);
const refreshOk = { status: 200, body: { accessToken: 't2', refreshToken: 'rt2', expiresIn: 900, user: { id: 'u1', email: 'a@b.bf', fullName: 'Awa', tenantId: 't', roles: ['caissier'], permissions: [] } } };

describe('client API', () => {
  it('un 401 déclenche UN renouvellement de jeton (même pour des appels simultanés) puis rejoue les requêtes', async () => {
    loginAs(['caissier']);
    const { calls } = mockFetch(
      (r) => (r.url.endsWith('/auth/refresh') ? refreshOk : undefined),
      (r) => (r.url.includes('/lignes') ? (r.auth === 'Bearer t2' ? { body: [{ id: 'L1' }] } : { status: 401, body: {} }) : undefined),
    );
    const [a, b] = await Promise.all([api.get('/lignes'), api.get('/lignes')]);
    expect(a).toEqual([{ id: 'L1' }]);
    expect(b).toEqual([{ id: 'L1' }]);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('refresh refusé (session perdue) : déconnexion', async () => {
    loginAs(['caissier']);
    mockFetch((r) => (r.url.endsWith('/auth/refresh') ? { status: 401, body: { message: 'x' } } : { status: 401, body: {} }));
    await expect(api.get('/lignes')).rejects.toBeInstanceOf(ApiError);
    expect(getUser()).toBeNull();
  });

  it('coupure réseau : NetworkError, le bandeau passe hors ligne, la session est gardée', async () => {
    loginAs(['caissier']);
    const fetchMock = mockFetch();
    fetchMock.fn.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/lignes')).rejects.toBeInstanceOf(NetworkError);
    expect(isOnline()).toBe(false);
    expect(getUser()).not.toBeNull();
  });

  it('un appel réussi remet l\'état en ligne', async () => {
    loginAs(['caissier']);
    setOnline(false);
    mockFetch(() => ({ body: [] }));
    await api.get('/lignes');
    expect(isOnline()).toBe(true);
  });

  it('le test de connexion distingue Wi-Fi sans Internet (échec) d\'une API qui répond', async () => {
    mockFetch((r) => (r.url.endsWith('/health') ? { body: { status: 'ok' } } : undefined));
    expect(await ping()).toBe(true);
    mockFetch().fn.mockRejectedValue(new TypeError('offline'));
    expect(await ping()).toBe(false);
  });
});

describe('messages d\'erreur en français', () => {
  it.each([
    [new NetworkError('x'), /Réseau indisponible/],
    [new ApiError(403, {}), /pas le droit/],
    [new ApiError(423, {}), /verrouillé/],
    [new ApiError(429, {}), /Trop de tentatives/],
    [new ApiError(500, {}), /Erreur du serveur/],
    [new ApiError(409, { message: 'Cette adresse e-mail est déjà utilisée' }), /déjà utilisée/],
  ])('%#', (e, re) => expect(errorMessage(e)).toMatch(re));
  it('détaille les erreurs de validation du serveur', () => {
    expect(errorMessage(new ApiError(400, { message: 'Données invalides', issues: [{ path: 'phone', message: 'Numéro de téléphone invalide' }] }))).toContain('phone : Numéro de téléphone invalide');
  });
});
