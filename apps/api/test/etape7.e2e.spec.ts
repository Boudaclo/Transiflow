import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PW, createStaff, createTenant, createTestApp, get, send, superToken, tokenOf } from './helpers';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

describe('Étape 7 : journal d\'audit, paramètres de compagnie, historique client', () => {
  let app: INestApplication;
  let dirA: string; let dirB: string; let caissierA: string;
  beforeAll(async () => {
    app = await createTestApp();
    const sa = await superToken(app);
    const a = await createTenant(app, sa, 'a');
    const b = await createTenant(app, sa, 'b');
    dirA = await tokenOf(app, a.adminEmail);
    dirB = await tokenOf(app, b.adminEmail);
    caissierA = await tokenOf(app, (await createStaff(app, dirA, 'caissier')).email);
  });
  afterAll(async () => app.close());

  it('le journal d\'audit est lisible par le directeur, filtrable par préfixe, et propre à sa compagnie', async () => {
    const res = await get(app, '/audit?limit=50', dirA).expect(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items.every((i: { action: string }) => typeof i.action === 'string')).toBe(true);
    const users = await get(app, '/audit?action=user.', dirA).expect(200);
    expect(users.body.items.length).toBeGreaterThan(0);
    expect(users.body.items.every((i: { action: string }) => i.action.startsWith('user.'))).toBe(true);
    // la compagnie B ne voit rien de A
    const b = await get(app, '/audit?limit=100&action=user.', dirB).expect(200);
    const aIds = new Set(users.body.items.map((i: { id: number }) => i.id));
    expect(b.body.items.some((i: { id: number }) => aIds.has(i.id))).toBe(false);
  });

  it('le journal est refusé (403) à un caissier', async () => {
    await get(app, '/audit', caissierA).expect(403);
    await get(app, '/audit').expect(401);
  });

  it('paramètres de compagnie : lecture pour tous, modification réservée à l\'administration, journalisée', async () => {
    const before = await get(app, '/compagnie', caissierA).expect(200);
    expect(before.body.currency).toBe('XOF');
    expect(before.body.logo).toBeNull();
    await send(app, 'patch', '/compagnie', caissierA, { name: 'Pirate' }).expect(403);
    const upd = await send(app, 'patch', '/compagnie', dirA, { name: 'Transports Faso', logo: LOGO }).expect(200);
    expect(upd.body).toMatchObject({ name: 'Transports Faso', logo: LOGO });
    await send(app, 'patch', '/compagnie', dirA, { logo: 'http://exemple.bf/x.png' }).expect(400);
    await send(app, 'patch', '/compagnie', dirA, {}).expect(400);
    const removed = await send(app, 'patch', '/compagnie', dirA, { logo: null }).expect(200);
    expect(removed.body.logo).toBeNull();
    expect(removed.body.name).toBe('Transports Faso');
    const log = await get(app, '/audit?action=tenant.updated', dirA).expect(200);
    expect(log.body.total).toBeGreaterThanOrEqual(2);
    // l'autre compagnie garde son nom
    expect((await get(app, '/compagnie', dirB).expect(200)).body.name).not.toBe('Transports Faso');
  });

  it('historique client : les billets se filtrent par client', async () => {
    const client = (await send(app, 'post', '/clients', dirA, { fullName: 'Awa Ouedraogo', phone: `+2267${Math.floor(1000000 + Math.random() * 8999999)}` }).expect(201)).body;
    const line = (await send(app, 'post', '/lignes', dirA, { code: `H${Date.now() % 1000}`, name: 'Ouaga - Bobo', stops: ['Ouagadougou', 'Bobo-Dioulasso'] }).expect(201)).body;
    const [from, to] = line.stops;
    await send(app, 'put', `/lignes/${line.id}/tarifs`, dirA, { fromStopId: from.id, toStopId: to.id, price: 6500 }).expect(200);
    const trip = (await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: new Date(Date.now() + 3600e3).toISOString(), seats: 30 }).expect(201)).body;
    const sell = (clientId?: string) => send(app, 'post', '/billetterie/ventes', caissierA, {
      ticketId: randomUUID(), tripId: trip.id, fromStopId: from.id, toStopId: to.id, seats: 1, ...(clientId ? { clientId } : {}), payment: { method: 'especes' },
    }).expect(201);
    await sell(client.id); await sell(client.id); await sell();
    const res = await get(app, `/billetterie/tickets?clientId=${client.id}`, caissierA).expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.every((t: { clientId: string }) => t.clientId === client.id)).toBe(true);
  });

  it('mot de passe oublié : l\'administrateur définit un nouveau mot de passe, l\'ancien et les sessions tombent, journalisé sans le secret', async () => {
    const staff = await createStaff(app, dirA, 'controleur');
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send( { email: staff.email, password: PW }).expect(200);
    const id = staff.id;
    await send(app, 'post', `/users/${id}/mot-de-passe`, caissierA, { password: 'NouveauMotDePasse-42' }).expect(403);
    await send(app, 'post', `/users/${id}/mot-de-passe`, dirA, { password: 'court' }).expect(400);
    await send(app, 'post', `/users/${id}/mot-de-passe`, dirA, { password: 'NouveauMotDePasse-42' }).expect(204);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send( { email: staff.email, password: PW }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send( { email: staff.email, password: 'NouveauMotDePasse-42' }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send( { refreshToken: login.body.refreshToken }).expect(401);
    const log = await get(app, '/audit?action=user.password_reset', dirA).expect(200);
    expect(log.body.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(log.body)).not.toContain('NouveauMotDePasse');
  });
});
