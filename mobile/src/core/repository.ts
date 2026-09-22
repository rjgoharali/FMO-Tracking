import type { Ack, Duty, Point, QueuedPoint, Sql, SqlDatabase } from './types.ts';

export const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS duties(sequence INTEGER PRIMARY KEY AUTOINCREMENT,local_key TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS single_unfinished_duty ON duties((1)) WHERE phase<>'COMPLETED';
CREATE TABLE IF NOT EXISTS points(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',reason TEXT);
CREATE INDEX IF NOT EXISTS pending_points ON points(owner_id,status,session_id);
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases(key TEXT PRIMARY KEY,holder TEXT NOT NULL,expires INTEGER NOT NULL);
PRAGMA user_version=1;
`;
const decode = (row: { body: string } | undefined): Duty | null => row ? JSON.parse(row.body) as Duty : null;
async function write(sql: Sql, duty: Duty) {
  await sql.run('UPDATE duties SET phase=?,body=? WHERE local_key=? AND owner_id=?', duty.phase, JSON.stringify(duty), duty.key, duty.ownerId);
}
export class Repository {
  db: SqlDatabase;
  constructor(db: SqlDatabase) { this.db = db; }
  async init() { await this.db.exec(schema); }
  async current(ownerId: string) { return decode((await this.db.all<{ body: string }>('SELECT body FROM duties WHERE owner_id=? ORDER BY sequence DESC LIMIT 1', ownerId))[0]); }
  async get(key: string) { return decode((await this.db.all<{ body: string }>('SELECT body FROM duties WHERE local_key=?', key))[0]); }
  async unfinished() { return decode((await this.db.all<{ body: string }>("SELECT body FROM duties WHERE phase<>'COMPLETED' LIMIT 1"))[0]); }
  async create(duty: Duty) {
    await this.db.run('INSERT INTO duties(local_key,owner_id,phase,body) VALUES (?,?,?,?)', duty.key, duty.ownerId, duty.phase, JSON.stringify(duty));
  }
  async update(key: string, change: (duty: Duty) => Duty) {
    return this.db.transaction(async sql => {
      const duty = decode((await sql.all<{ body: string }>('SELECT body FROM duties WHERE local_key=?', key))[0]);
      if (!duty) throw new Error('Local duty record is missing');
      const next = change(duty);
      if (next.key !== duty.key || next.ownerId !== duty.ownerId || next.fmoId !== duty.fmoId) throw new Error('Duty ownership cannot change');
      await write(sql, next); return next;
    });
  }
  async append(ownerId: string, points: Point[]) {
    return this.db.transaction(async sql => {
      const duty = decode((await sql.all<{ body: string }>("SELECT body FROM duties WHERE owner_id=? AND phase='ACTIVE' LIMIT 1", ownerId))[0]);
      if (!duty?.canCollect || !duty.session || duty.stopRequestedAt) return 0;
      let last = duty.lastPoint;
      for (const point of points) {
        await sql.run('INSERT OR IGNORE INTO points(id,owner_id,session_id,payload) VALUES (?,?,?,?)', point.clientPointId, ownerId, duty.session.id, JSON.stringify(point));
        if (!last || Date.parse(point.recordedAt) >= Date.parse(last.recordedAt)) last = point;
      }
      await write(sql, { ...duty, lastPoint: last, issue: null }); return points.length;
    });
  }
  async pending(ownerId: string, sessionId?: string, limit = 100): Promise<QueuedPoint[]> {
    const rows = await this.db.all<{ id: string; owner_id: string; session_id: string; payload: string; status: 'PENDING'; reason: null }>(
      "SELECT * FROM points WHERE owner_id=? AND status='PENDING' AND (? IS NULL OR session_id=?) ORDER BY rowid LIMIT ?", ownerId, sessionId ?? null, sessionId ?? null, limit);
    return rows.map(row => ({ id: row.id, ownerId: row.owner_id, sessionId: row.session_id, point: JSON.parse(row.payload) as Point, status: row.status, reason: row.reason }));
  }
  async acknowledge(ownerId: string, sessionId: string, sent: QueuedPoint[], acks: Ack[]) {
    // Validate the entire acknowledgment before deleting even one point.
    if (!Array.isArray(acks) || acks.length !== sent.length) throw new Error('Incomplete location acknowledgment; queue retained');
    const indexes = new Set<number>();
    for (const ack of acks) {
      if (!Number.isInteger(ack.index) || indexes.has(ack.index) || !sent[ack.index] || ack.clientPointId !== sent[ack.index]!.id
        || !['accepted', 'duplicate', 'rejected'].includes(ack.status)) throw new Error('Invalid location acknowledgment; queue retained');
      indexes.add(ack.index);
    }
    await this.db.transaction(async sql => {
      for (const ack of acks) {
        if (ack.status === 'rejected') await sql.run("UPDATE points SET status='REJECTED',reason=? WHERE id=? AND owner_id=? AND session_id=?", ack.code ?? 'REJECTED', ack.clientPointId, ownerId, sessionId);
        else await sql.run('DELETE FROM points WHERE id=? AND owner_id=? AND session_id=?', ack.clientPointId, ownerId, sessionId);
      }
    });
  }
  async counts(ownerId: string) {
    const rows = await this.db.all<{ status: string; count: number }>('SELECT status,count(*) AS count FROM points WHERE owner_id=? GROUP BY status', ownerId);
    return { pending: rows.find(r => r.status === 'PENDING')?.count ?? 0, rejected: rows.find(r => r.status === 'REJECTED')?.count ?? 0 };
  }
  async rejected(ownerId: string) { return this.db.all<{ id: string; reason: string; session_id: string }>("SELECT id,reason,session_id FROM points WHERE owner_id=? AND status='REJECTED' ORDER BY rowid DESC LIMIT 20", ownerId); }
  async value(key: string) { return (await this.db.all<{ value: string }>('SELECT value FROM metadata WHERE key=?', key))[0]?.value ?? null; }
  async setValue(key: string, value: string) { await this.db.run('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  async lease(key: string, holder: string, now: number, milliseconds: number) {
    return this.db.transaction(async sql => {
      const current = (await sql.all<{ holder: string; expires: number }>('SELECT holder,expires FROM leases WHERE key=?', key))[0];
      if (current && current.expires > now) return false;
      await sql.run('INSERT INTO leases(key,holder,expires) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires', key, holder, now + milliseconds);
      return true;
    });
  }
  async release(key: string, holder: string) { await this.db.run('DELETE FROM leases WHERE key=? AND holder=?', key, holder); }
}
