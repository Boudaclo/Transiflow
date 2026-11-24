import { Inject, Injectable } from '@nestjs/common';
import {
  KeyObject, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, scryptSync, sign as edSign, verify as edVerify,
} from 'crypto';
import type { PoolClient } from 'pg';
import { fromBase64Url, toBase64Url } from '@transport/shared';
import { AppConfig, CONFIG } from '../../config';

export interface PublicKeyInfo { id: string; kind: 'serveur' | 'poste'; status: 'actif' | 'revoque'; publicKey: string }

// Préfixe DER d'une clé publique Ed25519 (SPKI) : on y accole les 32 octets bruts.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

@Injectable()
export class SigningKeysService {
  private readonly secret: Buffer;
  private readonly privateCache = new Map<string, KeyObject>();

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.secret = scryptSync(cfg.signingKeySecret, 'transport-saas/signing-keys/v1', 32);
  }

  /** Clé serveur active de la compagnie ; créée à la première vente. */
  async ensureServerKey(c: PoolClient, tenantId: string): Promise<{ id: string }> {
    const find = async () => (await c.query<{ id: string }>("SELECT id FROM signing_keys WHERE kind = 'serveur' AND status = 'actif'")).rows[0];
    const existing = await find();
    if (existing) return existing;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    await c.query(
      "INSERT INTO signing_keys (tenant_id, kind, public_key, private_key_enc) VALUES ($1, 'serveur', $2, $3) ON CONFLICT DO NOTHING",
      [tenantId, toBase64Url(rawPublic), this.encrypt(privateDer)],
    );
    return (await find())!;
  }

  async sign(c: PoolClient, keyId: string, message: Uint8Array): Promise<Uint8Array> {
    let key = this.privateCache.get(keyId);
    if (!key) {
      const row = (await c.query<{ private_key_enc: string | null }>('SELECT private_key_enc FROM signing_keys WHERE id = $1', [keyId])).rows[0];
      if (!row?.private_key_enc) throw new Error('Clé de signature introuvable');
      key = createPrivateKey({ key: this.decrypt(row.private_key_enc), format: 'der', type: 'pkcs8' });
      this.privateCache.set(keyId, key);
    }
    return new Uint8Array(edSign(null, Buffer.from(message), key));
  }

  async find(c: PoolClient, id: string): Promise<PublicKeyInfo | undefined> {
    const row = (await c.query<{ id: string; kind: 'serveur' | 'poste'; status: 'actif' | 'revoque'; public_key: string }>(
      'SELECT id, kind, status, public_key FROM signing_keys WHERE id = $1', [id],
    )).rows[0];
    return row && { id: row.id, kind: row.kind, status: row.status, publicKey: row.public_key };
  }

  async list(c: PoolClient): Promise<PublicKeyInfo[]> {
    const { rows } = await c.query<{ id: string; kind: 'serveur' | 'poste'; status: 'actif' | 'revoque'; public_key: string }>(
      'SELECT id, kind, status, public_key FROM signing_keys ORDER BY created_at',
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, publicKey: r.public_key }));
  }

  verify(publicKeyB64: string, message: Uint8Array, signature: Uint8Array): boolean {
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(fromBase64Url(publicKeyB64))]), format: 'der', type: 'spki' });
      return edVerify(null, Buffer.from(message), key, Buffer.from(signature));
    } catch {
      return false;
    }
  }

  private encrypt(plain: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  private decrypt(stored: string): Buffer {
    const raw = Buffer.from(stored, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.secret, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}
