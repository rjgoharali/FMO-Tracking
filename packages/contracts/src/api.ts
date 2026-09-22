import { z } from 'zod';
import { locationPointSchema, settingsSchema } from './index.js';

export const passwordSchema = z.string().min(12).refine(s => new TextEncoder().encode(s).length <= 1024, 'Password exceeds 1024 bytes');
export const employeeCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,79}$/);
export const loginSchema = z.object({ employeeCode: employeeCodeSchema, password: z.string().min(1).max(1024), client: z.enum(['mobile', 'web']).default('mobile') }).strict();
export const refreshSchema = z.object({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{64}$/).optional() }).strict();
export const deviceSchema = z.object({ installationId: z.uuid(), model: z.string().max(100).optional(), osVersion: z.string().max(50).optional(), appVersion: z.string().max(50).optional() }).strict();
export const startDutySchema = z.object({ requestId: z.uuid(), location: locationPointSchema, device: deviceSchema }).strict();
export const endDutySchema = z.object({ requestId: z.uuid(), dutySessionId: z.uuid(), finalLocation: locationPointSchema.nullable(),
  locationFailure: z.enum(['GPS_UNAVAILABLE', 'PERMISSION_REVOKED']).optional(), reportedStopTime: z.iso.datetime({ offset: true }).optional() }).strict()
  .refine(v => v.finalLocation ? !v.locationFailure : Boolean(v.locationFailure), 'Provide a final location or an explicit GPS failure reason');
export const challengeSchema = z.object({ dutySessionId: z.uuid() }).strict();
export const checkInSchema = z.object({ requestId: z.uuid(), dutySessionId: z.uuid(), challengeToken: z.string().regex(/^[A-Za-z0-9_-]{64}$/), location: locationPointSchema }).strict();
// Validate points independently so one bad offline observation cannot stall a queue.
export const batchEnvelopeSchema = z.object({ dutySessionId: z.uuid(), points: z.array(z.unknown()).min(1).max(200) }).strict();
export const createFmoSchema = z.object({ employeeCode: employeeCodeSchema, name: z.string().trim().min(1).max(150), password: passwordSchema,
  phone: z.string().trim().max(40).nullable().optional(), email: z.email().max(254).nullable().optional() }).strict();
export const updateFmoSchema = createFmoSchema.omit({ employeeCode: true }).partial().extend({ isActive: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0, 'At least one field is required');
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: passwordSchema }).strict();
export const resetAttendanceSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
export const updateSettingsSchema = settingsSchema.refine(s => !s.automaticDutyEnd, 'Automatic duty end is not supported; use explicit End Duty');
export const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0),
  search: z.string().trim().max(100).optional() }).strict();
const dateOnly = z.iso.date();
export const attendanceQuerySchema = listQuerySchema.omit({ search: true }).extend({ fmoId: z.uuid().optional(), date: dateOnly.optional() });
export const routeQuerySchema = z.object({ dutySessionId: z.uuid(), afterId: z.string().regex(/^[0-9]{1,19}$/).default('0'), limit: z.coerce.number().int().min(1).max(2000).default(500) }).strict();
export const sessionQuerySchema = attendanceQuerySchema.omit({ fmoId: true });
export type PointAcknowledgment = { index: number; clientPointId: string | null; status: 'accepted' | 'duplicate' | 'rejected'; code?: string; quality?: string };
