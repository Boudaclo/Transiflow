import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { healthResponseSchema } from '@transport/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('GET /api/v1/health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => app.close());

  it('répond 200 avec un corps conforme au schéma partagé', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
