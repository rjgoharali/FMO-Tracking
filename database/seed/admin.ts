import { loadEnv } from '../../backend/src/config.js';
import { hashPassword } from '../../backend/src/password.js';
import { createFmoSchema } from '../../packages/contracts/src/api.js';
import { connectDatabase } from '../connect.js';

loadEnv();
const input = createFmoSchema.omit({ phone: true, email: true }).parse({ employeeCode: process.env.ADMIN_EMPLOYEE_CODE, name: process.env.ADMIN_NAME, password: process.env.ADMIN_PASSWORD });
const hash = await hashPassword(input.password);
const { db, close } = await connectDatabase();
try {
  await db.exec('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(702641925)');
  if ((await db.query("SELECT id FROM users WHERE role='SUPER_ADMIN' AND NOT is_demo")).rows.length) throw new Error('A non-demo super admin already exists; refusing to bootstrap another');
  const result = await db.query("INSERT INTO users(login_id,name,role,password_hash) VALUES ($1,$2,'SUPER_ADMIN',$3) RETURNING id", [input.employeeCode, input.name, hash]);
  await db.query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id) VALUES ($1::uuid,'SUPER_ADMIN_BOOTSTRAPPED','USER',$1::text)", [result.rows[0]!.id]);
  await db.exec('COMMIT');
  console.log('Initial super admin created. Clear ADMIN_PASSWORD from the environment.');
} catch (error) { await db.exec('ROLLBACK'); throw error; }
finally { await close(); }
