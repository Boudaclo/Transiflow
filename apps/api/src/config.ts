export const CONFIG = 'APP_CONFIG';

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  /** Chiffre les clés privées de signature stockées en base. */
  signingKeySecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const jwtSecret = env.JWT_SECRET;
  const signingKeySecret = env.SIGNING_KEY_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL manquant');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET manquant ou trop court (32 caractères minimum)');
  if (!signingKeySecret || signingKeySecret.length < 32) throw new Error('SIGNING_KEY_SECRET manquant ou trop court (32 caractères minimum)');
  return {
    databaseUrl,
    jwtSecret,
    signingKeySecret,
    accessTtlSeconds: Number(env.ACCESS_TTL_SECONDS ?? 900),
    refreshTtlDays: Number(env.REFRESH_TTL_DAYS ?? 30),
  };
}
