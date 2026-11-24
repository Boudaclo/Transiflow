import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AddStopInput, CreateLineInput, FareCategory, UpdateLineInput, UpsertFareInput } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { isForeignKeyViolation, isUniqueViolation } from '../../database/pg-errors';
import { AuditService } from '../audit';

export interface StopView { id: string; name: string; position: number }
export interface FareView { id: string; fromStopId: string; toStopId: string; category: FareCategory; price: number; active: boolean }
export interface LineView { id: string; code: string; name: string; active: boolean; stops: StopView[]; fares: FareView[] }
export interface CatalogLine { id: string; code: string; name: string; stops: StopView[]; fares: { fromStopId: string; toStopId: string; category: FareCategory; price: number }[] }
export interface LineSummary { id: string; code: string; name: string; active: boolean; stopsCount: number }

interface LineRow { id: string; code: string; name: string; active: boolean }
interface FareRow { id: string; from_stop_id: string; to_stop_id: string; category: FareCategory; price_xof: number; active: boolean }
const fareView = (r: FareRow): FareView => ({ id: r.id, fromStopId: r.from_stop_id, toStopId: r.to_stop_id, category: r.category, price: r.price_xof, active: r.active });
const FARE_COLS = 'id, from_stop_id, to_stop_id, category, price_xof, active';
const DEFER_POSITIONS = 'SET CONSTRAINTS stops_line_position_key DEFERRED';

