import { INestApplication } from '@nestjs/common';
import { createStaff, createTenant, createTestApp, get, login, send, superToken, tokenOf, uid, PW } from './helpers';

describe('Droits par rôle et isolation entre compagnies (API)', () => {
  let app: INestApplication;
  let sa: string;
  let A: { tenantId: string; adminEmail: string; adminId: string };
  let B: { tenantId: string; adminEmail: string; adminId: string };
  let dirA: string;
  let dirB: string;
  let userB: { email: string; id: string };

  beforeAll(async () => {
    app = await createTestApp();
    sa = await superToken(app);
    A = await createTenant(app, sa, 'a');
    B = await createTenant(app, sa, 'b');
    dirA = await tokenOf(app, A.adminEmail);
    dirB = await tokenOf(app, B.adminEmail);
    userB = await createStaff(app, dirB, 'caissier');
  });
  afterAll(async () => app.close());

  it('/health est public', async () => { await get(app, '/health').expect(200); });

  it('401 sans jeton sur les routes protégées', async () => {
    await get(app, '/users').expect(401);
    await get(app, '/tenants').expect(401);
  });

  it.each(['caissier', 'controleur', 'exploitation', 'flotte', 'comptable', 'chauffeur'])(
    '%s : 403 sur /users et /tenants',
    async (role) => {
      const s = await createStaff(app, dirA, role);
      const t = await tokenOf(app, s.email);
      await get(app, '/users', t).expect(403);
      await send(app, 'post', '/users', t, { email: `x-${uid()}@t.local`, fullName: 'X Y', password: PW, roles: ['caissier'] }).expect(403);
      await get(app, '/tenants', t).expect(403);
    },
  );

  it('le directeur gère sa compagnie mais pas la plateforme', async () => {
    await get(app, '/users', dirA).expect(200);
    await get(app, '/tenants', dirA).expect(403);
    await send(app, 'post', '/tenants', dirA, { name: 'Pirate', slug: `pirate-${uid()}`, adminEmail: `p-${uid()}@t.local`, adminName: 'Pirate', adminPassword: PW }).expect(403);
  });

  it('le super-admin gère la plateforme mais n\'accède pas aux données d\'une compagnie', async () => {
    await get(app, '/tenants', sa).expect(200);
    await get(app, '/users', sa).expect(403);
  });

  it('chaque directeur ne liste que les utilisateurs de sa compagnie', async () => {
    const listA = (await get(app, '/users', dirA).expect(200)).body as { email: string }[];
    const listB = (await get(app, '/users', dirB).expect(200)).body as { email: string }[];
    expect(listA.map((u) => u.email)).not.toContain(userB.email);
    expect(listB.map((u) => u.email)).toContain(userB.email);
  });

  it('l\'identifiant d\'un utilisateur d\'une autre compagnie renvoie 404 (rien ne fuite)', async () => {
    await send(app, 'put', `/users/${userB.id}/roles`, dirA, { roles: ['directeur'] }).expect(404);
    await send(app, 'patch', `/users/${userB.id}`, dirA, { active: false }).expect(404);
    await login(app, userB.email).expect(200);
  });

  it('ignore un tenant_id envoyé par le client : la compagnie vient du jeton', async () => {
    const email = `spoof-${uid()}@t.local`;
    const res = await send(app, 'post', '/users', dirA, { email, fullName: 'Spoof Test', password: PW, roles: ['caissier'], tenantId: B.tenantId, tenant_id: B.tenantId }).expect(201);
    const listA = (await get(app, '/users', dirA).expect(200)).body as { id: string }[];
    const listB = (await get(app, '/users', dirB).expect(200)).body as { id: string }[];
    expect(listA.map((u) => u.id)).toContain(res.body.id);
    expect(listB.map((u) => u.id)).not.toContain(res.body.id);
  });

  it('interdit d\'attribuer super_admin et valide les mots de passe', async () => {
    await send(app, 'post', '/users', dirA, { email: `r-${uid()}@t.local`, fullName: 'Root Try', password: PW, roles: ['super_admin'] }).expect(400);
    await send(app, 'post', '/users', dirA, { email: `w-${uid()}@t.local`, fullName: 'Weak Pass', password: 'court', roles: ['caissier'] }).expect(400);
  });

  it('refuse un e-mail déjà utilisé, même dans une autre compagnie (409)', async () => {
    await send(app, 'post', '/users', dirA, { email: userB.email, fullName: 'Doublon Test', password: PW, roles: ['caissier'] }).expect(409);
  });

  it('un directeur ne peut ni se désactiver ni se retirer son rôle', async () => {
    await send(app, 'patch', `/users/${A.adminId}`, dirA, { active: false }).expect(400);
    await send(app, 'put', `/users/${A.adminId}/roles`, dirA, { roles: ['caissier'] }).expect(400);
  });

  it('un changement de rôle s\'applique à la connexion suivante', async () => {
    const s = await createStaff(app, dirA, 'caissier');
    await send(app, 'put', `/users/${s.id}/roles`, dirA, { roles: ['comptable'] }).expect(200);
    const me = (await get(app, '/auth/me', await tokenOf(app, s.email)).expect(200)).body;
    expect(me.roles).toEqual(['comptable']);
  });

  it('refuse un slug de compagnie en double (409)', async () => {
    const id = uid();
    const body = { name: 'Doublon', slug: `dbl-${id}`, adminEmail: `a-${id}@t.local`, adminName: 'Admin Dbl', adminPassword: PW };
    await send(app, 'post', '/tenants', sa, body).expect(201);
    await send(app, 'post', '/tenants', sa, { ...body, adminEmail: `b-${id}@t.local` }).expect(409);
  });
});
