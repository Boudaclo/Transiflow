import type { FareCategory } from '@transport/shared';
import type { CatalogFare, CatalogLine, CatalogResponse, RefTrip } from '@transport/offline';

export const GRACE_MS = 30 * 60_000;

/** Places encore vendables selon les données du poste (vendues au serveur + ventes locales pas encore envoyées). */
export const remainingSeats = (t: RefTrip, pendingSeats = 0): number => Math.max(0, t.seats - t.sold - pendingSeats);

/** Départs vendables d'une ligne : pas annulés, pas partis depuis plus de 30 minutes, du plus proche au plus lointain. */
export function sellableTrips(catalog: CatalogResponse | undefined, lineId: string, now = Date.now()): RefTrip[] {
  return (catalog?.trips ?? [])
    .filter((t) => t.lineId === lineId && t.status !== 'annule' && Date.parse(t.departureAt) >= now - GRACE_MS)
    .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));
}

/** Prochain horaire proposé par défaut : le premier départ à venir qui a encore des places, sinon le premier de la liste. */
export function defaultTrip(trips: RefTrip[], pending: Record<string, number> = {}, now = Date.now()): RefTrip | undefined {
  return trips.find((t) => Date.parse(t.departureAt) >= now && remainingSeats(t, pending[t.id]) > 0) ?? trips[0];
}

export function findFare(line: CatalogLine | undefined, fromStopId: string, toStopId: string, category: FareCategory = 'plein_tarif'): CatalogFare | undefined {
  return line?.fares.find((f) => f.fromStopId === fromStopId && f.toStopId === toStopId && f.category === category);
}

/** Catégories vendables pour ce trajet (une seule au début : plein tarif). */
export function categoriesFor(line: CatalogLine | undefined, fromStopId: string, toStopId: string): FareCategory[] {
  return [...new Set((line?.fares ?? []).filter((f) => f.fromStopId === fromStopId && f.toStopId === toStopId).map((f) => f.category))];
}

export const MAX_SEATS = 10;
export const clampSeats = (n: number, remaining: number): number => Math.max(1, Math.min(MAX_SEATS, remaining, n));

/** Texte d'état de la vente bloquée hors ligne. */
export function blockedMessage(reason: string | undefined): string {
  switch (reason) {
    case 'poste_non_actif': return "Ce poste n'est pas encore activé : la vente hors ligne n'est pas possible. Demandez au directeur de l'activer.";
    case 'hors_ligne_trop_long': return 'Plus de 48 h hors ligne : reconnectez-vous pour vendre à nouveau.';
    case 'plage_epuisee': return 'Plus de numéros disponibles sur ce poste : reconnectez-vous pour en obtenir.';
    case 'catalogue_absent': return 'Aucune donnée en cache : connectez-vous au moins une fois pour charger les lignes et tarifs.';
    default: return 'Vente hors ligne impossible pour le moment.';
  }
}
