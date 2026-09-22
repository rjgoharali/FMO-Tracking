export type Role = 'FMO' | 'ADMIN' | 'SUPER_ADMIN';
export type Principal = { userId: string; fmoId: string | null; role: Role; sessionId: string; authVersion: number };
export type UserRow = Record<string, unknown> & { id: string; login_id: string; name: string; role: Role; password_hash: string; is_active: boolean; auth_version: number; fmo_id: string | null; is_demo: boolean };
export type DutyRow = Record<string, unknown> & { id: string; fmo_id: string; status: 'ACTIVE' | 'COMPLETED'; start_time: Date; expected_end_time: Date;
  actual_end_time: Date | null; reported_stop_time: Date | null; start_request_id: string; start_request_hash: string | null; end_request_id: string | null; end_request_hash: string | null };
declare module 'fastify' { interface FastifyRequest { principal: Principal | null } }
