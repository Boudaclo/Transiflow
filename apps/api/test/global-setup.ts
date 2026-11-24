import { Client } from 'pg';
import { runMigrations } from '../src/database/migrate';

// Tests d'intégration sur une vraie base PostgreSQL (la RLS ne se simule pas).
export default async function globalSetup(): Promise<void> {
  const server = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const dbName = 'transport_test';
  const admin = new Client({ connectionString: server });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const base = new URL(server);
  const adminUrl = new URL(base);
  adminUrl.pathname = `/${dbName}`;
  const appUrl = new URL(adminUrl);
  appUrl.username = 'transport_app';
  appUrl.password = 'app_test_pw';

  await runMigrations(adminUrl.toString(), { appPassword: 'app_test_pw' });
  process.env.DATABASE_ADMIN_URL = adminUrl.toString();
  process.env.DATABASE_URL = appUrl.toString();
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-32+';
  process.env.SIGNING_KEY_SECRET = 'signing-secret-signing-secret-32-chars+';
}
