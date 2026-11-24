import { formatTime } from './format';

export type ScanTone = 'ok' | 'bad' | 'warn';
export interface ScanDisplay { tone: ScanTone; title: string; detail?: string; sub?: string; valid: boolean }
export interface ScanTicketInfo { number: number; seats: number; tripId?: string; departureAt?: string | Date; lineCode?: string; from?: string | null; to?: string | null }

/** Résultat brut (serveur ou poste) → affichage plein écran. Le vert n'est jamais seul : toujours un titre en toutes lettres. */
export function scanToDisplay(result: string, ticket?: ScanTicketInfo, firstValidatedAt?: string | Date, sousReserve = false): ScanDisplay {
  const trip = ticket ? [ticket.from && ticket.to ? `${ticket.from} → ${ticket.to}` : ticket.lineCode, `${ticket.seats} place${ticket.seats > 1 ? 's' : ''}`].filter(Boolean).join(' · ') : undefined;
  const num = ticket ? `Ticket n° ${ticket.number}` : undefined;
  switch (result) {
    case 'valide':
      return { tone: 'ok', valid: true, title: 'Valide', ...(trip ? { detail: trip } : {}), ...(num ? { sub: sousReserve ? `${num} · à confirmer à la synchronisation` : num } : {}) };
    case 'deja_valide':
      return { tone: 'bad', valid: false, title: 'Déjà utilisé', detail: firstValidatedAt ? `Première validation à ${formatTime(firstValidatedAt)}` : 'Ce ticket a déjà été validé', ...(num ? { sub: num } : {}) };
    case 'annule':
      return { tone: 'bad', valid: false, title: 'Ticket annulé', ...(num ? { sub: num } : {}) };
    case 'mauvais_depart':
      return { tone: 'warn', valid: false, title: 'Mauvais départ', detail: ticket?.departureAt ? `Ce ticket est pour le départ de ${formatTime(ticket.departureAt)}` : "Ce ticket n'est pas pour ce départ", ...(num ? { sub: num } : {}) };
    default:
      return { tone: 'bad', valid: false, title: 'Faux ticket / non reconnu', detail: result === 'illisible' ? 'Code illisible' : 'Signature invalide ou ticket inconnu' };
  }
}

let audio: AudioContext | undefined;
function beep(freq: number, ms: number, at = 0): void {
  try {
    audio ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq; o.type = 'square'; g.gain.value = 0.15;
    o.connect(g); g.connect(audio.destination);
    o.start(audio.currentTime + at); o.stop(audio.currentTime + at + ms / 1000);
  } catch { /* pas de son disponible */ }
}
/** Un bip aigu et court = valide ; deux sons graves et longs + vibration = refusé. */
export function signal(valid: boolean): void {
  if (valid) { beep(1040, 140); navigator.vibrate?.(60); }
  else { beep(220, 260); beep(180, 320, 0.32); navigator.vibrate?.([220, 100, 220]); }
}
