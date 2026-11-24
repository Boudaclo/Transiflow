import type { Permission, Role } from '@transport/shared';
import type { IconName } from '../components/Icon';

export interface Space {
  key: string;
  path: string;
  label: string;
  icon: IconName;
  /** Droit nécessaire pour voir l'espace (même règle que l'API, qui reste seule juge). */
  permission: Permission;
  /** Les espaces de la phase 2 n'apparaissent pas tant que le module n'est pas livré. */
  available: boolean;
}

export const SPACES: readonly Space[] = [
  { key: 'tableau-de-bord', path: '/tableau-de-bord', label: 'Tableau de bord', icon: 'chart', permission: 'reporting:lire', available: true },
  { key: 'billetterie', path: '/billetterie', label: 'Billetterie', icon: 'ticket', permission: 'billetterie:lire', available: true },
  { key: 'controle', path: '/controle', label: 'Contrôle', icon: 'scan', permission: 'controle:lire', available: true },
  { key: 'lignes', path: '/lignes', label: 'Lignes et départs', icon: 'route', permission: 'lignes:lire', available: true },
  { key: 'clients', path: '/clients', label: 'Clients', icon: 'users', permission: 'clients:lire', available: true },
  { key: 'administration', path: '/administration', label: 'Administration', icon: 'settings', permission: 'administration:administrer', available: true },
  { key: 'compagnies', path: '/compagnies', label: 'Compagnies', icon: 'building', permission: 'plateforme:administrer', available: true },
  // Phase 2 : emplacements prévus, entrée de menu masquée.
  { key: 'flotte', path: '/flotte', label: 'Flotte', icon: 'bus', permission: 'flotte:lire', available: false },
  { key: 'personnel', path: '/personnel', label: 'Personnel', icon: 'users', permission: 'personnel:lire', available: false },
  { key: 'finance', path: '/finance', label: 'Finance', icon: 'wallet', permission: 'finance:lire', available: false },
  { key: 'rapports', path: '/rapports', label: 'Rapports détaillés', icon: 'chart', permission: 'reporting:lire', available: false },
];

interface HasAccess { permissions: readonly Permission[] }
export const can = (user: HasAccess | null | undefined, p: Permission): boolean => !!user?.permissions.includes(p);

export function visibleSpaces(user: HasAccess | null | undefined): Space[] {
  return SPACES.filter((s) => s.available && can(user, s.permission));
}

/** Espace d'arrivée après la connexion, selon le rôle principal. */
const LANDING: [Role, string][] = [
  ['super_admin', '/compagnies'],
  ['directeur', '/tableau-de-bord'],
  ['caissier', '/billetterie'],
  ['controleur', '/controle'],
  ['exploitation', '/lignes'],
  ['comptable', '/tableau-de-bord'],
  ['chauffeur', '/lignes'],
];

export function mainSpaceFor(user: (HasAccess & { roles: readonly Role[] }) | null): string {
  if (!user) return '/connexion';
  const allowed = new Set(visibleSpaces(user).map((s) => s.path));
  for (const [role, path] of LANDING) if (user.roles.includes(role) && allowed.has(path)) return path;
  return visibleSpaces(user)[0]?.path ?? '/accueil';
}

export const spaceForPath = (pathname: string): Space | undefined => SPACES.find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
