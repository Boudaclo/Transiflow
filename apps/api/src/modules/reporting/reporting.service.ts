import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DashboardQuery, ExportQuery, Granularity, ReportDeparturesQuery } from '@transport/shared';
import { DbService } from '../../database/db.service';
import {
  CategorySales, MethodSales, SalesFilter, SalesStatsService, SalesTotals, SeriesPoint,
} from '../billetterie';
import { LignesService, TripsService } from '../lignes';

const DAY = 24 * 3600 * 1000;
export const EXPORT_MAX_ROWS = 50_000;
const MAX_DAYS = 366;

export interface Period { from: Date; toDay: Date; toExclusive: Date; days: number }
export interface LineReport {
  lineId: string; code: string; name: string; revenue: number; tickets: number; seats: number;
  trips: number; capacity: number; soldSeats: number; fillRatePct: number | null;
}
export interface Dashboard {
  period: { from: string; to: string; days: number; granularity: Granularity; lineId: string | null };
  totals: SalesTotals & { averageTicket: number };
  previous: { from: string; to: string; revenue: number; tickets: number; revenueEvolutionPct: number | null; ticketsEvolutionPct: number | null };
  series: SeriesPoint[];
  fill: { trips: number; capacity: number; soldSeats: number; ratePct: number | null };
  lines: LineReport[];
  byPaymentMethod: MethodSales[];
  byCategory: CategorySales[];
}
export interface DepartureReport {
  id: string; lineId: string; lineCode: string; lineName: string; departureAt: Date; status: string;
  seats: number; soldSeats: number; remaining: number; fillRatePct: number | null; tickets: number; revenue: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (s: string) => new Date(`${s}T00:00:00.000Z`);
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const evolution = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Période par défaut : les 30 derniers jours, aujourd'hui compris. Jours calendaires UTC (le Burkina Faso est à UTC+0). */
export function resolvePeriod(from?: string, to?: string, now = new Date()): Period {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toDay = to ? utcDay(to) : today;
  const fromDay = from ? utcDay(from) : new Date(toDay.getTime() - 29 * DAY);
  if (fromDay > toDay) throw new BadRequestException('La date de début doit précéder la date de fin');
  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY) + 1;
  if (days > MAX_DAYS) throw new BadRequestException(`Période limitée à ${MAX_DAYS} jours`);
  return { from: fromDay, toDay, toExclusive: new Date(toDay.getTime() + DAY), days };
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly db: DbService,
    private readonly stats: SalesStatsService,
    private readonly lignes: LignesService,
    private readonly trips: TripsService,
  ) {}

  /** Tableau de bord complet. Tous les chiffres viennent d'une même photo de la base : ils sont cohérents entre eux. */
  dashboard(tenantId: string, q: DashboardQuery): Promise<Dashboard> {
    const p = resolvePeriod(q.from, q.to);
    const f: SalesFilter = { from: p.from, toExclusive: p.toExclusive, lineId: q.lineId };
    const prevTo = new Date(p.from.getTime() - DAY);
    const prevFrom = new Date(prevTo.getTime() - (p.days - 1) * DAY);
    const prevFilter: SalesFilter = { from: prevFrom, toExclusive: p.from, lineId: q.lineId };

    return this.db.withTenantSnapshot(tenantId, async (c) => {
      await this.requireLine(c, q.lineId);
      const [totals, prev, series, salesByLine, byPaymentMethod, byCategory, departures] = await Promise.all([
        this.stats.totals(c, f), this.stats.totals(c, prevFilter), this.stats.series(c, f, q.granularity),
        this.stats.byLine(c, f), this.stats.byMethod(c, f), this.stats.byCategory(c, f), this.trips.capacityIn(c, p.from, p.toExclusive, q.lineId),
      ]);
      const tripStats = await this.stats.tripStats(c, departures.map((t) => t.id));

      const fillByLine = new Map<string, { trips: number; capacity: number; soldSeats: number }>();
      for (const t of departures) {
        const e = fillByLine.get(t.lineId) ?? { trips: 0, capacity: 0, soldSeats: 0 };
        e.trips++;
        e.capacity += t.seats;
        e.soldSeats += tripStats.get(t.id)?.soldSeats ?? 0;
        fillByLine.set(t.lineId, e);
      }
      const lineIds = [...new Set([...salesByLine.map((l) => l.lineId), ...fillByLine.keys()])];
      const names = await this.lignes.lineNames(c, lineIds);
      const lines: LineReport[] = lineIds.map((id) => {
        const s = salesByLine.find((l) => l.lineId === id);
        const fl = fillByLine.get(id) ?? { trips: 0, capacity: 0, soldSeats: 0 };
        return {
          lineId: id, code: names.get(id)?.code ?? '', name: names.get(id)?.name ?? '', revenue: s?.revenue ?? 0, tickets: s?.tickets ?? 0, seats: s?.seats ?? 0,
          trips: fl.trips, capacity: fl.capacity, soldSeats: fl.soldSeats, fillRatePct: pct(fl.soldSeats, fl.capacity),
        };
      }).sort((a, b) => b.revenue - a.revenue || a.code.localeCompare(b.code));
      const capacity = lines.reduce((n, l) => n + l.capacity, 0);
      const soldSeats = lines.reduce((n, l) => n + l.soldSeats, 0);

      return {
        period: { from: iso(p.from), to: iso(p.toDay), days: p.days, granularity: q.granularity, lineId: q.lineId ?? null },
        totals: { ...totals, averageTicket: totals.tickets > 0 ? Math.round(totals.revenue / totals.tickets) : 0 },
        previous: {
          from: iso(prevFrom), to: iso(prevTo), revenue: prev.revenue, tickets: prev.tickets,
          revenueEvolutionPct: evolution(totals.revenue, prev.revenue), ticketsEvolutionPct: evolution(totals.tickets, prev.tickets),
        },
        series, fill: { trips: departures.length, capacity, soldSeats, ratePct: pct(soldSeats, capacity) },
        lines, byPaymentMethod, byCategory,
      };
    });
  }

  /** Fréquentation départ par départ. */
  departures(tenantId: string, q: ReportDeparturesQuery): Promise<{ items: DepartureReport[]; total: number; limit: number; offset: number }> {
    const p = resolvePeriod(q.from, q.to);
    return this.db.withTenantSnapshot(tenantId, async (c) => {
      await this.requireLine(c, q.lineId);
      const page = await this.trips.pageIn(c, p.from, p.toExclusive, q.lineId, q.limit, q.offset);
      const stats = await this.stats.tripStats(c, page.items.map((t) => t.id));
      return {
        total: page.total, limit: q.limit, offset: q.offset,
        items: page.items.map((t) => {
          const s = stats.get(t.id);
          const sold = s?.soldSeats ?? 0;
          return {
            id: t.id, lineId: t.lineId, lineCode: t.lineCode, lineName: t.lineName, departureAt: t.departureAt, status: t.status,
            seats: t.seats, soldSeats: sold, remaining: t.seats - sold, fillRatePct: pct(sold, t.seats), tickets: s?.tickets ?? 0, revenue: s?.revenue ?? 0,
          };
        }),
      };
    });
  }

  /** Journal des ventes en CSV (UTF-8 avec BOM, séparateur « ; » : s'ouvre directement dans Excel en français). */
  exportCsv(tenantId: string, q: ExportQuery): Promise<{ filename: string; csv: string }> {
    const p = resolvePeriod(q.from, q.to);
    const f: SalesFilter = { from: p.from, toExclusive: p.toExclusive, lineId: q.lineId };
    return this.db.withTenantSnapshot(tenantId, async (c) => {
      await this.requireLine(c, q.lineId);
      if ((await this.stats.journalCount(c, f)) > EXPORT_MAX_ROWS) {
        throw new BadRequestException(`Plus de ${EXPORT_MAX_ROWS} billets sur la période : réduisez la période`);
      }
      const rows = await this.stats.journal(c, f, EXPORT_MAX_ROWS);
      const lines = await this.lignes.lineNames(c, [...new Set(rows.map((r) => r.lineId))]);
      const stops = await this.lignes.stopNames(c, [...new Set(rows.flatMap((r) => [r.fromStopId, r.toStopId]))]);
      const trips = rows.length ? await this.trips.describe(c, [...new Set(rows.map((r) => r.tripId))]) : new Map();
      const out = [
        ['Numéro', 'Date de vente (UTC)', 'Ligne', 'Départ (UTC)', 'Arrêt de départ', "Arrêt d'arrivée", 'Catégorie', 'Places', 'Prix unitaire (FCFA)', 'Total (FCFA)',
          'Moyen de paiement', 'Référence', 'Statut du paiement', 'Statut du billet', 'Vendu hors ligne', "Justification d'annulation"],
        ...rows.map((r) => [
          r.number, stamp(r.soldAt), lines.get(r.lineId)?.code ?? '', trips.get(r.tripId) ? stamp(trips.get(r.tripId)!.departureAt) : '',
          stops.get(r.fromStopId) ?? '', stops.get(r.toStopId) ?? '', r.category, r.seats, r.unitPrice, r.total,
          r.method, r.reference, r.paymentStatus, r.status, r.offline ? 'oui' : 'non', r.cancelReason,
        ]),
      ];
      return { filename: `ventes_${iso(p.from)}_${iso(p.toDay)}.csv`, csv: '\uFEFF' + out.map(csvRow).join('\r\n') + '\r\n' };
    });
  }

  private async requireLine(c: PoolClient, lineId?: string): Promise<void> {
    if (lineId && !(await this.lignes.lineNames(c, [lineId])).has(lineId)) throw new NotFoundException('Ligne introuvable');
  }
}

const stamp = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
/** Protection contre l'injection de formules (=, +, -, @) quand le fichier est ouvert dans un tableur. */
const csvText = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
const csvRow = (cells: (string | number | null)[]): string => cells.map((v) => (typeof v === 'number' ? String(v) : v === null ? '' : csvText(v))).join(';');