@Injectable()
export class LignesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  list(tenantId: string): Promise<LineSummary[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<LineRow & { stops_count: string }>(
        `SELECT l.id, l.code, l.name, l.active, (SELECT count(*) FROM stops s WHERE s.line_id = l.id) AS stops_count
         FROM lines l ORDER BY l.code`,
      );
      return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, active: r.active, stopsCount: Number(r.stops_count) }));
    });
  }

  get(tenantId: string, id: string): Promise<LineView> {
    return this.db.withTenant(tenantId, (c) => this.load(c, id));
  }

  create(tenantId: string, input: CreateLineInput, actorId: string): Promise<LineView> {
    return this.db.withTenant(tenantId, async (c) => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>('INSERT INTO lines (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id', [tenantId, input.code, input.name])).rows[0]!.id;
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Ce code de ligne existe déjà');
        throw e;
      }
      for (const [i, name] of input.stops.entries()) {
        await c.query('INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1, $2, $3, $4)', [tenantId, id, name, i + 1]);
      }
      await this.audit.record({ tenantId, userId: actorId, action: 'line.created', objectType: 'line', objectId: id, after: { code: input.code, name: input.name, stops: input.stops } }, c);
      return this.load(c, id);
    });
  }

  update(tenantId: string, id: string, input: UpdateLineInput, actorId: string): Promise<LineView> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = await this.lock(c, id);
      const name = input.name ?? before.name;
      const active = input.active ?? before.active;
      await c.query('UPDATE lines SET name = $2, active = $3 WHERE id = $1', [id, name, active]);
      await this.audit.record({ tenantId, userId: actorId, action: 'line.updated', objectType: 'line', objectId: id, before: { name: before.name, active: before.active }, after: { name, active } }, c);
      return this.load(c, id);
    });
  }

  addStop(tenantId: string, lineId: string, input: AddStopInput, actorId: string): Promise<LineView> {
    return this.db.withTenant(tenantId, async (c) => {
      await this.lock(c, lineId);
      const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stops WHERE line_id = $1', [lineId])).rows[0]!.n);
      const rank = input.position ?? n + 1;
      if (rank > n + 1) throw new BadRequestException(`Position invalide : la ligne a ${n} arrêts`);
      await c.query(DEFER_POSITIONS);
      if (rank <= n) await c.query('UPDATE stops SET position = position + 1 WHERE line_id = $1 AND position >= $2', [lineId, rank]);
      try {
        await c.query('INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1, $2, $3, $4)', [tenantId, lineId, input.name, rank]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Un arrêt de ce nom existe déjà sur cette ligne');
        throw e;
      }
      await this.audit.record({ tenantId, userId: actorId, action: 'stop.added', objectType: 'line', objectId: lineId, after: { name: input.name, position: rank } }, c);
      return this.load(c, lineId);
    });
  }

  renameStop(tenantId: string, lineId: string, stopId: string, name: string, actorId: string): Promise<LineView> {
    return this.db.withTenant(tenantId, async (c) => {
      let before: { name: string } | undefined;
      try {
        before = (await c.query<{ name: string }>('SELECT name FROM stops WHERE id = $1 AND line_id = $2 FOR UPDATE', [stopId, lineId])).rows[0];
        if (!before) throw new NotFoundException('Arrêt introuvable');
        await c.query('UPDATE stops SET name = $2 WHERE id = $1', [stopId, name]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Un arrêt de ce nom existe déjà sur cette ligne');
        throw e;
      }
      await this.audit.record({ tenantId, userId: actorId, action: 'stop.renamed', objectType: 'line', objectId: lineId, before, after: { name } }, c);
      return this.load(c, lineId);
    });
  }

  removeStop(tenantId: string, lineId: string, stopId: string, actorId: string): Promise<LineView> {
    return this.db.withTenant(tenantId, async (c) => {
      await this.lock(c, lineId);
      const stop = (await c.query<{ name: string; position: number }>('SELECT name, position FROM stops WHERE id = $1 AND line_id = $2', [stopId, lineId])).rows[0];
      if (!stop) throw new NotFoundException('Arrêt introuvable');
      const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM stops WHERE line_id = $1', [lineId])).rows[0]!.n);
      if (n <= 2) throw new BadRequestException('Une ligne doit garder au moins 2 arrêts');
      try {
        await c.query('DELETE FROM stops WHERE id = $1', [stopId]);
      } catch (e) {
        if (isForeignKeyViolation(e)) throw new ConflictException('Cet arrêt est utilisé par un tarif : désactivez ou remplacez le tarif d\'abord');
        throw e;
      }
      await c.query(DEFER_POSITIONS);
      await c.query('UPDATE stops SET position = position - 1 WHERE line_id = $1 AND position > $2', [lineId, stop.position]);
      await this.audit.record({ tenantId, userId: actorId, action: 'stop.removed', objectType: 'line', objectId: lineId, before: stop }, c);
      return this.load(c, lineId);
    });
  }

  upsertFare(tenantId: string, lineId: string, input: UpsertFareInput, actorId: string): Promise<FareView> {
    return this.db.withTenant(tenantId, async (c) => {
      await this.lock(c, lineId);
      const stops = (await c.query<{ id: string; position: number }>('SELECT id, position FROM stops WHERE line_id = $1 AND id = ANY($2)', [lineId, [input.fromStopId, input.toStopId]])).rows;
      const from = stops.find((s) => s.id === input.fromStopId);
      const to = stops.find((s) => s.id === input.toStopId);
      if (!from || !to) throw new BadRequestException('Arrêts invalides pour cette ligne');
      if (from.position >= to.position) throw new BadRequestException('Le tarif doit aller d\'un arrêt vers un arrêt suivant de la ligne');
      const before = (await c.query<FareRow>(
        `SELECT ${FARE_COLS} FROM fares WHERE line_id = $1 AND from_stop_id = $2 AND to_stop_id = $3 AND category = $4`,
        [lineId, input.fromStopId, input.toStopId, input.category],
      )).rows[0];
      const row = (await c.query<FareRow>(
        `INSERT INTO fares (tenant_id, line_id, from_stop_id, to_stop_id, category, price_xof) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (line_id, from_stop_id, to_stop_id, category) DO UPDATE SET price_xof = EXCLUDED.price_xof, active = true
         RETURNING ${FARE_COLS}`,
        [tenantId, lineId, input.fromStopId, input.toStopId, input.category, input.price],
      )).rows[0]!;
      await this.audit.record(
        {
          tenantId, userId: actorId, action: 'fare.changed', objectType: 'fare', objectId: row.id,
          before: before ? { price: before.price_xof, active: before.active } : null,
          after: { lineId, fromStopId: input.fromStopId, toStopId: input.toStopId, category: input.category, price: input.price, active: true },
        },
        c,
      );
      return fareView(row);
    });
  }

  setFareActive(tenantId: string, lineId: string, fareId: string, active: boolean, actorId: string): Promise<FareView> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = (await c.query<FareRow>(`SELECT ${FARE_COLS} FROM fares WHERE id = $1 AND line_id = $2 FOR UPDATE`, [fareId, lineId])).rows[0];
      if (!before) throw new NotFoundException('Tarif introuvable');
      const row = (await c.query<FareRow>(`UPDATE fares SET active = $2 WHERE id = $1 RETURNING ${FARE_COLS}`, [fareId, active])).rows[0]!;
      await this.audit.record({ tenantId, userId: actorId, action: 'fare.changed', objectType: 'fare', objectId: fareId, before: { price: before.price_xof, active: before.active }, after: { price: row.price_xof, active } }, c);
      return fareView(row);
    });
  }

  /** Tarif actif d'un trajet (utilisé par la billetterie, dans sa propre transaction). */
  async findActiveFare(c: PoolClient, lineId: string, fromStopId: string, toStopId: string, category: FareCategory): Promise<{ id: string; price: number } | null> {
    const row = (await c.query<{ id: string; price_xof: number }>(
      'SELECT id, price_xof FROM fares WHERE line_id = $1 AND from_stop_id = $2 AND to_stop_id = $3 AND category = $4 AND active',
      [lineId, fromStopId, toStopId, category],
    )).rows[0];
    return row ? { id: row.id, price: row.price_xof } : null;
  }

  /** Lignes actives, arrêts et tarifs actifs : données de référence emportées par les postes hors ligne. */
  async catalog(c: PoolClient): Promise<CatalogLine[]> {
    const lines = (await c.query<LineRow>('SELECT id, code, name, active FROM lines WHERE active ORDER BY code')).rows;
    if (lines.length === 0) return [];
    const ids = lines.map((l) => l.id);
    const stops = (await c.query<StopView & { line_id: string }>('SELECT id, line_id, name, position FROM stops WHERE line_id = ANY($1) ORDER BY position', [ids])).rows;
    const fares = (await c.query<FareRow & { line_id: string }>(`SELECT line_id, ${FARE_COLS} FROM fares WHERE line_id = ANY($1) AND active`, [ids])).rows;
    return lines.map((l) => ({
      id: l.id, code: l.code, name: l.name,
      stops: stops.filter((s) => s.line_id === l.id).map((s) => ({ id: s.id, name: s.name, position: s.position })),
      fares: fares.filter((f) => f.line_id === l.id).map((f) => ({ fromStopId: f.from_stop_id, toStopId: f.to_stop_id, category: f.category, price: f.price_xof })),
    }));
  }

  async lineNames(c: PoolClient, ids: string[]): Promise<Map<string, { code: string; name: string }>> {
    const { rows } = await c.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM lines WHERE id = ANY($1)', [ids]);
    return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
  }

  async stopNames(c: PoolClient, ids: string[]): Promise<Map<string, string>> {
    const { rows } = await c.query<{ id: string; name: string }>('SELECT id, name FROM stops WHERE id = ANY($1)', [ids]);
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async lock(c: PoolClient, id: string): Promise<LineRow> {
    const row = (await c.query<LineRow>('SELECT id, code, name, active FROM lines WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new NotFoundException('Ligne introuvable');
    return row;
  }

  private async load(c: PoolClient, id: string): Promise<LineView> {
    const line = (await c.query<LineRow>('SELECT id, code, name, active FROM lines WHERE id = $1', [id])).rows[0];
    if (!line) throw new NotFoundException('Ligne introuvable');
    const stops = (await c.query<StopView>('SELECT id, name, position FROM stops WHERE line_id = $1 ORDER BY position', [id])).rows;
    const fares = (await c.query<FareRow>(`SELECT ${FARE_COLS} FROM fares WHERE line_id = $1 ORDER BY category, created_at`, [id])).rows;
    return { ...line, stops, fares: fares.map(fareView) };
  }
}

