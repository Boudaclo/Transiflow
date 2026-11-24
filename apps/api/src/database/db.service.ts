import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig, CONFIG } from '../config';

type Work<T> = (client: PoolClient) => Promise<T>;

/** Toute requête métier passe par une transaction qui pose le contexte de compagnie (RLS). */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  }

  withTenant<T>(tenantId: string, fn: Work<T>): Promise<T> {
    return this.run({ 'app.tenant_id': tenantId }, fn);
  }

  /** Lecture seule sur une photo unique de la base : tous les chiffres d'un rapport sont cohérents entre eux. */
  withTenantSnapshot<T>(tenantId: string, fn: Work<T>): Promise<T> {
    return this.run({ 'app.tenant_id': tenantId }, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  withPlatform<T>(fn: Work<T>): Promise<T> {
    return this.run({ 'app.is_platform': 'on' }, fn);
  }

  /** tenantId null = compte plateforme. */
  scope<T>(tenantId: string | null, fn: Work<T>): Promise<T> {
    return tenantId ? this.withTenant(tenantId, fn) : this.withPlatform(fn);
  }

  /** Sans contexte : réservé aux fonctions SQL SECURITY DEFINER (auth_find_*). */
  async queryDirect<R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    return (await this.pool.query<R>(text, values)).rows;
  }

  private async run<T>(settings: Record<string, string>, fn: Work<T>, begin = 'BEGIN'): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(begin);
      for (const [key, value] of Object.entries(settings)) {
        await client.query('SELECT set_config($1, $2, true)', [key, value]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
