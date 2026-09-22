import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
async function login(page: Page, waitForData = true) {
  await page.goto('/'); await page.getByLabel('Employee / admin ID').fill('DEMO-ADMIN'); await page.getByLabel('Password', { exact: true }).fill('browser-test-admin-password'); await page.getByRole('button', { name: 'Sign in to dashboard' }).click();
  if (waitForData) await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
test('admin login, real snapshot, secure cookie refresh and responsive layout', async ({ page }) => {
  await login(page); await expect(page.getByText('Live connection', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect your operations map' })).toBeVisible();
  await expect(page.locator('.metric').filter({ hasText: 'Total FMOs' }).locator('strong')).toHaveText('5');
  const keys = await page.evaluate(() => Object.keys(localStorage)); expect(keys.every(key => !/token|password/i.test(key))).toBe(true);
  const cookies = await page.context().cookies(); const refresh = cookies.find(cookie => cookie.name === 'fmo_refresh'); expect(refresh?.httpOnly).toBe(true); expect(refresh?.sameSite).toBe('Strict');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await page.screenshot({ path: '.browser-test/overview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Toggle navigation' }).click(); await page.getByRole('link', { name: 'Attendance', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Attendance records' })).toBeVisible();
});
test('create, edit and deactivate an FMO through authenticated forms', async ({ page }) => {
  await login(page); await page.getByRole('link', { name: 'Field officers', exact: true }).click(); await page.getByRole('button', { name: 'Add FMO' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Full name').fill('Browser Created Officer'); await dialog.getByLabel('Employee / FMO ID').fill('BROWSER-' + randomUUID().slice(0, 8).toUpperCase()); await dialog.getByLabel('Initial password').fill('test-officer-password'); await dialog.getByRole('button', { name: 'Create FMO' }).click(); await expect(dialog).not.toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Browser Created Officer' }); await expect(row).toBeVisible(); await row.getByRole('button', { name: 'Edit Browser Created Officer' }).click();
  await page.getByRole('dialog').getByLabel('Full name').fill('Browser Updated Officer'); await page.getByRole('dialog').getByLabel('Account active').uncheck(); await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Browser Updated Officer' })).toContainText('INACTIVE');
});
test('attendance filters and private selfie retrieval display saved evidence', async ({ page, request }) => {
  await login(page); await page.getByRole('link', { name: 'Attendance', exact: true }).click(); await page.getByLabel('Attendance date').fill('');
  await expect(page.getByRole('button', { name: 'View', exact: true }).first()).toBeVisible(); await page.getByRole('button', { name: 'View', exact: true }).first().click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: 'Attendance evidence' })).toBeVisible(); const image = dialog.getByRole('img'); await expect(image).toHaveAttribute('src', /^blob:/); expect(await image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const response = await request.get('http://127.0.0.1:4100/api/attendance/' + randomUUID() + '/selfie'); expect(response.status()).toBe(401);
  await dialog.getByRole('button', { name: 'Close dialog' }).click(); await page.getByLabel('Attendance date').fill('2000-01-01'); await expect(page.getByRole('heading', { name: 'No attendance for this selection' })).toBeVisible();
});
test('a real duty location request reaches the browser through Socket.IO without navigation', async ({ page, request }) => {
  await login(page); await expect(page.getByText('Live connection', { exact: true })).toBeVisible();
  const logged = await request.post('http://127.0.0.1:4100/api/auth/login', { data: { employeeCode: 'CHK-FMO-002', password: 'browser-test-fmo-password', client: 'mobile' } }); expect(logged.ok()).toBe(true); const credentials = await logged.json();
  const headers = { Authorization: 'Bearer ' + credentials.accessToken }; const current = await (await request.get('http://127.0.0.1:4100/api/duty/current', { headers })).json();
  const officer = page.locator('.officer-row').filter({ hasText: 'CHK-FMO-002' }); await officer.click();
  let navigations = 0; page.on('framenavigated', () => navigations++);
  const response = await request.post('http://127.0.0.1:4100/api/duty/location', { headers, data: { dutySessionId: current.session.id, points: [{ clientPointId: randomUUID(), latitude: 32.951234, longitude: 72.871234, accuracy: 7, recordedAt: new Date().toISOString() }] } }); expect(response.ok()).toBe(true);
  await expect(page.locator('.selected-detail')).toContainText('32.951234, 72.871234'); expect(navigations).toBe(0);
});
test('FMO login is refused by the laptop client and logout clears the workspace across tabs', async ({ page, context }) => {
  await page.goto('/'); await page.getByLabel('Employee / admin ID').fill('CHK-FMO-005'); await page.getByLabel('Password', { exact: true }).fill('browser-test-fmo-password'); await page.getByRole('button', { name: 'Sign in to dashboard' }).click(); await expect(page.getByRole('alert')).toContainText('administrator account');
  await page.getByLabel('Employee / admin ID').fill('DEMO-ADMIN'); await page.getByLabel('Password', { exact: true }).fill('browser-test-admin-password'); await page.getByRole('button', { name: 'Sign in to dashboard' }).click(); await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  const other = await context.newPage(); await other.goto('/'); await expect(other.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible(); await expect(other.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await other.reload(); await expect(other.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
});

test('a delayed initial HTTP snapshot does not overwrite a newer websocket observation', async ({ page, request }) => {
  let release!: () => void, captured!: () => void; let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; }); const received = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/tracking/snapshot?*', async route => {
    if (held) return route.continue(); held = true;
    const response = await route.fetch(); captured(); await gate; await route.fulfill({ response });
  });
  try {
    await login(page, false); await received; await expect(page.getByText('Live connection', { exact: true })).toBeVisible();
    const logged = await request.post('http://127.0.0.1:4100/api/auth/login', { data: { employeeCode: 'CHK-FMO-001', password: 'browser-test-fmo-password', client: 'mobile' } }); expect(logged.ok()).toBe(true);
    const headers = { Authorization: 'Bearer ' + (await logged.json()).accessToken }; const current = await (await request.get('http://127.0.0.1:4100/api/duty/current', { headers })).json();
    const response = await request.post('http://127.0.0.1:4100/api/duty/location', { headers, data: { dutySessionId: current.session.id, points: [{ clientPointId: randomUUID(), latitude: 33.456789, longitude: 72.891234, accuracy: 9, recordedAt: new Date().toISOString() }] } }); expect(response.ok()).toBe(true);
    await page.locator('.officer-row').filter({ hasText: 'CHK-FMO-001' }).click(); await expect(page.locator('.selected-detail')).toContainText('33.456789, 72.891234'); release();
    await page.getByRole('button', { name: 'All FMOs', exact: true }).click(); await expect(page.locator('.officer-row')).toHaveCount(5); await expect(page.locator('.selected-detail')).toContainText('33.456789, 72.891234');
  } finally { release(); }
});

test('history loads stored observations, reports export CSV, and settings save through the backend', async ({ page }) => {
  await login(page); await page.getByRole('link', { name: 'Route history', exact: true }).click();
  await page.getByRole('combobox', { name: 'Officer', exact: true }).selectOption({ label: 'CHK-FMO-001 · Muhammad Ayaz (DEMO)' });
  await expect(page.getByRole('heading', { name: /recorded observations/ })).not.toHaveText('0 recorded observations');
  await page.getByRole('link', { name: 'Reports', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Duty reports' })).toBeVisible();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV' }).click(); const downloaded = await downloading; expect(downloaded.suggestedFilename()).toMatch(/^fmo-duty-.*\.csv$/);
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); await page.getByLabel('Duty duration (minutes)').fill('510'); await page.getByRole('button', { name: 'Save settings' }).click(); await expect(page.getByRole('status')).toContainText('saved and audited');
  await page.getByLabel('Duty duration (minutes)').fill('480'); await page.getByRole('button', { name: 'Save settings' }).click(); await expect(page.getByRole('status')).toContainText('saved and audited');
});
