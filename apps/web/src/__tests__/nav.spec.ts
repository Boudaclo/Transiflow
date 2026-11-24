import { describe, expect, it } from 'vitest';
import { ROLES, Role, permissionsFor } from '@transport/shared';
import { can, mainSpaceFor, visibleSpaces } from '../lib/nav';

const user = (...roles: Role[]) => ({ roles, permissions: permissionsFor(roles) });
const paths = (...roles: Role[]) => visibleSpaces(user(...roles)).map((s) => s.path);

describe('menu et espace d\'arrivée selon le rôle', () => {
  it('le caissier voit Billetterie, Clients et Lignes (lecture), pas le contrôle ni l\'administration', () => {
    expect(paths('caissier')).toEqual(['/billetterie', '/lignes', '/clients']);
    expect(mainSpaceFor(user('caissier'))).toBe('/billetterie');
  });
  it('le contrôleur arrive sur /controle', () => {
    expect(paths('controleur')).toContain('/controle');
    expect(paths('controleur')).not.toContain('/billetterie');
    expect(mainSpaceFor(user('controleur'))).toBe('/controle');
  });
  it('le directeur arrive sur le tableau de bord et voit l\'administration', () => {
    expect(mainSpaceFor(user('directeur'))).toBe('/tableau-de-bord');
    expect(paths('directeur')).toEqual(expect.arrayContaining(['/tableau-de-bord', '/billetterie', '/controle', '/lignes', '/clients', '/administration']));
  });
  it('l\'exploitation arrive sur /lignes ; le comptable sur le tableau de bord', () => {
    expect(mainSpaceFor(user('exploitation'))).toBe('/lignes');
    expect(mainSpaceFor(user('comptable'))).toBe('/tableau-de-bord');
  });
  it('le super-administrateur ne voit que les compagnies', () => {
    expect(paths('super_admin')).toEqual(['/compagnies']);
    expect(mainSpaceFor(user('super_admin'))).toBe('/compagnies');
  });
  it('les espaces de la phase 2 ne sont jamais dans le menu, même pour le directeur', () => {
    for (const r of ROLES) for (const p of paths(r)) expect(['/flotte', '/personnel', '/finance', '/rapports']).not.toContain(p);
  });
  it('le responsable de flotte n\'a aucun espace livré : page d\'accueil neutre', () => {
    expect(paths('flotte')).toEqual([]);
    expect(mainSpaceFor(user('flotte'))).toBe('/accueil');
  });
  it('can() suit la matrice de droits', () => {
    expect(can(user('caissier'), 'billetterie:vendre')).toBe(true);
    expect(can(user('caissier'), 'administration:administrer')).toBe(false);
    expect(can(null, 'billetterie:lire')).toBe(false);
  });
});
