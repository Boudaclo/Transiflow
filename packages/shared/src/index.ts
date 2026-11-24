import { z } from 'zod';

export * from './roles';
export * from './rbac';
export * from './schemas';
export * from './qr';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
