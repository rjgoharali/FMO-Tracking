# Phase 4 — Laptop dashboard verification

Status: **implemented; local application checks pass, external acceptance remains open**. The user explicitly requested Phase 4 before Phase 3 native/device acceptance. Phase 5 has not started.

## Delivered

- React 19 / Vite 8 / TypeScript / Tailwind 4 dashboard, installed dependencies and updated workspace lockfile.
- Administrator login, HttpOnly-cookie refresh with cross-tab coordination, memory-only access tokens and logout across tabs.
- Database-backed overview, searchable live officer list, latest-location/accuracy/recency details and responsive navigation.
- Google Maps SDK integration with Advanced Markers, clustering, fit-all and officer selection; explicit missing-key and loading/error states.
- FMO search, creation, editing, password reset, activation/deactivation and individual duty details.
- Attendance date/FMO filters, tracking state, server duration, private blob-based selfie viewer, preserved superseded evidence and audited reset workflow.
- Bulk authenticated tracking snapshot and actual Socket.IO updates after successful database-backed duty mutations. Sessions are revalidated before outgoing batches; FMOs and untrusted origins cannot subscribe.
- Development proxy, optional unprivileged Nginx/Compose profile, environment documentation and CI checks.

## Verification evidence

Executed on Windows with Node 24.13.1 and npm 11.8.0:

| Check | Result |
| --- | --- |
| Backend/shared/database strict typecheck | Passed |
| Backend production compilation | Passed |
| Dashboard strict typecheck and production build | Passed; output under admin-dashboard/dist |
| Backend suite on real temporary PostgreSQL 17 | 44 passed, 0 failed; isolated server shut down and temporary directory removed |
| Full backend suite on embedded PostgreSQL | 44 passed, 0 failed, including 5 new real HTTP/WebSocket tests |
| Chrome browser workflows | 6 passed, 0 failed, including delayed-snapshot/live-update ordering |
| Mobile core typecheck and SQLite tests | Passed; 15 tests, no native Android claims |

The original new socket fixtures violated the database's password-hash constraint; fixtures were corrected to use real scrypt hashes. No production constraint was weakened. The initial sandbox build/test attempt could not create child processes; approved execution outside that process sandbox passed. Registry downloads succeeded using Windows' trusted certificate store; TLS verification was not disabled.

WebSocket tests use actual socket connections and database-backed API calls: admin/FMO authorization, invalid/missing origins, committed location publication, out-of-order location retention, revocation before further publication, completion and retained last-known position. Existing login/duty/attendance/storage/database tests run alongside them.

Browser tests run actual dashboard/API servers with isolated, explicitly marked fixtures. They cover login, a database snapshot, memory-only token handling, HttpOnly cookie refresh, mobile-width navigation, FMO create/edit/deactivate, private selfie retrieval, date filtering, receiving an API location update without page navigation, FMO login rejection, cross-tab logout, and an intentionally delayed real HTTP response racing with a newer socket observation. The client merges the newer observation without losing the full roster. These are test coordinates and placeholder seed images; they are not evidence of real field movement or camera identity.

A screenshot was generated and visually inspected at `.browser-test/overview-desktop.png`. Reports and failure artifacts go to `.browser-test/report` and `.browser-test/results`; these generated files are ignored by version control.

## External acceptance and scope limits

- **Google Maps:** no organization's restricted browser key/map ID was provided. SDK code is built/typechecked, but real Google-hosted rendering, clustering/zoom behavior with live map tiles, billing/referrer restrictions and configured key errors require an actual configured project. Tests deliberately show the missing-configuration state rather than substitute a fake map.
- **Android-to-map:** Phase 3 native build, live camera, locked-screen/background and eight-hour physical-device trials remain open. Browser tests prove API-to-Socket.IO-to-interface propagation, not phone GPS collection.
- **Docker/HTTPS:** Docker is unavailable in this environment. The supplied dashboard image, Nginx and Compose profile were not executed here; CI includes build checks. Validate TLS termination, exact origins, cookies and WebSocket upgrades in the deployment environment.
- **Scale:** paginated bulk reads, 250ms event coalescing, marker clustering and bounded browser refreshes are implemented. A measured 50–500+ officer load test and multi-process shared fanout/rate limits remain Phase 6.
- **History/reports/settings:** full date/session route polylines, reports/export and settings editing remain Phase 5. Backend routes/settings APIs already exist; no placeholder navigation claims those interfaces are finished.

To run: start the configured PostgreSQL/backend, then `npm run admin:dev`; open **http://localhost:3000**. See [dashboard setup](../admin-dashboard/README.md).
