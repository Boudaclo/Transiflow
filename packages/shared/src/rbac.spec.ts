import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, dashboardQuery, permissionsFor } from './index';

const has = (role: (typeof ROLES)[number], p: (typeof PERMISSIONS)[number]) => ROLE_PERMISSIONS[role].includes(p);

describe('matrice des droits (PRD §3.7)', () => {
  it('définit tous les rôles, avec des permissions connues', () => {
    for (const r of ROLES) {
      expect(ROLE_PERMISSIONS[r]).toBeDefined();
      for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
    }
  });
  it('réserve la plateforme au super-admin et l\'administration au directeur', () => {
    for (const r of ROLES) {
      expect(has(r, 'plateforme:administrer')).toBe(r === 'super_admin');
      expect(has(r, 'administration:administrer')).toBe(r === 'directeur');
    }
  });
  it('respecte les lignes « vendre » et « valider »', () => {
    expect(['directeur', 'caissier'].every((r) => has(r as never, 'billetterie:vendre'))).toBe(true);
    expect(has('controleur', 'billetterie:vendre')).toBe(false);
    expect(has('controleur', 'controle:valider')).toBe(true);
    expect(has('caissier', 'controle:valider')).toBe(false);
  });
  it('réserve l\'annulation d\'un billet au directeur', () => {
    for (const r of ROLES) expect(has(r, 'billetterie:annuler')).toBe(r === 'directeur');
  });
  it('respecte clients, lignes, flotte et finance', () => {
    expect(has('controleur', 'clients:lire')).toBe(true);
    expect(has('controleur', 'clients:ecrire')).toBe(false);
    expect(has('comptable', 'clients:lire')).toBe(true);
    expect(has('caissier', 'lignes:ecrire')).toBe(false);
    expect(has('exploitation', 'lignes:ecrire')).toBe(true);
    expect(has('exploitation', 'flotte:ecrire')).toBe(false);
    expect(has('flotte', 'flotte:ecrire')).toBe(true);
    expect(has('flotte', 'finance:lire')).toBe(false);
    expect(has('comptable', 'finance:ecrire')).toBe(true);
  });
  it('fusionne les droits de plusieurs rôles', () => {
    expect(permissionsFor(['caissier', 'controleur'])).toEqual(expect.arrayContaining(['billetterie:vendre', 'controle:valider']));
  });
});

describe('requête du tableau de bord', () => {
  it('refuse les dates impossibles sans planter, accepte les dates valides', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', 'hier', '2026-1-1', '']) {
      expect(dashboardQuery.safeParse({ from: bad }).success).toBe(false);
    }
    expect(dashboardQuery.safeParse({ from: '2028-02-29', to: '2028-03-01' }).success).toBe(true); // année bissextile
    expect(dashboardQuery.safeParse({ from: '2027-02-29' }).success).toBe(false);
    expect(dashboardQuery.parse({}).granularity).toBe('jour');
  });
});
