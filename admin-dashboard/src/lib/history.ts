import type { Location } from '../types.js';
export function chronological(points: Location[]) {
  return [...new Map(points.map(point => [point.id, point])).values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r\n]/.test(text.trimStart()) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csv(rows: unknown[][]) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
export function downloadCsv(name: string, rows: unknown[][]) { const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
