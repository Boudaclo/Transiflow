import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Au moins 10 caractères').max(128);
const assignableRole = z.enum(['directeur', 'caissier', 'controleur', 'exploitation', 'flotte', 'comptable', 'chauffeur']);

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const refreshSchema = z.object({ refreshToken: z.string().min(10).max(200) });

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().min(2).max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Minuscules, chiffres et tirets'),
  adminEmail: email,
  adminName: z.string().trim().min(2).max(120),
  adminPassword: password,
});
export const createUserSchema = z.object({
  email,
  fullName: z.string().trim().min(2).max(120),
  password,
  roles: z.array(assignableRole).min(1).max(7),
});
export const setRolesSchema = z.object({ roles: z.array(assignableRole).min(1).max(7) });
export const setPasswordSchema = z.object({ password });
export const setActiveSchema = z.object({ active: z.boolean() });

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type SetRolesInput = z.infer<typeof setRolesSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type SetActiveInput = z.infer<typeof setActiveSchema>;

// ---------- Étape 3 : clients, lignes, tarifs, départs ----------
export const FARE_CATEGORIES = ['plein_tarif', 'enfant', 'etudiant'] as const;
export type FareCategory = (typeof FARE_CATEGORIES)[number];
export const TRIP_STATUSES = ['actif', 'retarde', 'annule'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

const phone = z
  .string()
  .transform((s) => s.replace(/[\s.-]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{8,15}$/, 'Numéro de téléphone invalide'));
const personName = z.string().trim().min(2).max(120);
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
};

