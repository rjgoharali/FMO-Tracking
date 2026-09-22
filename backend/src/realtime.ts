import { Server, type Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import type { Auth } from './auth.js';
import type { Database } from './db.js';
import { trackingSnapshot } from './tracking.js';

export function registerRealtime(app: FastifyInstance, db: Database, auth: Auth) {
  const attempts = new Map<string, { count: number; expires: number }>();
  const io = new Server(app.server, { serveClient: false, transports: ['websocket'], maxHttpBufferSize: 16384,
    cors: { origin: auth.env.origins, credentials: true },
    allowRequest: (request, done) => {
      if (!request.headers.origin || !auth.env.origins.includes(request.headers.origin)) return done('Origin rejected', false);
      const now = Date.now(); for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
      const key = request.socket.remoteAddress ?? 'unknown'; const prior = attempts.get(key) ?? { count: 0, expires: now + 60000 }; prior.count++;
      if (!attempts.has(key) && attempts.size >= 10000) return done('Capacity exceeded', false);
      attempts.set(key, prior); done(null, prior.count <= 60);
    },
  });
  // No connection-state recovery: every reconnect must reauthenticate and fetch a snapshot.
  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth.token;
      if (typeof token !== 'string' || token.length > 4096) throw new Error();
      const actor = await auth.principalForToken(token);
      if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw new Error();
      if (io.sockets.sockets.size >= 1000 || [...io.sockets.sockets.values()].filter(s => s.data.userId === actor.userId).length >= 20) throw new Error();
      socket.data.token = token; socket.data.userId = actor.userId; next();
    } catch { next(new Error('Administrator session required')); }
  });
  async function authorized(socket: Socket) {
    try { const actor = await auth.principalForToken(String(socket.data.token)); if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw new Error(); return true; }
    catch { socket.disconnect(true); return false; }
  }
  io.on('connection', socket => { socket.emit('operations:ready', { serverTime: new Date().toISOString() }); });
  let timer: ReturnType<typeof setTimeout> | null = null; let flushing = false; let invalidated = false; let closing = false;
  const dirty = new Set<string>();
  const schedule = () => { if (!timer && !closing) timer = setTimeout(() => { timer = null; void flush(); }, 250); };
  async function flush() {
    if (flushing || closing) { if (!closing) schedule(); return; }
    flushing = true; const ids = [...dirty]; dirty.clear(); const all = invalidated; invalidated = false;
    try {
      if (!io.sockets.sockets.size) return;
      // Read only committed data. One coalesced snapshot can contain many officer updates.
      const snapshot = !all && ids.length && ids.length <= 500 ? await trackingSnapshot(db, { fmoIds: ids, limit: 500 }) : null;
      for (const socket of io.sockets.sockets.values()) {
        // Handshake-only validation would leak later updates after logout/revocation.
        if (!await authorized(socket)) continue;
        if (snapshot) socket.emit('tracking:update', snapshot);
        else socket.emit('operations:invalidate', { serverTime: new Date().toISOString() });
      }
    } catch { app.log.warn('Real-time publication failed; clients recover through authenticated snapshot refresh'); }
    finally { flushing = false; if (dirty.size || invalidated) schedule(); }
  }
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 400 || !['POST', 'PATCH', 'PUT'].includes(request.method)) return;
    const path = request.routeOptions.url ?? '';
    if (['/api/duty/start', '/api/duty/check-in', '/api/duty/location', '/api/duty/end'].includes(path) && request.principal?.fmoId) dirty.add(request.principal.fmoId);
    else if (path.startsWith('/api/fmos') || path === '/api/settings' || path.endsWith('/reset')) invalidated = true;
    else return;
    schedule();
  });
  const sweep = setInterval(() => { for (const socket of io.sockets.sockets.values()) void authorized(socket); }, 30000); sweep.unref();
  app.addHook('preClose', async () => { closing = true; if (timer) clearTimeout(timer); clearInterval(sweep); io.disconnectSockets(true); await new Promise<void>(resolve => { io.close(() => resolve()); }); });
}
