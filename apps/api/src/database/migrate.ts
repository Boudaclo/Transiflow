import { Client } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** Applique les migrations SQL (dans l'ordre, une fois chacune). Connexion « propriétaire », jamais l'utilisateur applicatif. */
export async function runMigrations(
  adminUrl: string,
  opts: { dir?: string; appPassword?: string } = {},
): Promise<string[]> {
  const dir = opts.dir ?? join(__dirname, '..', '..', 'migrations');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    if (opts.appPassword) {
      const r = await client.query<{ q: string }>(
        "SELECT format('ALTER ROLE transport_app LOGIN PASSWORD %L', $1::text) AS q",
        [opts.appPassword],
      );
      await client.query(r.rows[0]!.q);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
