import { Injectable } from '@nestjs/common';
import type { ReferentielQuery } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { CatalogLine, LignesService, TripView, TripsService } from '../lignes';
import { PublicKeyInfo, SigningKeysService } from './signing-keys.service';

const HOUR = 3600 * 1000;
export interface RefTrip { id: string; lineId: string; lineCode: string; departureAt: Date; seats: number; status: string; sold: number }

/** Données de référence emportées par les postes pour travailler sans connexion. */
@Injectable()
export class ReferenceService {
  constructor(private readonly db: DbService, private readonly lignes: LignesService, private readonly trips: TripsService, private readonly keys: SigningKeysService) {}

  private range(q: ReferentielQuery) {
    return { from: q.from ? new Date(q.from) : new Date(Date.now() - 12 * HOUR), to: q.to ? new Date(q.to) : new Date(Date.now() + 7 * 24 * HOUR) };
  }

  /** Poste de vente : lignes, arrêts, tarifs, départs avec places déjà vendues. */
  catalog(tenantId: string, q: ReferentielQuery): Promise<{ serverTime: string; lines: CatalogLine[]; trips: RefTrip[] }> {
    const { from, to } = this.range(q);
    return this.db.withTenant(tenantId, async (c) => {
      const lines = await this.lignes.catalog(c);
      const trips = await this.trips.window(c, from, to);
      return { serverTime: new Date().toISOString(), lines, trips: await this.withSold(c, trips) };
    });
  }

  /** Poste de contrôle : clés publiques et billets valides des prochains départs. */
  controlData(tenantId: string, q: ReferentielQuery): Promise<{
    serverTime: string; keys: PublicKeyInfo[]; trips: RefTrip[];
    tickets: { id: string; number: number; tripId: string; seats: number; status: string; validatedAt: Date | null }[];
  }> {
    const { from, to } = this.range(q);
    return this.db.withTenant(tenantId, async (c) => {
      const trips = await this.trips.window(c, from, to);
      const { rows } = await c.query<{ id: string; number: number; trip_id: string; seats: number; status: string; validated_at: Date | null }>(
        "SELECT id, number, trip_id, seats, status, validated_at FROM tickets WHERE trip_id = ANY($1) AND status IN ('vendu', 'valide') ORDER BY number", [trips.map((t) => t.id)],
      );
      return {
        serverTime: new Date().toISOString(),
        keys: await this.keys.list(c),
        trips: await this.withSold(c, trips),
        tickets: rows.map((r) => ({ id: r.id, number: r.number, tripId: r.trip_id, seats: r.seats, status: r.status, validatedAt: r.validated_at })),
      };
    });
  }

  private async withSold(c: Parameters<TripsService['describe']>[0], trips: TripView[]): Promise<RefTrip[]> {
    const { rows } = await c.query<{ trip_id: string; n: string }>(
      "SELECT trip_id, sum(seats) AS n FROM tickets WHERE trip_id = ANY($1) AND status IN ('vendu', 'valide') GROUP BY trip_id", [trips.map((t) => t.id)],
    );
    const sold = new Map(rows.map((r) => [r.trip_id, Number(r.n)]));
    return trips.map((t) => ({ id: t.id, lineId: t.lineId, lineCode: t.lineCode, departureAt: t.departureAt, seats: t.seats, status: t.status, sold: sold.get(t.id) ?? 0 }));
  }
}
