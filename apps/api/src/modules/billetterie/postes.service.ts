import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DeviceKind, DeviceStatus, RequestDeviceInput, fromBase64Url } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { AuditService } from '../audit';

export interface DeviceView {
  id: string; name: string; kind: DeviceKind; status: DeviceStatus; publicKey: string; signingKeyId: string | null;
  lastSeenAt: Date | null; clockOffsetMs: number | null; createdAt: Date; activatedAt: Date | null; revokedAt: Date | null;
  revokeReason: string | null; requestedBy: string; ticketsSynced: number; rangesReserved: number;
}
export interface DeviceRow { id: string; kind: DeviceKind; status: DeviceStatus; public_key: string; signing_key_id: string | null }
interface FullRow extends DeviceRow {
  name: string; last_seen_at: Date | null; clock_offset_ms: string | null; created_at: Date; activated_at: Date | null;
  revoked_at: Date | null; revoke_reason: string | null; requested_by: string; tickets_synced: string; ranges_reserved: string;
}
const SELECT = `SELECT d.id, d.name, d.kind, d.status, d.public_key, d.signing_key_id, d.last_seen_at, d.clock_offset_ms, d.created_at,
  d.activated_at, d.revoked_at, d.revoke_reason, d.requested_by,
  (SELECT count(*) FROM tickets t WHERE t.device_id = d.id) AS tickets_synced,
  (SELECT count(*) FROM number_ranges r WHERE r.device_id = d.id) AS ranges_reserved
  FROM devices d`;
const toView = (r: FullRow): DeviceView => ({
  id: r.id, name: r.name, kind: r.kind, status: r.status, publicKey: r.public_key, signingKeyId: r.signing_key_id,
  lastSeenAt: r.last_seen_at, clockOffsetMs: r.clock_offset_ms === null ? null : Number(r.clock_offset_ms), createdAt: r.created_at,
  activatedAt: r.activated_at, revokedAt: r.revoked_at, revokeReason: r.revoke_reason, requestedBy: r.requested_by,
  ticketsSynced: Number(r.tickets_synced), rangesReserved: Number(r.ranges_reserved),
});

