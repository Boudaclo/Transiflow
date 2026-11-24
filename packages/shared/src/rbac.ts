import type { Role } from './roles';

export const PERMISSIONS = [
  'billetterie:lire',
  'billetterie:vendre',
  'billetterie:annuler',
  'controle:lire',
  'controle:valider',
  'clients:lire',
  'clients:ecrire',
  'lignes:lire',
  'lignes:ecrire',
  'flotte:lire',
  'flotte:ecrire',
  'finance:lire',
  'finance:ecrire',
  'reporting:lire',
  'personnel:lire',
  'personnel:ecrire',
  'administration:administrer',
  'plateforme:administrer',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Matrice des droits (PRD §3.7). « Oui » = lire + écrire/agir, « Lecture » = lire.
// Hypothèses hors extrait du PRD : voir DECISIONS.md.
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ['plateforme:administrer'],
  directeur: [
    'billetterie:lire', 'billetterie:vendre', 'billetterie:annuler',
    'controle:lire', 'controle:valider',
    'clients:lire', 'clients:ecrire',
    'lignes:lire', 'lignes:ecrire',
    'flotte:lire', 'flotte:ecrire',
    'finance:lire', 'finance:ecrire',
    'reporting:lire',
    'personnel:lire', 'personnel:ecrire',
    'administration:administrer',
  ],
  caissier: ['billetterie:lire', 'billetterie:vendre', 'clients:lire', 'clients:ecrire', 'lignes:lire'],
  controleur: ['controle:lire', 'controle:valider', 'clients:lire', 'lignes:lire'],
  exploitation: ['lignes:lire', 'lignes:ecrire', 'flotte:lire', 'reporting:lire'],
  flotte: ['flotte:lire', 'flotte:ecrire'],
  comptable: ['clients:lire', 'finance:lire', 'finance:ecrire', 'reporting:lire'],
  chauffeur: ['lignes:lire'],
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return [...out];
}
