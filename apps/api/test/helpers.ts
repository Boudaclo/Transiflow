import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { UsersService } from '../src/modules/auth';

export const PW = 'MotDePasse#2026';
export const SUPER_EMAIL = 'root@test.local';
export const uid = () => randomUUID().slice(0, 8);

export async function createTestApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  await app.get(UsersService, { strict: false }).ensureSuperAdmin(SUPER_EMAIL, PW);
  return app;
}
/** Connexion « propriétaire » : contourne la RLS, réservée à la vérification des tests. */
export const adminPool = () => new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
export const appPool = () => new Pool({ connectionString: process.env.DATABASE_URL });

export function login(app: INestApplication, email: string, password = PW) {
  return request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
}
export async function tokenOf(app: INestApplication, email: string, password = PW): Promise<string> {
  const res = await login(app, email, password).expect(200);
  return res.body.accessToken as string;
}
export const superToken = (app: INestApplication) => tokenOf(app, SUPER_EMAIL);

export async function createTenant(app: INestApplication, sa: string, label = 'cie') {
  const id = uid();
  const body = {
    name: `Compagnie ${label} ${id}`, slug: `${label}-${id}`,
    adminEmail: `dir-${id}@test.local`, adminName: 'Directeur Test', adminPassword: PW,
  };
  const res = await request(app.getHttpServer()).post('/api/v1/tenants').set('Authorization', `Bearer ${sa}`).send(body).expect(201);
  return { tenantId: res.body.id as string, adminEmail: body.adminEmail, adminId: res.body.admin.id as string };
}
export async function createStaff(app: INestApplication, directeurToken: string, role: string) {
  const email = `${role}-${uid()}@test.local`;
  const res = await request(app.getHttpServer()).post('/api/v1/users').set('Authorization', `Bearer ${directeurToken}`)
    .send({ email, fullName: `Test ${role}`, password: PW, roles: [role] }).expect(201);
  return { email, id: res.body.id as string };
}
export const get = (app: INestApplication, url: string, token?: string) => {
  const r = request(app.getHttpServer()).get(`/api/v1${url}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
export const send = (app: INestApplication, method: 'post' | 'put' | 'patch', url: string, token: string, body: object) =>
  request(app.getHttpServer())[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body);
export const del = (app: INestApplication, url: string, token: string) =>
  request(app.getHttpServer()).delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
