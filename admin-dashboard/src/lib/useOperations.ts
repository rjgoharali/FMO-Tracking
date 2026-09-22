import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { accessToken, api } from './auth';
import type { Officer, Settings, Snapshot, Summary } from '../types';

export function useOperations() {
  const [officers, setOfficers] = useState<Officer[]>([]), [settings, setSettings] = useState<Settings | null>(null), [summary, setSummary] = useState<Summary | null>(null);
  const [connection, setConnection] = useState('Connecting'), [error, setError] = useState(''), [revision, setRevision] = useState(0), [updated, setUpdated] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const offset = useRef(0), refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let alive = true, loading = false, again = false; let invalidation = 0; let lastCounts = 0;
    const duringLoad = new Map<string, Officer>(); let latestDuringLoad: Snapshot | null = null;
    let deferred: ReturnType<typeof setTimeout> | null = null;
    const requestRefresh = () => { if (!deferred) deferred = setTimeout(() => { deferred = null; void reload(); }, 750); };
    async function reload() {
      if (loading) { again = true; return; } loading = true; const started = invalidation; duringLoad.clear(); latestDuringLoad = null;
      try {
        const all: Officer[] = []; let afterId: string | null = null; let page: Snapshot;
        do { page = await api<Snapshot>('/api/tracking/snapshot?limit=500' + (afterId ? '&afterId=' + afterId : '')); all.push(...page.items); if (page.hasMore && (!page.nextAfterId || page.nextAfterId === afterId)) throw new Error('Invalid tracking cursor.'); afterId = page.nextAfterId; } while (page.hasMore && alive);
        const counts = await api<Summary>('/api/dashboard/summary');
        if (!alive) return;
        // Overlay pushes received while HTTP was in flight; continuous field traffic
        // must neither rewind a marker nor starve the initial full roster.
        const merged = new Map(all.map(row => [row.fmo.id, row])); for (const row of duringLoad.values()) merged.set(row.fmo.id, row);
        const newest = (latestDuringLoad as Snapshot | null) ?? page;
        if (invalidation !== started) again = true;
        offset.current = Date.parse(newest.serverTime) - Date.now(); setNow(Date.now() + offset.current); setOfficers([...merged.values()]); setSettings(newest.settings); setSummary(counts); setUpdated(newest.serverTime); setError(''); setRevision(v => v + 1);
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : 'Unable to refresh operations.'); }
      finally { loading = false; if (again && alive) { again = false; requestRefresh(); } }
    }
    refresh.current = requestRefresh;
    const socket = io({ transports: ['websocket'], autoConnect: false, reconnectionDelay: 2000, reconnectionDelayMax: 15000,
      auth: callback => { void accessToken().then(token => callback({ token })).catch(() => callback({ token: '' })); } });
    socket.on('connect', () => { if (alive) setConnection('Live'); requestRefresh(); });
    socket.on('disconnect', reason => { if (alive) setConnection('Reconnecting'); if (reason === 'io server disconnect') requestRefresh(); });
    socket.on('connect_error', () => { if (alive) setConnection('Updates delayed'); });
    socket.on('tracking:update', (message: Snapshot) => {
      if (!alive) return; offset.current = Date.parse(message.serverTime) - Date.now();
      if (loading) { for (const row of message.items) duringLoad.set(row.fmo.id, row); latestDuringLoad = message; }
      setOfficers(current => { const rows = new Map(current.map(row => [row.fmo.id, row])); for (const row of message.items) rows.set(row.fmo.id, row); return [...rows.values()]; });
      setSettings(message.settings); setUpdated(message.serverTime); setNow(Date.now() + offset.current); setRevision(v => v + 1);
      if (Date.now() - lastCounts > 5000) { lastCounts = Date.now(); void api<Summary>('/api/dashboard/summary').then(value => { if (alive) setSummary(value); }).catch(() => undefined); }
    });
    socket.on('operations:invalidate', () => { invalidation++; requestRefresh(); });
    socket.connect(); void reload();
    const clock = setInterval(() => setNow(Date.now() + offset.current), 1000);
    const recovery = setInterval(() => { requestRefresh(); if (!socket.connected) socket.connect(); }, 30000);
    const focus = () => requestRefresh(); window.addEventListener('focus', focus);
    return () => { alive = false; socket.disconnect(); clearInterval(clock); clearInterval(recovery); if (deferred) clearTimeout(deferred); window.removeEventListener('focus', focus); };
  }, []);
  return { officers, settings, summary, connection, error, revision, updated, now, refresh: () => refresh.current() };
}
