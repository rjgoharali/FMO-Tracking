import { connectDatabase } from './connect.js';
import { migrate } from './runner.js';
const { db, close } = await connectDatabase();
try { console.log({ applied: await migrate(db) }); } finally { await close(); }
