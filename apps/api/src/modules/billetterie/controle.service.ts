import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ValidateTicketInput, decodeTicketQr } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { LignesService, TripView, TripsService } from '../lignes';
import { BilletterieService, TICKET_SELECT, TicketRow } from './billetterie.service';
import { PublicKeyInfo, SigningKeysService } from './signing-keys.service';

export type ScanResult = 'valide' | 'deja_valide' | 'annule' | 'mauvais_depart' | 'signature_invalide' | 'inconnu' | 'illisible';
export interface ScanOutcome {
  result: ScanResult;
  firstValidatedAt?: Date;
  ticket?: { number: number; seats: number; category: string; tripId: string; departureAt?: Date; lineCode?: string; from?: string | null; to?: string | null };
}
export interface Manifest { trip: TripView; seatsSold: number; seatsValidated: number; seatsNotYetValidated: number; ticketsSold: number }

@Injectable()
export class ControleService {
  constructor(
    private readonly db: DbService,
    private readonly keys: SigningKeysService,
    private readonly billetterie: BilletterieService,
    private readonly trips: TripsService,
    private readonly lignes: LignesService,
  ) {}

  /** Présente un billet (QR, ou numéro en secours). Chaque présentation est enregistrée. */
  validate(tenantId: string, userId: string, input: ValidateTicketInput): Promise<ScanOutcome> {
    return this.db.withTenant(tenantId, async (c) => {
      const done = async (result: ScanResult, row?: TicketRow, extra: Partial<ScanOutcome> = {}): Promise<ScanOutcome> => {
        await c.query('INSERT INTO validations (tenant_id, ticket_id, trip_id, user_id, result) VALUES ($1, $2, $3, $4, $5)', [tenantId, row?.id ?? null, input.tripId ?? null, userId, result]);
        return { result, ...(row ? { ticket: await this.summary(c, row) } : {}), ...extra };
      };

      let row: TicketRow | undefined;
      if (input.qr !== undefined) {
        let decoded: ReturnType<typeof decodeTicketQr>;
        try {
          decoded = decodeTicketQr(input.qr);
        } catch {
          return done('illisible');
        }
        // Billet d'une autre compagnie : on ne révèle rien.
        if (decoded.payload.tenantId !== tenantId) return done('inconnu');
        const key = await this.keys.find(c, decoded.payload.keyId);
        if (!key || !this.keys.verify(key.publicKey, decoded.payloadBytes, decoded.signature)) return done('signature_invalide');
        row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [decoded.payload.ticketId])).rows[0];
        // Un billet déjà synchronisé reste valable. Un billet inconnu signé par une clé révoquée (poste volé) est refusé.
        if (!row) return done(key.status === 'revoque' ? 'signature_invalide' : 'inconnu');
        const p = decoded.payload;
        if (row.number !== p.number || row.trip_id !== p.tripId || row.total_xof !== p.price || row.seats !== p.seats) return done('signature_invalide', row);
      } else {
        row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.number = $1`, [input.number])).rows[0];
        if (!row) return done('inconnu');
      }

      if (row.status === 'annule') return done('annule', row);
      if (row.status === 'valide') return done('deja_valide', row, { firstValidatedAt: row.validated_at ?? undefined });
      if (input.tripId && row.trip_id !== input.tripId) return done('mauvais_depart', row);

      // Mise à jour atomique : de plusieurs présentations simultanées, une seule est valide.
      const upd = await c.query<{ validated_at: Date }>(
        "UPDATE tickets SET status = 'valide', validated_at = now(), validated_by = $2 WHERE id = $1 AND status = 'vendu' RETURNING validated_at", [row.id, userId],
      );
      if (upd.rowCount) return done('valide', row, { firstValidatedAt: upd.rows[0]!.validated_at });
      const now = (await c.query<{ status: string; validated_at: Date | null }>('SELECT status, validated_at FROM tickets WHERE id = $1', [row.id])).rows[0]!;
      return now.status === 'annule' ? done('annule', row) : done('deja_valide', row, { firstValidatedAt: now.validated_at ?? undefined });
    });
  }

  manifest(tenantId: string, tripId: string): Promise<Manifest> {
    return this.db.withTenant(tenantId, async (c) => {
      const trip = (await this.trips.describe(c, [tripId])).get(tripId);
      if (!trip) throw new NotFoundException('Départ introuvable');
      const s = (await c.query<{ tickets: string; sold: string; validated: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('vendu', 'valide')) AS tickets,
                coalesce(sum(seats) FILTER (WHERE status IN ('vendu', 'valide')), 0) AS sold,
                coalesce(sum(seats) FILTER (WHERE status = 'valide'), 0) AS validated
         FROM tickets WHERE trip_id = $1`, [tripId],
      )).rows[0]!;
      const sold = Number(s.sold);
      const validated = Number(s.validated);
      return { trip, seatsSold: sold, seatsValidated: validated, seatsNotYetValidated: sold - validated, ticketsSold: Number(s.tickets) };
    });
  }

  /** Clés publiques pour vérifier les QR (postes de contrôle hors ligne : étape 5). */
  publicKeys(tenantId: string): Promise<PublicKeyInfo[]> {
    return this.db.withTenant(tenantId, (c) => this.keys.list(c));
  }

  private async summary(c: PoolClient, row: TicketRow): Promise<NonNullable<ScanOutcome['ticket']>> {
    const [view] = await this.billetterie.toViews(c, [row]);
    return {
      number: row.number, seats: row.seats, category: row.category, tripId: row.trip_id,
      departureAt: view?.trip?.departureAt, lineCode: view?.trip?.lineCode, from: view?.from.name, to: view?.to.name,
    };
  }
}
