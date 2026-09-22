import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './auth';
export function useQuery<T>(path: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true); const sequence = useRef(0);
  const reload = useCallback(async () => { const request = ++sequence.current; setBusy(true); try { const value = await api<T>(path); if (request === sequence.current) { setData(value); setError(''); } } catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : 'Unable to load records.'); } finally { if (request === sequence.current) setBusy(false); } }, [path]);
  useEffect(() => { setData(null); void reload(); const timer = setInterval(() => { void reload(); }, 30000); return () => { sequence.current++; clearInterval(timer); }; }, [reload]);
  return { data, error, busy, reload };
}
