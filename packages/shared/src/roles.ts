export const ROLES = [
  'super_admin',
  'directeur',
  'caissier',
  'controleur',
  'exploitation',
  'flotte',
  'comptable',
  'chauffeur',
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
