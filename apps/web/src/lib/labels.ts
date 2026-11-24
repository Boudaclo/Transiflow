import type { Role } from '@transport/shared';

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super-administrateur',
  directeur: 'Directeur',
  caissier: 'Caissier',
  controleur: 'Contrôleur',
  exploitation: "Responsable d'exploitation",
  flotte: 'Responsable de flotte',
  comptable: 'Comptable',
  chauffeur: 'Chauffeur',
};
export const roleLabel = (r: string): string => ROLE_LABELS[r as Role] ?? r;

export const PAYMENT_LABELS: Record<string, string> = { especes: 'Espèces', orange_money: 'Orange Money', moov_money: 'Moov Money' };
export const CATEGORY_LABELS: Record<string, string> = { plein_tarif: 'Plein tarif', enfant: 'Enfant', etudiant: 'Étudiant' };
export const TRIP_STATUS_LABELS: Record<string, string> = { actif: 'Actif', retarde: 'Retardé', annule: 'Annulé' };
export const TICKET_STATUS_LABELS: Record<string, string> = { vendu: 'Vendu', valide: 'Validé', annule: 'Annulé' };
export const PAYMENT_STATUS_LABELS: Record<string, string> = { a_verifier: 'À vérifier', confirme: 'Confirmé', rembourse: 'Remboursé' };
export const DEVICE_STATUS_LABELS: Record<string, string> = { en_attente: 'En attente', actif: 'Actif', revoque: 'Révoqué' };
export const DEVICE_KIND_LABELS: Record<string, string> = { vente: 'Poste de vente', controle: 'Poste de contrôle' };
