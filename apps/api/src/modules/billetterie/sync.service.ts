import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { OfflineSale, OfflineValidation, SyncSalesInput, SyncValidationsInput, decodeTicketQr } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { isForeignKeyViolation, isUniqueViolation } from '../../database/pg-errors';
import { ClientsService } from '../clients';
import { LignesService, TripsService } from '../lignes';
import { AnomaliesService } from './anomalies.service';
import { DeviceRow, PostesService } from './postes.service';
import { SigningKeysService } from './signing-keys.service';

const MAX_CLOCK_OFFSET_MS = 24 * 3600 * 1000;

export interface SaleSyncResult {
  ticketId: string;
  result: 'ok' | 'deja_synchronise' | 'rejete';
  number?: number;
  reason?: string;
  anomalies?: string[];
}
export interface ValidationSyncResult { clientId: string; result: string; firstValidatedAt?: Date }

class SaleRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}

interface TicketLite { id: string; number: number; trip_id: string; seats: number; total_xof: number; status: string; validated_at: Date | null; device_id?: string | null }

@Injectable()
export class SyncService {
  constructor(
    private readonly db: DbService,
    private readonly postes: PostesService,
    private readonly keys: SigningKeysService,
    private readonly anomalies: AnomaliesService,
    private readonly trips: TripsService,
    private readonly lignes: LignesService,
    private readonly clients: ClientsService,
  ) {}

