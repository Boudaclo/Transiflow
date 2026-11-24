import { runMigrations } from './database/migrate';

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL manquant');
  const applied = await runMigrations(url, { appPassword: process.env.APP_DB_PASSWORD });
  console.log(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Base à jour');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
