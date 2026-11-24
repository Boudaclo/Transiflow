import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import 'reflect-metadata';
import { IS_AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../src/security/decorators';
import { createTestApp } from './helpers';

describe('Chaque route déclare sa sécurité', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => app.close());

  it('aucune route sans @Public, @AuthenticatedOnly ou @RequirePermissions', () => {
    const undeclared: string[] = [];
    let routes = 0;
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const proto = (wrapper.metatype as { prototype: Record<string, unknown> }).prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata('path', handler) === undefined) continue;
          routes++;
          const declared = [IS_PUBLIC, IS_AUTHENTICATED_ONLY, REQUIRED_PERMISSIONS].some(
            (k) => Reflect.getMetadata(k, handler) !== undefined || Reflect.getMetadata(k, wrapper.metatype as object) !== undefined,
          );
          if (!declared) undeclared.push(`${(wrapper.metatype as { name: string }).name}.${name}`);
        }
      }
    }
    expect(routes).toBeGreaterThan(8);
    expect(undeclared).toEqual([]);
  });
});