  /**
   * Reçoit les ventes faites hors ligne. Chaque vente est vérifiée (signature du poste, plage de numéros) puis enregistrée :
   * un billet déjà remis à un client est une réalité, les écarts (surréservation, tarif…) sont signalés en anomalie, pas refusés.
   */
  syncSales(tenantId: string, userId: string, input: SyncSalesInput): Promise<{ serverTime: string; results: SaleSyncResult[] }> {
    return this.db.withTenant(tenantId, async (c) => {
      const device = await this.postes.requireActive(c, input.deviceId, 'vente');
      const serverNow = new Date();
      const offset = serverNow.getTime() - Date.parse(input.deviceNow);
      await this.postes.touch(c, device.id, offset);
      if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS) await this.anomalies.record(c, { tenantId, kind: 'horloge_decalee', deviceId: device.id, detail: { offsetMs: offset } });

      // Ordre stable par départ : deux synchronisations simultanées prennent les verrous dans le même ordre (pas d'interblocage).
      const order = input.sales.map((sale, i) => ({ sale, i })).sort((a, b) => a.sale.tripId.localeCompare(b.sale.tripId) || a.sale.number - b.sale.number);
      const results: SaleSyncResult[] = new Array(input.sales.length);
      for (const { sale, i } of order) {
        await c.query('SAVEPOINT sale');
        try {
          results[i] = await this.processSale(c, tenantId, userId, device, offset, serverNow, sale);
          await c.query('RELEASE SAVEPOINT sale');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT sale');
          const reason = e instanceof SaleRejected ? e.reason : isForeignKeyViolation(e) ? 'arrets_invalides' : isUniqueViolation(e) ? 'numero_deja_utilise' : null;
          if (!reason) throw e;
          await this.anomalies.record(c, { tenantId, kind: 'vente_rejetee', deviceId: device.id, ticketId: sale.ticketId, tripId: sale.tripId, detail: { reason, number: sale.number } });
          results[i] = { ticketId: sale.ticketId, result: 'rejete', number: sale.number, reason };
        }
      }
      return { serverTime: serverNow.toISOString(), results };
    });
  }

  private async processSale(c: PoolClient, tenantId: string, userId: string, device: DeviceRow, offset: number, serverNow: Date, s: OfflineSale): Promise<SaleSyncResult> {
    const existing = (await c.query<TicketLite>('SELECT id, number, trip_id, seats, total_xof, status, validated_at, device_id FROM tickets WHERE id = $1', [s.ticketId])).rows[0];
    if (existing) {
      if (existing.device_id === device.id && existing.number === s.number && existing.trip_id === s.tripId) return { ticketId: s.ticketId, result: 'deja_synchronise', number: s.number };
      throw new SaleRejected('identifiant_deja_utilise');
    }

    // 1. Authenticité : le QR doit être signé par la clé de CE poste et décrire exactement cette vente.
    let decoded: ReturnType<typeof decodeTicketQr>;
    try {
      decoded = decodeTicketQr(s.qr);
    } catch {
      throw new SaleRejected('qr_illisible');
    }
    const p = decoded.payload;
    const key = await this.keys.find(c, p.keyId);
    if (!key || key.id !== device.signing_key_id || !this.keys.verify(key.publicKey, decoded.payloadBytes, decoded.signature)) throw new SaleRejected('signature_invalide');
    if (p.tenantId !== tenantId || p.ticketId !== s.ticketId || p.number !== s.number || p.tripId !== s.tripId || p.price !== s.total || p.seats !== s.seats) throw new SaleRejected('qr_incoherent');

    // 2. Le numéro appartient à une plage réservée par ce poste, et n'est pas déjà pris.
    const inRange = await c.query('SELECT 1 FROM number_ranges WHERE device_id = $1 AND $2 BETWEEN start_number AND end_number', [device.id, s.number]);
    if (!inRange.rowCount) throw new SaleRejected('numero_hors_plage');
    if ((await c.query('SELECT 1 FROM tickets WHERE number = $1', [s.number])).rowCount) throw new SaleRejected('numero_deja_utilise');

    // 3. Départ (verrouillé : les ventes d'un même départ passent l'une après l'autre).
    const trip = await this.trips.lockForSale(c, s.tripId);
    if (!trip) throw new SaleRejected('depart_inconnu');
    if (p.departureAt !== Math.floor(trip.departureAt.getTime() / 1000)) throw new SaleRejected('depart_incoherent');
    if (s.total % s.seats !== 0) throw new SaleRejected('montant_invalide');
    const unit = s.total / s.seats;

    // 4. Écarts acceptés mais signalés.
    const flags: string[] = [];
    const flag = async (kind: Parameters<AnomaliesService['record']>[1]['kind'], detail: Record<string, unknown>) => {
      flags.push(kind);
      await this.anomalies.record(c, { tenantId, kind, deviceId: device.id, ticketId: s.ticketId, tripId: s.tripId, detail: { number: s.number, ...detail } });
    };
    const fare = await this.lignes.findActiveFare(c, trip.lineId, s.fromStopId, s.toStopId, s.category);
    if (!fare) await flag('ecart_tarif', { raison: 'tarif_absent_ou_desactive', prixRecu: unit });
    else if (fare.price !== unit) await flag('ecart_tarif', { prixAttendu: fare.price, prixRecu: unit });
    if (trip.status === 'annule') await flag('depart_annule', {});
    const sold = Number((await c.query<{ n: string }>("SELECT coalesce(sum(seats), 0) AS n FROM tickets WHERE trip_id = $1 AND status IN ('vendu', 'valide')", [trip.id])).rows[0]!.n);
    if (sold + s.seats > trip.seats) await flag('surreservation', { capacite: trip.seats, placesApresCetteVente: sold + s.seats });
    if (s.payment.reference && (await c.query('SELECT 1 FROM payments WHERE method = $1 AND reference = $2', [s.payment.method, s.payment.reference])).rowCount) {
      await flag('reference_dupliquee', { methode: s.payment.method, reference: s.payment.reference });
    }
    const clientId = s.clientId && (await this.clients.exists(c, s.clientId)) ? s.clientId : null;

    // 5. Enregistrement. L'heure de vente est celle de l'appareil corrigée du décalage d'horloge (jamais dans le futur).
    const soldAt = new Date(Math.min(Date.parse(s.soldAt) + offset, serverNow.getTime()));
    await c.query(
      `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, client_id, signing_key_id, qr, sold_by, sold_at, device_id, offline, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, true, now())`,
      [s.ticketId, tenantId, s.number, trip.lineId, trip.id, s.fromStopId, s.toStopId, s.category, s.seats, unit, s.total, clientId, key.id, s.qr, userId, soldAt, device.id],
    );
    // Un paiement mobile saisi hors ligne n'est pas confirmé : il reste « à vérifier ».
    await c.query('INSERT INTO payments (tenant_id, ticket_id, method, amount_xof, reference, status) VALUES ($1, $2, $3, $4, $5, $6)', [
      tenantId, s.ticketId, s.payment.method, s.total, s.payment.reference ?? null, s.payment.method === 'especes' ? 'encaisse' : 'a_verifier',
    ]);
    await this.reconcilePending(c, tenantId, s.ticketId, s.number);
    return { ticketId: s.ticketId, result: 'ok', number: s.number, ...(flags.length ? { anomalies: flags } : {}) };
  }

  /** Des contrôleurs ont pu valider ce billet avant que la vente n'arrive : on rattache la plus ancienne présentation. */
  private async reconcilePending(c: PoolClient, tenantId: string, ticketId: string, number: number): Promise<void> {
    const pending = (await c.query<{ id: string; user_id: string; scanned_at_corrected: Date; device_id: string }>(
      "SELECT id, user_id, scanned_at_corrected, device_id FROM validations WHERE claimed_ticket_id = $1 AND ticket_id IS NULL AND result = 'en_attente' ORDER BY scanned_at_corrected, id", [ticketId],
    )).rows;
    const [first, ...others] = pending;
    if (!first) return;
    await c.query("UPDATE tickets SET status = 'valide', validated_at = $2, validated_by = $3 WHERE id = $1 AND status = 'vendu'", [ticketId, first.scanned_at_corrected, first.user_id]);
    await c.query("UPDATE validations SET ticket_id = $2, result = 'valide' WHERE id = $1", [first.id, ticketId]);
    for (const o of others) {
      await c.query("UPDATE validations SET ticket_id = $2, result = 'doublon' WHERE id = $1", [o.id, ticketId]);
      await this.anomalies.record(c, { tenantId, kind: 'validation_doublon', deviceId: o.device_id, ticketId, detail: { number, premiere: first.scanned_at_corrected, derniere: o.scanned_at_corrected } });
    }
  }

  /**
   * Reçoit les validations faites hors ligne. Elles sont rejouées dans l'ordre de l'horloge de l'appareil corrigée du décalage :
   * la première présentation est retenue, les suivantes sont des doublons signalés en anomalie.
   */
  syncValidations(tenantId: string, userId: string, input: SyncValidationsInput): Promise<{ serverTime: string; results: ValidationSyncResult[] }> {
    return this.db.withTenant(tenantId, async (c) => {
      const device = await this.postes.requireActive(c, input.deviceId, 'controle');
      const serverNow = new Date();
      const offset = serverNow.getTime() - Date.parse(input.deviceNow);
      await this.postes.touch(c, device.id, offset);
      if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS) await this.anomalies.record(c, { tenantId, kind: 'horloge_decalee', deviceId: device.id, detail: { offsetMs: offset } });

      const corrected = (v: OfflineValidation) => new Date(Math.min(Date.parse(v.scannedAt) + offset, serverNow.getTime()));
      const order = input.validations.map((v, i) => ({ v, i })).sort((a, b) => corrected(a.v).getTime() - corrected(b.v).getTime() || a.i - b.i);
      const results: ValidationSyncResult[] = new Array(input.validations.length);
      for (const { v, i } of order) results[i] = await this.processValidation(c, tenantId, userId, device, v, Date.parse(v.scannedAt), corrected(v));
      return { serverTime: serverNow.toISOString(), results };
    });
  }

  private async processValidation(c: PoolClient, tenantId: string, userId: string, device: DeviceRow, v: OfflineValidation, deviceTime: number, at: Date): Promise<ValidationSyncResult> {
    const prev = (await c.query<{ result: string; scanned_at_corrected: Date | null }>('SELECT result, scanned_at_corrected FROM validations WHERE device_id = $1 AND client_ref = $2', [device.id, v.clientId])).rows[0];
    if (prev) return { clientId: v.clientId, result: prev.result };

    const log = async (result: string, ticketId: string | null, claimed: string | null, extra: Partial<ValidationSyncResult> = {}): Promise<ValidationSyncResult> => {
      await c.query(
        `INSERT INTO validations (tenant_id, ticket_id, trip_id, user_id, result, device_id, client_ref, claimed_ticket_id, scanned_at_device, scanned_at_corrected, local_result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [tenantId, ticketId, v.tripId ?? null, userId, result, device.id, v.clientId, claimed, new Date(deviceTime), at, v.localResult],
      );
      return { clientId: v.clientId, result, ...extra };
    };

    let decoded: ReturnType<typeof decodeTicketQr>;
    try {
      decoded = decodeTicketQr(v.qr);
    } catch {
      return log('illisible', null, null);
    }
    const p = decoded.payload;
    if (p.tenantId !== tenantId) return log('inconnu', null, null);
    const key = await this.keys.find(c, p.keyId);
    if (!key || !this.keys.verify(key.publicKey, decoded.payloadBytes, decoded.signature)) return log('signature_invalide', null, null);

    const t = (await c.query<TicketLite>('SELECT id, number, trip_id, seats, total_xof, status, validated_at FROM tickets WHERE id = $1 FOR UPDATE', [p.ticketId])).rows[0];
    if (!t) {
      // Billet signé par une clé connue mais pas encore synchronisé : mis en attente, rattaché dès que la vente arrive.
      if (key.status === 'revoque') return log('signature_invalide', null, null);
      return log('en_attente', null, p.ticketId);
    }
    if (t.number !== p.number || t.trip_id !== p.tripId || t.total_xof !== p.price || t.seats !== p.seats) return log('signature_invalide', t.id, null);

    if (t.status === 'annule') {
      await this.anomalies.record(c, { tenantId, kind: 'validation_billet_annule', deviceId: device.id, ticketId: t.id, tripId: t.trip_id, detail: { number: t.number, scanne: at } });
      return log('annule', t.id, null);
    }
    if (t.status === 'valide') {
      const first = t.validated_at!;
      const record = (firstAt: Date, laterAt: Date) =>
        this.anomalies.record(c, { tenantId, kind: 'validation_doublon', deviceId: device.id, ticketId: t.id, tripId: t.trip_id, detail: { number: t.number, premiere: firstAt, derniere: laterAt } });
      if (at.getTime() < first.getTime()) {
        // Cette présentation est antérieure à celle déjà enregistrée : elle devient la première.
        await c.query("UPDATE validations SET result = 'doublon' WHERE ticket_id = $1 AND result = 'valide'", [t.id]);
        await c.query('UPDATE tickets SET validated_at = $2, validated_by = $3 WHERE id = $1', [t.id, at, userId]);
        await record(at, first);
        return log('valide', t.id, null, { firstValidatedAt: at });
      }
      await record(first, at);
      return log('doublon', t.id, null, { firstValidatedAt: first });
    }
    await c.query("UPDATE tickets SET status = 'valide', validated_at = $2, validated_by = $3 WHERE id = $1", [t.id, at, userId]);
    return log('valide', t.id, null, { firstValidatedAt: at });
  }
}
