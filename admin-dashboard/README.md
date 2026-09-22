# Phase 4 — Laptop admin dashboard

The React/TypeScript/Tailwind dashboard connects to the real backend for administrator login, operational summaries, live officer locations, FMO management, attendance and private selfies. Socket.IO pushes committed database updates to authenticated administrators. No generated movement or simulated socket data is used by the application.

The user explicitly authorized Phase 4 while the Phase 3 Android build/device checks remain open. Google Maps requires the organization's browser key and map ID. Route history, reports/export and settings editing remain Phase 5.

## Run on your laptop

Use Node 24 LTS and npm 11+. From the repository root:

~~~powershell
npm ci
# Configure root .env, then start PostgreSQL and apply migrations.
npm run db:migrate
npm run dev
~~~

In a second terminal:

~~~powershell
npm run admin:dev
~~~

Open **http://localhost:3000** in a current Chrome or Edge browser. Use an existing ADMIN/SUPER_ADMIN account; create the first real admin with npm run db:admin, or explicitly seed development accounts using the root README. No default production password is provided.

The Vite development server proxies /api and /socket.io to ADMIN_API_PROXY_TARGET (default http://127.0.0.1:4000). The browser sees a same-origin application, preserving the HttpOnly refresh cookie. Keep CORS_ORIGINS=http://localhost:3000 in local development. Use localhost consistently, rather than alternating localhost and 127.0.0.1.

For access from another laptop, deploy behind HTTPS and configure its exact browser origin in CORS_ORIGINS. Do not expose the Vite development server as an organizational production service. The laptop never requests camera/GPS permission or supplies field locations.

## Google Maps configuration

In root .env, set:

~~~dotenv
GOOGLE_MAPS_API_KEY=
GOOGLE_MAPS_MAP_ID=
ADMIN_API_PROXY_TARGET=http://127.0.0.1:4000
~~~

1. Use the organization's billed Google Cloud project and enable Maps JavaScript API.
2. Create a JavaScript map ID for Advanced Markers. Put it in GOOGLE_MAPS_MAP_ID.
3. Restrict the browser API key to Maps JavaScript API and the exact dashboard HTTP referrers, including the development localhost origin if needed.
4. Restart Vite after changing the environment; rebuild the production bundle after changing keys/map IDs.

The key and map ID are public browser configuration. Only these two explicitly allowlisted root environment values enter JavaScript. Database, JWT and storage secrets are never exposed by the Vite config. Do not use an unrestricted server key in the browser.

The map loads Google's real SDK, creates Advanced Markers from saved active-duty observations, clusters markers, shows safe text-only officer details, zooms to a selected officer and fits active FMOs. Poor/mock readings are distinguished; stale/offline officers retain their last known location. A neutral world view has no officer markers when there are no observations. No map key means visible setup guidance and working tables, not fabricated map data.

The Google-hosted map could not be exercised without an organization's configured key/map ID. Browser tests exercise the honest unconfigured state; they do not mock Google and claim that proves map rendering.

## Features

- Overview: total active FMO accounts, on-duty, checked-in, recent tracking, offline and distinct officers completing duty today.
- Live tracking: searchable officer list, recency computed from observation time using server clock offset, GPS quality, current/last-known coordinates, selection and map clustering.
- Field officers: search/pagination, create, edit, password reset, activate/deactivate and individual duty details. Active duties must end before deactivation; mutations are audited by the backend.
- Attendance: organization-local date/FMO filters, pagination, server duration, tracking status, current/superseded records and private selfie details. Active-duty attendance can be reset with an audited reason while preserving original evidence.
- Responsive layout: desktop sidebar and narrow-screen navigation. Status, loading, empty and server-error states are explicit.
- Demo accounts/records remain labeled. A camera capture is not biometric or liveness verification.

## History, reports and settings

Route history supports officer, organization-local duty-start date and session selection, retrieves all route pages and draws observation polylines when Google Maps is configured. Reports include daily duty/attendance status and CSV export across all pages, with spreadsheet-formula protection. Settings edit duty duration, tracking interval, freshness, GPS thresholds, timezone and organization name through audited API requests. See [Phase 5 verification](../docs/PHASE-5-VERIFICATION.md).

## Sessions and real-time security

Access tokens remain only in JavaScript memory. Refresh tokens remain in the backend's HttpOnly SameSite=Strict cookie; production adds Secure. Web Locks serialize login/refresh/logout across tabs. BroadcastChannel clears other tabs on session changes/logout. localStorage stores only a nonsecret interrupted-authentication flag. An uncertain refresh result requires sign-in rather than replaying a possibly used refresh token.

Private selfies are fetched with an Authorization header, converted to temporary blob URLs, and revoked on dialog close. No service worker or persistent API/image cache is installed.

The server allows only configured origins and ADMIN/SUPER_ADMIN identities for WebSocket handshakes. Tokens are checked against PostgreSQL session/account state at connection and again before each outgoing batch; periodic checks also close expired/revoked connections. Clients cannot join arbitrary rooms, publish coordinates, or subscribe as FMOs. Tokens are never placed in socket URL query strings.

A new location/duty mutation commits before publication. Updates are coalesced over 250 milliseconds and sent through tracking:update; account/settings/reset mutations invalidate client snapshots. Reconnect always authenticates and reloads the database snapshot. A 30-second snapshot recovery also covers missed/disconnected events; freshness ages locally without requiring new device traffic. This is one API process, with an in-memory publisher and rate limits; coordinated horizontal deployment remains release-hardening work.

## Build and verification

~~~powershell
npm run admin:typecheck
npm run admin:build
npm test
npm run test:postgres
npm run admin:test
~~~

The production bundle is in admin-dashboard/dist. Browser tests start isolated local API and Vite servers, seed explicitly marked test records, and use installed Chrome on Windows or Playwright Chromium on Linux. Linux CI installs Chromium with npx playwright install --with-deps chromium. They do not connect to a production database or real FMO phones. Optional TEST_DATABASE_URL must be a dedicated test database.

Screenshots/test results are under .browser-test/. See [Phase 4 evidence](../docs/PHASE-4-VERIFICATION.md) for results and remaining map/device/deployment checks.

## Container and HTTPS deployment

~~~powershell
docker compose --profile admin up --build -d
~~~

This optional Compose profile serves the dashboard at http://localhost:3000 through unprivileged Nginx, forwarding API and WebSocket traffic to backend:4000. Map configuration is supplied as public build arguments. The default Compose setup is development-only; Docker/Nginx configuration was supplied but not executed where Docker is unavailable.

For production, terminate TLS before Nginx, set NODE_ENV=production and an HTTPS CORS_ORIGINS value, and preserve the original browser Origin. Forward /api/auth cookies and WebSocket upgrade headers; do not cache API/selfie responses. The supplied Nginx config disables framing, browser camera/microphone/geolocation access, MIME sniffing and API proxy caching. Review deployment CSP, TLS, rate-limit/proxy IP policy and monitored backups during Phase 6.

The root backend image still runs independently. Closing the laptop browser does not stop storage or the Android duty service.

References: [Google Advanced Markers](https://developers.google.com/maps/documentation/javascript/advanced-markers/overview), [Google marker clustering](https://developers.google.com/maps/documentation/javascript/marker-clustering), [Socket.IO middleware](https://socket.io/docs/v4/middlewares/).
