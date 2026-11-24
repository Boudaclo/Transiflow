import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UsersService } from './modules/auth';

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD absents : aucun compte plateforme créé');
    return;
  }
  if (password.length < 10) throw new Error('BOOTSTRAP_ADMIN_PASSWORD : 10 caractères minimum');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const created = await app.get(UsersService, { strict: false }).ensureSuperAdmin(email, password);
  console.log(created ? `Super-administrateur créé : ${email}` : 'Super-administrateur déjà présent');
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
