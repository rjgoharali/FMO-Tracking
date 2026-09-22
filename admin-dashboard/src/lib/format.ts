import type { Officer, Settings } from '../types';
export const labels: Record<string, string> = { NOT_STARTED: 'Not started', ON_DUTY: 'On duty', CHECKED_IN: 'Checked in', TRACKING: 'Tracking', NO_RECENT_LOCATION: 'No recent location', OFFLINE: 'Offline', COMPLETED: 'Completed', GOOD: 'Good', ACCEPTABLE: 'Acceptable', POOR: 'Poor accuracy', MOCKED: 'Mock location', UNASSESSED: 'Unassessed' };
export function time(value: string | null | undefined, timezone: string, date = false) { return value ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...(date ? { day: '2-digit', month: 'short' } as const : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'; }
export function dateInZone(timezone: string) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const get = (type: string) => parts.find(p => p.type === type)?.value; return [get('year'), get('month'), get('day')].join('-'); }
export function ago(value: string | null | undefined, now: number) { if (!value) return 'Never received'; const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000)); return seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h ago' : Math.floor(seconds / 86400) + 'd ago'; }
export function duration(seconds: number | null | undefined) { if (seconds == null) return '—'; return Math.floor(Math.max(0, seconds) / 3600) + 'h ' + Math.floor(Math.max(0, seconds) / 60) % 60 + 'm'; }
export function trackingState(row: Officer, settings: Settings, now: number) {
  if (!row.session) return 'NOT_STARTED'; if (row.session.status === 'COMPLETED') return 'COMPLETED';
  const recorded = row.lastLocation?.dutySessionId === row.session.id ? row.lastLocation.recordedAt : null;
  const age = recorded ? Math.max(0, (now - Date.parse(recorded)) / 1000) : Infinity;
  return age >= settings.offlineAfterSeconds ? 'OFFLINE' : age >= settings.staleAfterSeconds ? 'NO_RECENT_LOCATION' : 'TRACKING';
}
