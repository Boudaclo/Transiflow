// Format du QR code des tickets (ADR-004), version 1.
// Charge utile binaire compacte de 78 octets, suivie de la signature Ed25519 (64 octets), le tout en Base64 URL.
// Aucune donnée personnelle. Ce module est volontairement sans dépendance (ni Buffer ni crypto) :
// il sert aussi côté navigateur (poste de vente et de contrôle).

export const QR_VERSION = 1;
export const PAYLOAD_LENGTH = 78;
export const SIGNATURE_LENGTH = 64;

export interface TicketQrPayload {
  version: number;
  tenantId: string;
  /** Identifiant de la clé de signature (clé serveur ou clé de poste). */
  keyId: string;
  ticketId: string;
  number: number;
  tripId: string;
  /** Départ, en secondes depuis 1970 (UTC). */
  departureAt: number;
  /** Prix total en FCFA. */
  price: number;
  seats: number;
}

export class QrFormatError extends Error {}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new QrFormatError('Base64 URL invalide');
  const vals = [...text].map((ch) => ALPHABET.indexOf(ch));
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const [a, b, c, d] = [vals[i]!, vals[i + 1]!, vals[i + 2], vals[i + 3]];
    out.push((a << 2) | (b >> 4));
    if (c !== undefined) out.push(((b & 15) << 4) | (c >> 2));
    if (c !== undefined && d !== undefined) out.push(((c & 3) << 6) | d);
  }
  return Uint8Array.from(out);
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new QrFormatError('UUID invalide');
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

export function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function packTicketPayload(p: TicketQrPayload): Uint8Array {
  const u32 = (n: number, what: string) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new QrFormatError(`${what} hors limites`);
    return n;
  };
  if (!Number.isInteger(p.seats) || p.seats < 1 || p.seats > 255) throw new QrFormatError('places hors limites');
  const out = new Uint8Array(PAYLOAD_LENGTH);
  const view = new DataView(out.buffer);
  out[0] = p.version;
  out.set(uuidToBytes(p.tenantId), 1);
  out.set(uuidToBytes(p.keyId), 17);
  out.set(uuidToBytes(p.ticketId), 33);
  view.setUint32(49, u32(p.number, 'numéro'));
  out.set(uuidToBytes(p.tripId), 53);
  view.setUint32(69, u32(p.departureAt, 'départ'));
  view.setUint32(73, u32(p.price, 'prix'));
  out[77] = p.seats;
  return out;
}

export function unpackTicketPayload(bytes: Uint8Array): TicketQrPayload {
  if (bytes.length !== PAYLOAD_LENGTH) throw new QrFormatError('Longueur de charge utile invalide');
  if (bytes[0] !== QR_VERSION) throw new QrFormatError('Version de QR non prise en charge');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[0]!,
    tenantId: bytesToUuid(bytes.subarray(1, 17)),
    keyId: bytesToUuid(bytes.subarray(17, 33)),
    ticketId: bytesToUuid(bytes.subarray(33, 49)),
    number: view.getUint32(49),
    tripId: bytesToUuid(bytes.subarray(53, 69)),
    departureAt: view.getUint32(69),
    price: view.getUint32(73),
    seats: bytes[77]!,
  };
}

/** Assemble le texte du QR : base64url(charge utile || signature). */
export function encodeTicketQr(payloadBytes: Uint8Array, signature: Uint8Array): string {
  if (payloadBytes.length !== PAYLOAD_LENGTH || signature.length !== SIGNATURE_LENGTH) throw new QrFormatError('Tailles invalides');
  const all = new Uint8Array(PAYLOAD_LENGTH + SIGNATURE_LENGTH);
  all.set(payloadBytes, 0);
  all.set(signature, PAYLOAD_LENGTH);
  return toBase64Url(all);
}

/** Lit un QR sans vérifier la signature (à faire avec la clé publique correspondant à `payload.keyId`). */
export function decodeTicketQr(qr: string): { payloadBytes: Uint8Array; payload: TicketQrPayload; signature: Uint8Array } {
  const bytes = fromBase64Url(qr.trim());
  if (bytes.length !== PAYLOAD_LENGTH + SIGNATURE_LENGTH) throw new QrFormatError('Longueur de QR invalide');
  const payloadBytes = bytes.slice(0, PAYLOAD_LENGTH);
  return { payloadBytes, payload: unpackTicketPayload(payloadBytes), signature: bytes.slice(PAYLOAD_LENGTH) };
}
