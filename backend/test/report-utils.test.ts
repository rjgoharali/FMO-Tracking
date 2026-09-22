import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, chronological } from '../../admin-dashboard/src/lib/history.js';
import type { Location } from '../../admin-dashboard/src/types.js';
test('CSV quotes special characters and neutralizes spreadsheet formulas including whitespace prefixes', () => {
  for (const value of ['=SUM(A1)', '+cmd', '-cmd', '@cmd', '   =cmd', '\tcmd', '\rcmd']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"'); assert.equal(csvCell(null), '""');
});
test('complete routes deduplicate IDs and order late observations without bigint precision loss', () => {
  const a = { id: '9007199254740993', recordedAt: '2026-01-01T10:00:00Z' } as Location;
  const b = { ...a, id: '9007199254740992' }; const c = { ...a, id: '9007199254740994', recordedAt: '2026-01-01T09:00:00Z' };
  assert.deepEqual(chronological([a, c, b, a]).map(point => point.id), [c.id, b.id, a.id]);
});
