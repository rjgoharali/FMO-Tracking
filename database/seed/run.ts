import { loadEnv } from '../../backend/src/config.js';
import { connectDatabase } from '../connect.js';
import { seedDemo, validateSeedEnvironment } from './demo.js';
loadEnv();
const credentials = validateSeedEnvironment(process.env);
if ((process.env.STORAGE_PROVIDER ?? 'local') !== 'local') throw new Error('Demo seed supports local storage only');
const { db, close } = await connectDatabase();
try { console.log(await seedDemo(db, { ...credentials, storagePath: process.env.STORAGE_LOCAL_PATH ?? './uploads' })); }
finally { await close(); }