export const createClientSchema = z.object({
  fullName: personName,
  phone,
  email: z.string().trim().toLowerCase().email().max(254).nullish(),
});
export const updateClientSchema = z
  .object({ fullName: personName, phone, email: z.string().trim().toLowerCase().email().max(254).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier');
export const listClientsQuery = z.object({ q: z.string().trim().max(100).optional(), ...page });

const stopName = z.string().trim().min(2).max(80);
export const createLineSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, 'Code : 2 à 12 lettres, chiffres ou tirets'),
  name: z.string().trim().min(2).max(120),
  stops: z
    .array(stopName)
    .min(2, 'Une ligne a au moins 2 arrêts')
    .max(40)
    .refine((a) => new Set(a.map((s) => s.toLowerCase())).size === a.length, 'Deux arrêts portent le même nom'),
});
export const updateLineSchema = z
  .object({ name: z.string().trim().min(2).max(120), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier');
export const addStopSchema = z.object({ name: stopName, position: z.number().int().min(1).max(41).optional() });
export const renameStopSchema = z.object({ name: stopName });
export const upsertFareSchema = z.object({
  fromStopId: z.string().uuid(),
  toStopId: z.string().uuid(),
  category: z.enum(FARE_CATEGORIES).default('plein_tarif'),
  price: z.number().int().min(1).max(1_000_000),
});

const instant = z.string().datetime({ offset: true });
export const createTripSchema = z.object({
  lineId: z.string().uuid(),
  departureAt: instant,
  seats: z.number().int().min(1).max(100),
});
export const updateTripSchema = z
  .object({ status: z.enum(TRIP_STATUSES), departureAt: instant, seats: z.number().int().min(1).max(100) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier');
export const listTripsQuery = z.object({
  lineId: z.string().uuid().optional(),
  from: instant.optional(),
  to: instant.optional(),
  ...page,
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuery>;
export type CreateLineInput = z.infer<typeof createLineSchema>;
export type UpdateLineInput = z.infer<typeof updateLineSchema>;
export type AddStopInput = z.infer<typeof addStopSchema>;
export type RenameStopInput = z.infer<typeof renameStopSchema>;
export type UpsertFareInput = z.infer<typeof upsertFareSchema>;
export type CreateTripInput = z.infer<typeof createTripSchema>;
export type UpdateTripInput = z.infer<typeof updateTripSchema>;
export type ListTripsQuery = z.infer<typeof listTripsQuery>;

// ---------- Étape 4 : billetterie et contrôle ----------
export const PAYMENT_METHODS = ['especes', 'orange_money', 'moov_money'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const TICKET_STATUSES = ['vendu', 'valide', 'annule'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const paymentSchema = z
  .object({ method: z.enum(PAYMENT_METHODS), reference: z.string().trim().min(3).max(64).optional() })
  .refine((p) => p.method === 'especes' || !!p.reference, { message: 'Référence de transaction obligatoire pour le mobile money', path: ['reference'] });

export const sellTicketSchema = z.object({
  /** Généré par le poste : sert d'identifiant et rend la vente rejouable sans doublon. */
  ticketId: z.string().uuid(),
  tripId: z.string().uuid(),
  fromStopId: z.string().uuid(),
  toStopId: z.string().uuid(),
  category: z.enum(FARE_CATEGORIES).default('plein_tarif'),
  seats: z.number().int().min(1).max(10).default(1),
  clientId: z.string().uuid().optional(),
  payment: paymentSchema,
});
export const cancelTicketSchema = z.object({ reason: z.string().trim().min(5, 'Justification trop courte').max(300) });
export const validateTicketSchema = z
  .object({ qr: z.string().trim().min(20).max(400).optional(), number: z.number().int().min(1).optional(), tripId: z.string().uuid().optional() })
  .refine((v) => (v.qr !== undefined) !== (v.number !== undefined), 'Fournir soit « qr », soit « number »');
export const listTicketsQuery = z.object({
  tripId: z.string().uuid().optional(),
  number: z.coerce.number().int().min(1).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  clientId: z.string().uuid().optional(),
  ...page,
});

export type SellTicketInput = z.infer<typeof sellTicketSchema>;
export type CancelTicketInput = z.infer<typeof cancelTicketSchema>;
export type ValidateTicketInput = z.infer<typeof validateTicketSchema>;
export type ListTicketsQuery = z.infer<typeof listTicketsQuery>;

// ---------- Étape 5 : postes, hors ligne, anomalies ----------
export const DEVICE_KINDS = ['vente', 'controle'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_STATUSES = ['en_attente', 'actif', 'revoque'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
export const ANOMALY_KINDS = [
  'surreservation', 'depart_annule', 'ecart_tarif', 'reference_dupliquee', 'vente_rejetee',
  'validation_doublon', 'validation_billet_annule', 'horloge_decalee',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

// Clé publique Ed25519 : 32 octets en Base64 URL = 43 caractères
const publicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Clé publique Ed25519 invalide');
export const requestDeviceSchema = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(DEVICE_KINDS), publicKey });
export const revokeDeviceSchema = z.object({ reason: z.string().trim().min(5, 'Justification trop courte').max(300) });
export const reserveRangeSchema = z.object({ size: z.number().int().min(1).max(500).default(200) });
export const referentielQuery = z.object({ from: instant.optional(), to: instant.optional() });

export const offlineSaleSchema = z.object({
  ticketId: z.string().uuid(),
  number: z.number().int().min(1),
  tripId: z.string().uuid(),
  fromStopId: z.string().uuid(),
  toStopId: z.string().uuid(),
  category: z.enum(FARE_CATEGORIES),
  seats: z.number().int().min(1).max(10),
  total: z.number().int().min(1).max(10_000_000),
  clientId: z.string().uuid().optional(),
  payment: paymentSchema,
  soldAt: instant,
  qr: z.string().min(20).max(400),
});
export const syncSalesSchema = z.object({
  deviceId: z.string().uuid(),
  /** Heure de l'appareil à l'envoi : sert à corriger le décalage d'horloge. */
  deviceNow: instant,
  sales: z.array(offlineSaleSchema).max(100),
});
export const offlineValidationSchema = z.object({
  clientId: z.string().uuid(),
  qr: z.string().min(20).max(400),
  scannedAt: instant,
  tripId: z.string().uuid().optional(),
  localResult: z.enum(['valide', 'sous_reserve']),
});
export const syncValidationsSchema = z.object({
  deviceId: z.string().uuid(),
  deviceNow: instant,
  validations: z.array(offlineValidationSchema).max(200),
});
export const listAnomaliesQuery = z.object({
  status: z.enum(['ouverte', 'traitee']).optional(),
  kind: z.enum(ANOMALY_KINDS).optional(),
  ...page,
});
export const handleAnomalySchema = z.object({ note: z.string().trim().max(500).optional() });

export type RequestDeviceInput = z.infer<typeof requestDeviceSchema>;
export type RevokeDeviceInput = z.infer<typeof revokeDeviceSchema>;
export type ReserveRangeInput = z.infer<typeof reserveRangeSchema>;
export type ReferentielQuery = z.infer<typeof referentielQuery>;
export type OfflineSale = z.infer<typeof offlineSaleSchema>;
export type SyncSalesInput = z.infer<typeof syncSalesSchema>;
export type OfflineValidation = z.infer<typeof offlineValidationSchema>;
export type SyncValidationsInput = z.infer<typeof syncValidationsSchema>;
export type ListAnomaliesQuery = z.infer<typeof listAnomaliesQuery>;
export type HandleAnomalyInput = z.infer<typeof handleAnomalySchema>;

// ---------- Étape 6 : tableau de bord ----------
export const GRANULARITIES = ['jour', 'semaine', 'mois'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
/** Jour calendaire (UTC, comme le Burkina Faso) au format AAAA-MM-JJ. */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Date invalide');

export const dashboardQuery = z.object({
  from: calendarDay.optional(),
  to: calendarDay.optional(),
  lineId: z.string().uuid().optional(),
  granularity: z.enum(GRANULARITIES).default('jour'),
});
export const exportQuery = z.object({ from: calendarDay.optional(), to: calendarDay.optional(), lineId: z.string().uuid().optional() });
export const reportDeparturesQuery = z.object({ from: calendarDay.optional(), to: calendarDay.optional(), lineId: z.string().uuid().optional(), ...page });
export type DashboardQuery = z.infer<typeof dashboardQuery>;
export type ExportQuery = z.infer<typeof exportQuery>;
export type ReportDeparturesQuery = z.infer<typeof reportDeparturesQuery>;

// ---------- Étape 7 : journal d'audit lisible, paramètres de la compagnie ----------
export const listAuditQuery = z.object({
  /** Préfixe d'action, ex. « ticket. » ou « user. ». */
  action: z.string().trim().max(60).regex(/^[a-z_.]*$/, 'Préfixe invalide').optional(),
  ...page,
});
export const LOGO_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    /** Petite image en data URL (60 000 caractères au plus) ; `null` retire le logo. */
    logo: z.string().max(60_000).regex(LOGO_PATTERN, 'Logo : image PNG, JPEG ou WebP').nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Aucun champ à modifier');
export type ListAuditQuery = z.infer<typeof listAuditQuery>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
