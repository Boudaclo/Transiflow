import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { getUser } from '../lib/session';
import { loginAs, mockFetch, resetWorld } from './helpers';

afterEach(resetWorld);
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
const menu = () => within_nav('Espaces').map((a) => a.textContent);
function within_nav(label: string): HTMLElement[] {
  const nav = screen.getByRole('navigation', { name: label });
  return Array.from(nav.querySelectorAll('a'));
}

describe('gardes de routes et menu', () => {
  it('un caissier qui tape /administration voit « Accès refusé » et n\'a pas ce lien dans le menu', async () => {
    loginAs(['caissier']);
    mockFetch();
    renderAt('/administration');
    expect(await screen.findByText('Accès refusé')).toBeTruthy();
    expect(menu().join('|')).toContain('Billetterie');
    expect(menu().join('|')).not.toContain('Administration');
  });

  it('un contrôleur ne peut pas ouvrir la billetterie par lien direct', async () => {
    loginAs(['controleur']);
    mockFetch();
    renderAt('/billetterie');
    expect(await screen.findByText('Accès refusé')).toBeTruthy();
  });

  it('le directeur voit son menu, sans les modules de la phase 2', async () => {
    loginAs(['directeur']);
    mockFetch();
    renderAt('/administration');
    await waitFor(() => expect(menu().join('|')).toContain('Administration'));
    const labels = menu().join('|');
    for (const l of ['Tableau de bord', 'Billetterie', 'Contrôle', 'Lignes et départs', 'Clients']) expect(labels).toContain(l);
    for (const l of ['Flotte', 'Personnel', 'Finance', 'Rapports']) expect(labels).not.toContain(l);
  });

  it('sans session, on est renvoyé vers la connexion', async () => {
    mockFetch();
    renderAt('/billetterie');
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeTruthy();
  });

  it('URL inconnue : page introuvable (pas d\'écran blanc)', async () => {
    loginAs(['directeur']);
    mockFetch();
    renderAt('/nimporte-quoi');
    expect(await screen.findByText('Page introuvable')).toBeTruthy();
  });

  it('le bandeau d\'état réseau est visible en permanence', async () => {
    loginAs(['caissier']);
    mockFetch();
    renderAt('/clients');
    expect((await screen.findByTestId('netbar')).textContent).toContain('En ligne');
  });
});

describe('connexion', () => {
  const user = { id: 'u', email: 'c@x.bf', fullName: 'Caissier Test', tenantId: 't', roles: ['caissier'], permissions: [] };
  const type = (email: string, pw: string) => {
    fireEvent.change(screen.getByLabelText('Adresse email'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: pw } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
  };

  it('identifiants faux : message clair', async () => {
    mockFetch((r) => (r.url.endsWith('/auth/login') ? { status: 401, body: { message: 'Identifiants invalides' } } : undefined));
    renderAt('/connexion');
    type('c@x.bf', 'mauvais');
    expect((await screen.findByRole('alert')).textContent).toContain('Email ou mot de passe incorrect');
  });

  it('compte verrouillé : le verrouillage temporaire est affiché', async () => {
    mockFetch((r) => (r.url.endsWith('/auth/login') ? { status: 423, body: { message: 'Compte temporairement verrouillé. Réessayez plus tard.' } } : undefined));
    renderAt('/connexion');
    type('c@x.bf', 'x');
    expect((await screen.findByRole('alert')).textContent).toContain('Compte verrouillé');
  });

  it('succès : redirection vers l\'espace du rôle (caissier → /billetterie)', async () => {
    mockFetch(
      (r) => (r.url.endsWith('/auth/login') ? { body: { accessToken: 'a', refreshToken: 'r', expiresIn: 900, user } } : undefined),
    );
    renderAt('/connexion');
    type('c@x.bf', 'MotDePasse#2026');
    expect(await screen.findByRole('heading', { name: 'Billetterie' })).toBeTruthy();
    expect(getUser()?.roles).toEqual(['caissier']);
  });

  it('afficher / masquer le mot de passe, et aide « Contacter l\'administrateur » (pas d\'inscription, pas de Google)', async () => {
    mockFetch();
    renderAt('/connexion');
    const pw = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    expect(pw.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));
    expect(pw.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: "Contacter l'administrateur" }));
    expect(screen.getByText(/créés par l'administrateur/)).toBeTruthy();
    expect(screen.queryByText(/Google/i)).toBeNull();
    expect(screen.queryByText(/S'inscrire|Créer un compte/i)).toBeNull();
  });
});
