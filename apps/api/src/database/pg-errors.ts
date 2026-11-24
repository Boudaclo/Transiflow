export const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === '23505';
export const isForeignKeyViolation = (e: unknown): boolean => (e as { code?: string })?.code === '23503';
export const constraintOf = (e: unknown): string | undefined => (e as { constraint?: string })?.constraint;
