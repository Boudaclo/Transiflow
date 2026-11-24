import * as ed from '@noble/ed25519';
import { fromBase64Url, toBase64Url } from '@transport/shared';

// Ed25519 en JavaScript pur : fonctionne sur tous les navigateurs, y compris les Android d'entrée de gamme.
export async function generateKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const priv = ed.utils.randomPrivateKey();
  return { privateKey: toBase64Url(priv), publicKey: toBase64Url(await ed.getPublicKey(priv)) };
}
export async function signBytes(privateKey: string, message: Uint8Array): Promise<Uint8Array> {
  return ed.sign(message, fromBase64Url(privateKey));
}
export async function verifyBytes(publicKey: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    return await ed.verify(signature, message, fromBase64Url(publicKey));
  } catch {
    return false;
  }
}

/** UUID v4 sans dépendre de `crypto.randomUUID` (absent des anciens navigateurs et de certains environnements). */
export function newUuid(): string {
  const b = ed.utils.randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
