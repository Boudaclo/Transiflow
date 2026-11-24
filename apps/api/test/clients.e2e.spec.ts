import { INestApplication } from '@nestjs/common';
import { createStaff, createTenant, createTestApp, get, send, superToken, tokenOf, uid } from './helpers';

describe('Clients', () => {
  let app: INestApplication;
  let dirA: string;
  let dirB: string;
  const tokens: Record<string, string> = {};
  const phone = () => `+22670${Math.floor(100000 + Math.random() * 899999)}`;

  beforeAll(async () => {
    app = await createTestApp();
    const sa = await superToken(app);
    const A = await createTenant(app, sa, 'cla');
    const B = await createTenant(app, sa, 'clb');
    dirA = await tokenOf(app, A.adminEmail);
    dirB = await tokenOf(app, B.adminEmail);
    for (const role of ['caissier', 'controleur', 'comptable', 'flotte', 'exploitation']) {
      tokens[role] = await tokenOf(app, (await createStaff(app, dirA, role)).email);
    }
  });
  afterAll(async () => app.close());

  it('le caissier crée un client ; téléphone normalisé', async () => {
    const res = await send(app, 'post', '/clients', tokens.caissier!, { fullName: '  Awa Ouédraogo ', phone: '+226 70 12 34 56' }).expect(201);
    expect(res.body).toMatchObject({ fullName: 'Awa Ouédraogo', phone: '+22670123456', email: null });
  });

  it('droits : contrôleur et comptable lisent, ne créent pas ; flotte et exploitation sont refusés', async () => {
    const body = { fullName: 'Test Droits', phone: phone() };
    for (const role of ['controleur', 'comptable']) {
      await get(app, '/clients', tokens[role]).expect(200);
      await send(app, 'post', '/clients', tokens[role]!, body).expect(403);
    }
    for (const role of ['flotte', 'exploitation']) await get(app, '/clients', tokens[role]).expect(403);
    await send(app, 'post', '/clients', dirA, { fullName: 'Par Directeur', phone: phone() }).expect(201);
  });

  it('refuse un numéro en double dans la compagnie (409 + id du client) mais pas dans une autre', async () => {
    const p = phone();
    const first = await send(app, 'post', '/clients', tokens.caissier!, { fullName: 'Premier Client', phone: p }).expect(201);
    const dup = await send(app, 'post', '/clients', tokens.caissier!, { fullName: 'Doublon Client', phone: p.replace('+226', '+226 ') }).expect(409);
    expect(dup.body.clientId).toBe(first.body.id);
    await send(app, 'post', '/clients', dirB, { fullName: 'Autre Compagnie', phone: p }).expect(201);
  });

  it('valide les entrées (400)', async () => {
    await send(app, 'post', '/clients', dirA, { fullName: 'X', phone: phone() }).expect(400);
    await send(app, 'post', '/clients', dirA, { fullName: 'Nom Valide', phone: '123' }).expect(400);
    await send(app, 'post', '/clients', dirA, { fullName: 'Nom Valide', phone: phone(), email: 'pas-un-email' }).expect(400);
    await get(app, '/clients?limit=1000', dirA).expect(400);
  });

  it('recherche par nom et par téléphone, avec pagination', async () => {
    const tag = uid();
    for (let i = 0; i < 3; i++) await send(app, 'post', '/clients', dirA, { fullName: `Zorro${tag} Numéro${i}`, phone: phone() }).expect(201);
    const byName = (await get(app, `/clients?q=zorro${tag}`, dirA).expect(200)).body;
    expect(byName.total).toBe(3);
    const page = (await get(app, `/clients?q=zorro${tag}&limit=2&offset=2`, dirA).expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    const one = byName.items[0];
    const byPhone = (await get(app, `/clients?q=${encodeURIComponent(one.phone.slice(-6))}`, dirA).expect(200)).body;
    expect(byPhone.items.map((c: { id: string }) => c.id)).toContain(one.id);
  });

  it('les caractères joker de recherche (% _) sont traités comme du texte', async () => {
    const res = (await get(app, `/clients?q=${encodeURIComponent('%')}`, dirA).expect(200)).body;
    expect(res.total).toBe(0);
  });

  it('modifie un client ; refuse un numéro déjà pris', async () => {
    const a = (await send(app, 'post', '/clients', dirA, { fullName: 'Modif Client', phone: phone() }).expect(201)).body;
    const b = (await send(app, 'post', '/clients', dirA, { fullName: 'Autre Client', phone: phone() }).expect(201)).body;
    const upd = await send(app, 'patch', `/clients/${a.id}`, tokens.caissier!, { fullName: 'Nom Modifié', email: 'Awa@Exemple.BF' }).expect(200);
    expect(upd.body).toMatchObject({ fullName: 'Nom Modifié', email: 'awa@exemple.bf' });
    await send(app, 'patch', `/clients/${a.id}`, dirA, { phone: b.phone }).expect(409);
    await send(app, 'patch', `/clients/${a.id}`, dirA, {}).expect(400);
  });

  it('isolation : une compagnie ne voit ni ne modifie les clients d\'une autre', async () => {
    const mine = (await send(app, 'post', '/clients', dirB, { fullName: 'Client Privé B', phone: phone() }).expect(201)).body;
    const listA = (await get(app, '/clients?limit=100', dirA).expect(200)).body.items as { id: string }[];
    expect(listA.map((c) => c.id)).not.toContain(mine.id);
    await get(app, `/clients/${mine.id}`, dirA).expect(404);
    await send(app, 'patch', `/clients/${mine.id}`, dirA, { fullName: 'Piraté Client' }).expect(404);
    await get(app, `/clients/${mine.id}`, dirB).expect(200);
  });
});
