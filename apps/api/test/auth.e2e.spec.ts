import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PW, adminPool, createStaff, createTenant, createTestApp, get, login, send, superToken, tokenOf, uid } from './helpers';

describe('Authentification', () => {
  let app: INestApplication;
  let sa: string;
  let dir: { tenantId: string; adminEmail: string; adminId: string };
  beforeAll(async () => {
    app = await createTestApp();
    sa = await superToken(app);
    dir = await createTenant(app, sa, 'auth');
  });
  afterAll(async () => app.close());

  it('connecte un utilisateur : jetons, rôles, permissions', async () => {
    const res = await login(app, dir.adminEmail).expect(200);
    expect(res.body.user).toMatchObject({ email: dir.adminEmail, tenantId: dir.tenantId, roles: ['directeur'] });
    expect(res.body.user.permissions).toContain('administration:administrer');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
  });

  it('stocke les mots de passe en Argon2id et les jetons de rafraîchissement hachés', async () => {
    const pool = adminPool();
    const u = await pool.query('SELECT password_hash FROM users WHERE email = $1', [dir.adminEmail]);
    expect(u.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const res = await login(app, dir.adminEmail).expect(200);
    const secret = (res.body.refreshToken as string).split('.')[1]!;
    const t = await pool.query('SELECT token_hash FROM refresh_tokens WHERE id = $1', [(res.body.refreshToken as string).split('.')[0]]);
    expect(t.rows[0].token_hash).not.toContain(secret);
    await pool.end();
  });

  it('répond pareil pour un e-mail inconnu et un mauvais mot de passe', async () => {
    const a = await login(app, dir.adminEmail, 'mauvais-mot-de-passe').expect(401);
    const b = await login(app, `inconnu-${uid()}@test.local`).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('verrouille le compte après 5 échecs (423), même avec le bon mot de passe', async () => {
    const dirTok = await tokenOf(app, dir.adminEmail);
    const staff = await createStaff(app, dirTok, 'caissier');
    for (let i = 0; i < 5; i++) await login(app, staff.email, 'faux-faux-faux').expect(401);
    await login(app, staff.email).expect(423);
  });

  it('renouvelle la session par rotation du jeton de rafraîchissement', async () => {
    const first = (await login(app, dir.adminEmail).expect(200)).body;
    const second = (await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await get(app, '/auth/me', second.accessToken).expect(200);
  });

  it('détecte la réutilisation d\'un jeton et révoque toute la session', async () => {
    const first = (await login(app, dir.adminEmail).expect(200)).body;
    const second = (await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body;
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });

  it('la déconnexion révoque le jeton de rafraîchissement', async () => {
    const s = (await login(app, dir.adminEmail).expect(200)).body;
    await send(app, 'post', '/auth/logout', s.accessToken, { refreshToken: s.refreshToken }).expect(204);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });

  it('refuse les jetons absents, falsifiés ou signés avec une autre clé', async () => {
    await get(app, '/auth/me').expect(401);
    await get(app, '/auth/me', 'n.importe.quoi').expect(401);
    const forged = await new JwtService({ secret: 'une-autre-cle-une-autre-cle-une-autre-cle' }).signAsync({ sub: dir.adminId, tid: dir.tenantId, roles: ['directeur'] });
    await get(app, '/auth/me', forged).expect(401);
  });

  it('un utilisateur désactivé ne peut plus ni se connecter ni renouveler sa session', async () => {
    const dirTok = await tokenOf(app, dir.adminEmail);
    const staff = await createStaff(app, dirTok, 'controleur');
    const s = (await login(app, staff.email).expect(200)).body;
    await send(app, 'patch', `/users/${staff.id}`, dirTok, { active: false }).expect(200);
    await login(app, staff.email).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });

  it('une compagnie désactivée bloque ses utilisateurs', async () => {
    const other = await createTenant(app, sa, 'off');
    const s = (await login(app, other.adminEmail).expect(200)).body;
    await send(app, 'patch', `/tenants/${other.tenantId}`, sa, { active: false }).expect(200);
    await login(app, other.adminEmail).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });

  it('journalise connexions et échecs', async () => {
    const pool = adminPool();
    const r = await pool.query("SELECT action FROM audit_logs WHERE tenant_id = $1", [dir.tenantId]);
    const actions = r.rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.created', 'user.created', 'auth.login', 'auth.login_failed', 'auth.refresh_reuse_detected']));
    await pool.end();
  });

  it('valide les entrées (400)', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'pas-un-email', password: PW }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({}).expect(400);
  });
});
