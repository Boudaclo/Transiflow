const NNBSP = '\u202f';
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** FCFA : entiers, jamais de décimales. Espaces insécables pour ne jamais couper un montant en fin de ligne. */
export function formatFcfa(n: number): string {
  return `${nf.format(Math.round(n)).replace(/[\u00a0\u202f]/g, NNBSP)}\u00a0FCFA`;
}
export const formatInt = (n: number): string => nf.format(Math.round(n)).replace(/[\u00a0\u202f]/g, NNBSP);
export const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}\u00a0%`;

const dateTime = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateLong = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
const timeOnly = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const formatDateTime = (iso: string | Date): string => dateTime.format(new Date(iso));
export const formatDay = (iso: string | Date): string => dateLong.format(new Date(iso));
export const formatTime = (iso: string | Date): string => timeOnly.format(new Date(iso));
export const formatDate = (iso: string | Date): string => dateOnly.format(new Date(iso));
export const formatDeparture = (iso: string | Date): string => `${formatDay(iso)} ${formatTime(iso)}`;

/** AAAA-MM-JJ en heure locale (pour les champs date). */
export function toInputDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Valeur pour <input type="datetime-local"> en heure locale. */
export function toInputDateTime(d: Date): string {
  return `${toInputDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
