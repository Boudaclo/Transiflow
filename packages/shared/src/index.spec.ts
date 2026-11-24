import { ROLES, healthResponseSchema } from './index';

describe('shared', () => {
  it('définit les 8 rôles du cahier des charges', () => {
    expect(ROLES).toHaveLength(8);
  });
  it('valide une réponse de santé correcte et refuse une incorrecte', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', service: 'x', time: 't' }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: 'ko' }).success).toBe(false);
  });
});