@Injectable()
export class PostesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Demande d'activation faite par l'appareil lui-même (la clé privée reste sur l'appareil). Rejouable. */
  request(tenantId: string, userId: string, input: RequestDeviceInput): Promise<DeviceView> {
    return this.db.withTenant(tenantId, async (c) => {
      if (fromBase64Url(input.publicKey).length !== 32) throw new BadRequestException('Clé publique Ed25519 invalide');
      let row = (await c.query<FullRow>(`${SELECT} WHERE d.public_key = $1`, [input.publicKey])).rows[0];
      if (!row) {
        await c.query('INSERT INTO devices (tenant_id, name, kind, public_key, requested_by) VALUES ($1, $2, $3, $4, $5)', [tenantId, input.name, input.kind, input.publicKey, userId]);
        row = (await c.query<FullRow>(`${SELECT} WHERE d.public_key = $1`, [input.publicKey])).rows[0]!;
      }
      return toView(row);
    });
  }

  list(tenantId: string): Promise<DeviceView[]> {
    return this.db.withTenant(tenantId, async (c) => (await c.query<FullRow>(`${SELECT} ORDER BY d.created_at DESC`)).rows.map(toView));
  }

  activate(tenantId: string, adminId: string, id: string): Promise<DeviceView> {
    return this.db.withTenant(tenantId, async (c) => {
      const d = (await c.query<DeviceRow & { name: string }>('SELECT id, name, kind, status, public_key, signing_key_id FROM devices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundException('Poste introuvable');
      if (d.status !== 'en_attente') throw new ConflictException(d.status === 'actif' ? 'Ce poste est déjà activé' : 'Un poste révoqué ne peut pas être réactivé : demandez un nouvel enregistrement');
      // Seuls les postes de vente signent des billets : eux seuls reçoivent une clé de signature.
      let keyId: string | null = null;
      if (d.kind === 'vente') {
        keyId = (await c.query<{ id: string }>("INSERT INTO signing_keys (tenant_id, kind, public_key) VALUES ($1, 'poste', $2) RETURNING id", [tenantId, d.public_key])).rows[0]!.id;
      }
      await c.query("UPDATE devices SET status = 'actif', signing_key_id = $2, activated_by = $3, activated_at = now() WHERE id = $1", [id, keyId, adminId]);
      await this.audit.record({ tenantId, userId: adminId, action: 'device.activated', objectType: 'device', objectId: id, after: { name: d.name, kind: d.kind, signingKeyId: keyId } }, c);
      return toView((await c.query<FullRow>(`${SELECT} WHERE d.id = $1`, [id])).rows[0]!);
    });
  }

  /** Révocation (poste volé ou perdu). La clé est révoquée : les billets non encore synchronisés de ce poste seront refusés. */
  revoke(tenantId: string, adminId: string, id: string, reason: string): Promise<DeviceView> {
    return this.db.withTenant(tenantId, async (c) => {
      const d = (await c.query<DeviceRow & { name: string }>('SELECT id, name, kind, status, public_key, signing_key_id FROM devices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundException('Poste introuvable');
      if (d.status === 'revoque') throw new ConflictException('Ce poste est déjà révoqué');
      await c.query("UPDATE devices SET status = 'revoque', revoked_by = $2, revoked_at = now(), revoke_reason = $3 WHERE id = $1", [id, adminId, reason]);
      if (d.signing_key_id) await c.query("UPDATE signing_keys SET status = 'revoque', revoked_at = now() WHERE id = $1", [d.signing_key_id]);
      await this.audit.record({ tenantId, userId: adminId, action: 'device.revoked', objectType: 'device', objectId: id, before: { status: d.status }, after: { reason, name: d.name } }, c);
      return toView((await c.query<FullRow>(`${SELECT} WHERE d.id = $1`, [id])).rows[0]!);
    });
  }

  state(tenantId: string, id: string): Promise<{ id: string; status: DeviceStatus; kind: DeviceKind; tenantId: string; signingKeyId: string | null; serverTime: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const d = (await c.query<DeviceRow>('SELECT id, kind, status, public_key, signing_key_id FROM devices WHERE id = $1', [id])).rows[0];
      if (!d) throw new NotFoundException('Poste introuvable');
      return { id: d.id, status: d.status, kind: d.kind, tenantId, signingKeyId: d.signing_key_id, serverTime: new Date().toISOString() };
    });
  }

  /** Réserve une plage de numéros, prélevée sur le compteur de la compagnie (donc sans chevauchement avec aucune autre vente). */
  reserveRange(tenantId: string, id: string, size: number): Promise<{ start: number; end: number; size: number; serverTime: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      await this.requireActive(c, id, 'vente');
      await c.query('INSERT INTO ticket_counters (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
      const start = (await c.query<{ s: number }>('UPDATE ticket_counters SET next_number = next_number + $2 WHERE tenant_id = $1 RETURNING next_number - $2 AS s', [tenantId, size])).rows[0]!.s;
      const end = start + size - 1;
      await c.query('INSERT INTO number_ranges (tenant_id, device_id, start_number, end_number) VALUES ($1, $2, $3, $4)', [tenantId, id, start, end]);
      await c.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [id]);
      return { start, end, size, serverTime: new Date().toISOString() };
    });
  }

  async requireActive(c: PoolClient, id: string, kind: DeviceKind): Promise<DeviceRow> {
    const d = (await c.query<DeviceRow>('SELECT id, kind, status, public_key, signing_key_id FROM devices WHERE id = $1', [id])).rows[0];
    if (!d) throw new NotFoundException('Poste introuvable');
    if (d.status === 'revoque') throw new ForbiddenException({ message: 'Ce poste a été révoqué', code: 'poste_revoque' });
    if (d.status !== 'actif') throw new ForbiddenException({ message: 'Ce poste n\'est pas encore activé', code: 'poste_non_active' });
    if (d.kind !== kind) throw new ForbiddenException({ message: `Ce poste n'est pas un poste de ${kind}`, code: 'poste_type_invalide' });
    return d;
  }

  async touch(c: PoolClient, id: string, offsetMs: number): Promise<void> {
    await c.query('UPDATE devices SET last_seen_at = now(), clock_offset_ms = $2 WHERE id = $1', [id, Math.round(offsetMs)]);
  }
}
