# FMO Attendance & Live Tracking

A phased implementation for municipal field operations. **The backend and Phase 4 laptop dashboard are implemented. Phase 3 Android source has 15 passing core tests; native build/device acceptance remains open.** The user explicitly authorized Phase 4 before those Android checks were complete. See [the phase plan](docs/PHASES.md), [backend API contract](docs/API.md), and [architecture](docs/ARCHITECTURE.md).

**Monitor FMOs from your laptop at http://localhost:3000.** Start the configured backend with `npm run dev`, then run `npm run admin:dev` in another terminal. FMOs use Android phones; the laptop needs no GPS sensor. See [dashboard setup](admin-dashboard/README.md).

For this Windows development workspace, `npm run local:setup` reuses the installed PostgreSQL binaries under `.test-tools`, preserves the database/settings, applies migrations and starts the API/dashboard. Private login details are saved in `.local-runtime/admin-access.txt`; labeled demo FMO passwords are in `.local-runtime/demo-access.json`. These ignored files must remain private. This helper is for local development, not production deployment.

## Phase 4 deliverables

- React/TypeScript/Tailwind laptop dashboard with admin login, summary cards, responsive navigation and live officer list.
- Real Google Maps SDK integration, marker clustering, officer selection, GPS quality and retained last-known positions. Set `GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_MAP_ID`; no key or simulated map data is supplied.
- Authenticated Socket.IO updates after committed duty/location changes; origin/role checks, pre-publication session validation and reconnect recovery.
- FMO creation/editing/activation, attendance filters, server duration, authenticated selfie viewer and audited attendance reset.
- Strict builds, real WebSocket tests and Chrome workflow tests. See [Phase 4 verification and remaining gates](docs/PHASE-4-VERIFICATION.md).
- Route history, daily reports with CSV export, and settings editing are implemented. Actual Google-hosted map rendering and Android-to-map device trials still require verification.

## Phase 3 progress

- Android FMO login, separate Start Duty and live-selfie Check-In, profile/status screens and visible location notice.
- Expo foreground/background location task, secure token storage, transactional SQLite outbox, idempotent retries and durable offline end recovery.
- Front-camera-only capture and private retained selfie evidence; no fabricated GPS or simulated API communication.
- 15 passing core tests, full mobile dependency installation/typechecking and Android JavaScript export pass. APK compilation and physical-device workflow trials remain acceptance gates.
- See [mobile setup](mobile/README.md) and [verification/blockers](docs/PHASE-3-VERIFICATION.md). Phase 4 proceeded at the user's explicit request; this does not mark Android acceptance complete.

## Phase 2 deliverables

- FMO/admin login, short-lived JWT access tokens, rotating refresh tokens, replay detection, logout, password changes and immediate session revocation.
- Separate duty start and camera-challenged check-in; duplicate-safe GPS batches and end-duty requests, including offline completion and explicit GPS-failure handling.
- Private local/S3 image storage, image decoding/re-encoding and integrity checks, authenticated selfie access, and a modular verification interface (default **NOT_VERIFIED**).
- FMO creation/editing/activation, organization settings, audited attendance resets that preserve evidence, super-admin provisioning and audit retrieval.
- Attendance/profile/session/location/route APIs and dashboard summary; the Phase 4 additions above now connect the laptop UI and real-time stream.
- HTTP integration, file-storage, authorization, retry and concurrency tests against embedded and real PostgreSQL.

## Phase 1 deliverables

- npm monorepo with TypeScript backend and shared validation; reserved mobile and admin workspaces.
- PostgreSQL migration for users, FMO profiles, devices, duty sessions, attendance, immutable location history, refresh-token hashes, organization settings, and audit history.
- Transactional, checksummed migrations with a concurrency lock and safe reruns.
- Explicit development seed: 5 FMOs, 1 super admin, 4 sessions, 3 attendance records, and 48 synthetic route points.
- Fastify liveness/readiness service, exact-origin CORS, security headers, rate limiting, redacted logging, validated environment, and salted scrypt password utilities.
- Docker configuration and automated PostgreSQL constraint, contract, and health-service tests.

## Requirements

- Node.js **24 LTS**, npm **11+** (the lockfile pins the installed dependency tree).
- PostgreSQL **17**, or Docker Desktop with Compose v2. Docker must use Linux containers.
- Git is recommended.
- Later mobile phases: Android Studio, its supported JDK/Android SDK, and a physical Android device for background tests. SDK targets will be pinned with the Expo release used in Phase 3.
- Later map phase: a Google Cloud project with billing and Maps JavaScript API enabled. Set `GOOGLE_MAPS_API_KEY`; restrict the browser key to your dashboard domains and required API. Browser map keys are visible to users by design; never give them server privileges.

## Quick start: database and backend

Run all commands from this repository root:

```powershell
Copy-Item .env.example .env
npm ci
```

Edit `.env` before running. Set a unique `POSTGRES_PASSWORD`, matching password in `DATABASE_URL`, and a generated `JWT_SECRET`. Use a URL-safe database password (for example the command below); special characters in a connection URL must be percent-encoded. Compose constructs its internal connection URL from the PostgreSQL variables, so use URL-safe characters for that workflow.

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Alternatively, run PostgreSQL directly, create the database/user named in `DATABASE_URL`, then run the two npm commands. Development listens at `http://127.0.0.1:4000`.

- `GET /health/live`: process liveness, HTTP 200.
- `GET /health/ready`: HTTP 200 only when the database is reachable and migration `002_backend_workflows.sql` is present; HTTP 503 otherwise.
- Business endpoints are available under `/api`. See [API documentation](docs/API.md) for authentication and request formats.

For the complete containerized foundation:

```sh
docker compose up --build -d
docker compose logs backend
```

Compose waits for PostgreSQL health, runs migrations as a one-shot service, and starts the backend after successful migration. Database and uploads use persistent named volumes. `docker compose down` preserves volumes. **Do not use `down -v` on a database you want to retain.** Docker ports bind to loopback by default. A future physical-device test requires a deliberate LAN bind/firewall setup or an HTTPS development endpoint; Android's emulator uses `10.0.2.2` to reach the host.

Compiled execution is also supported:

```sh
npm run build
node dist/database/migrate.js
node dist/backend/src/server.js
```

## Migrations

`npm run db:migrate` applies numbered SQL files from `database/migrations` in one transaction, under a PostgreSQL advisory lock. Applied names and SHA-256 checksums are recorded in `schema_migrations`. Rerunning is safe; changing or removing an already applied migration fails. Make schema changes in a **new migration**. There is intentionally no destructive automatic down/reset command. Back up production data and validate restore procedures before deployment.

The API readiness check does not run migrations; deployment runs them before starting the API. The development connection owns the schema. Production must use separate migration and runtime roles: the runtime role should have no DDL/TRUNCATE privileges, only required table operations and sequence usage. Phase 6 will add and validate deployment grants once the final endpoints exist.

## Explicit demo seed

In `.env`, set:

```dotenv
NODE_ENV=development
ALLOW_DEMO_SEED=true
SEED_ADMIN_PASSWORD=<your-own-long-password>
SEED_FMO_PASSWORD=<your-own-different-long-password>
```

Passwords must be 12+ characters. Then:

```sh
npm run db:seed
```

For the containerized database **and upload volume**, run:

```sh
docker compose exec backend node dist/database/seed/run.js
```

If you changed `.env` after the container was created, first recreate it with `docker compose up -d backend` so the new environment is loaded. Do not seed on the host then expect its local upload file to appear in the container's named volume.

Accounts are `DEMO-ADMIN` and `CHK-FMO-001` through `CHK-FMO-005`. Passwords are the ones you supply, not defaults in source. Each account gets its own random salt. All sample people, sessions, attendance, and location records are marked as demo; the names and coordinates are illustrative. Sample routes are inserted once and never stream fake updates. Their status naturally becomes stale as time passes.

The sample attendance image is a **one-pixel PNG placeholder, not a selfie**. It exists only to exercise private storage references and is flagged `DEMO_FIXTURE` / `NOT_VERIFIED`. A real camera workflow comes in Phase 3. The seed refuses account-ID collisions and does not overwrite existing accounts or reset passwords on rerun. Set `ALLOW_DEMO_SEED=false` afterward. Seeding is rejected unless `NODE_ENV=development` is explicit.

## Tests and checks

```sh
npm run check
```

This performs strict TypeScript checking, Node test-runner tests, and a production compilation including SQL assets. Default database tests execute the actual SQL against PGlite's embedded PostgreSQL engine, not a mocked SQL layer. They require no external database and never connect to `DATABASE_URL`.

To run the same tests against an actual PostgreSQL server:

```powershell
$env:TEST_DATABASE_URL='postgresql://user:password@localhost:5432/fmo_test'
npm test
Remove-Item Env:TEST_DATABASE_URL
```

Use a dedicated test database whose user can create schemas. The suites create unique `test_<uuid>` / `api_test_<uuid>` schemas and drop only those schemas on exit. CI runs both embedded tests and PostgreSQL 17 tests, then builds the container. A process crash can leave a test schema for manual cleanup. See [Phase 1 verification](docs/PHASE-1-VERIFICATION.md) and [Phase 2 verification](docs/PHASE-2-VERIFICATION.md) for what was actually run in this workspace.

The backend suite now contains 44 tests covering foundations, authentication/authorization, duty transitions, private images, offline retries and real Socket.IO authorization/publication. `npm run admin:test` separately runs Chrome workflows, and `npm run mobile:test` runs 15 SQLite/core tests. None substitutes for Phase 3 physical-device background tracking or configured Google Maps acceptance.

An optional temporary PostgreSQL harness is also available:

```powershell
$env:PG_TEST_BIN='C:\path\to\postgresql\bin'
npm run test:postgres
```

It initializes a new isolated database under `.test-postgres`, binds to a random loopback port with a random password, runs the tests, stops the server, and removes only its generated directory. It does not install a service or use an existing database. If `PG_TEST_BIN` is omitted, it looks for the workspace-local test binary path used during development. The binary is not committed and is not required by normal `npm ci`. On Linux, run this harness as a nonroot user or use `TEST_DATABASE_URL` with the CI PostgreSQL service.

## First non-demo administrator

After migration, set `ADMIN_EMPLOYEE_CODE`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` in your local environment, then run:

```sh
npm run db:admin
```

The command creates one non-demo SUPER_ADMIN and an audit record, refusing to bootstrap another while one exists. Clear `ADMIN_PASSWORD` afterward. This is separate from opt-in demo seeding and works for production provisioning. The super admin can create ADMIN accounts through `POST /api/admin-users`; admins create FMO accounts through `POST /api/fmos`.

## Private selfie storage

`STORAGE_PROVIDER=local` uses `STORAGE_LOCAL_PATH`. Never mount this directory as a public static website. `/api/attendance/:id/selfie` checks authentication/ownership and returns a non-cacheable image; there is no public upload directory route.

For S3-compatible storage, set `STORAGE_PROVIDER=s3`, bucket and region, and optionally an endpoint and `STORAGE_FORCE_PATH_STYLE=true`. Supply both credential fields or use the SDK's IAM credential chain. Use a private bucket with public access blocked and permissions limited to the required prefix/object operations. Production custom endpoints must use HTTPS. Objects are delivered through the authorized API, not public or reusable signed URLs. A PUT may succeed before a database transaction fails; retain any unreferenced private object for reviewed maintenance rather than risking deletion after an ambiguous commit.

## Environment reference

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; never use the test database in production |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Compose database provisioning |
| `JWT_SECRET` | Random 32+ character secret for JWT signing |
| `ACCESS_TOKEN_MINUTES`, `SESSION_DAYS` | Access-token duration (default 15 minutes) and maximum login-session duration (default 7 days) |
| `NODE_ENV`, `HOST`, `PORT` | Runtime mode and bind address |
| `CORS_ORIGINS` | Comma-separated exact web origins; HTTPS required in production |
| `LOG_LEVEL` | Structured backend logging level |
| `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_MAP_ID` | Restricted browser key and JavaScript map ID, compiled into the dashboard |
| `ADMIN_API_PROXY_TARGET` | Vite API/WebSocket proxy target, default `http://127.0.0.1:4000` |
| `STORAGE_PROVIDER`, `STORAGE_LOCAL_PATH` | Private local storage or S3 selection |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_FORCE_PATH_STYLE` | S3-compatible adapter configuration; IAM credentials may replace explicit keys |
| `EXPO_PUBLIC_API_URL` | Nonsecret mobile API address for Phase 3 |
| `ALLOW_DEMO_SEED`, `SEED_ADMIN_PASSWORD`, `SEED_FMO_PASSWORD` | Explicit development seed consent and credentials |
| `TEST_DATABASE_URL` | Optional dedicated PostgreSQL test connection |
| `ADMIN_EMPLOYEE_CODE`, `ADMIN_NAME`, `ADMIN_PASSWORD` | One-time non-demo super-admin bootstrap |
| `PG_TEST_BIN` | Optional PostgreSQL binaries for the isolated real-server test harness |

Copying `.env.example` is insufficient: placeholder JWT secrets fail validation. Application secrets, uploaded images, signing keys, and generated dependencies are gitignored. No Google or cloud key is included.

## Admin and mobile setup status

`admin-dashboard/` is installed and runnable: `npm run admin:dev`, `npm run admin:build`, and `npm run admin:test`. The updated root lockfile includes its dependencies. `mobile/` contains Android source and a tested core, but native dependency/build/device checks remain pending. Phase 4 registry access succeeded; the earlier mobile installation blocker is historical, not proof of a current registry outage. Resume Android setup with `npm run mobile:setup` when completing Phase 3 acceptance.

The Android implementation targets an Expo development build with `expo-location`, `expo-task-manager`, secure token storage and a durable SQLite queue. Expo Go cannot validate the background service. See [Android setup and limitations](mobile/README.md). The laptop dashboard remains a separate browser application; the laptop needs no GPS sensor.

## Production readiness boundary

The backend and laptop UI now communicate through actual APIs and Socket.IO. The entire system is not yet accepted for organizational deployment. Remaining gates include native Android capture/background duty trials, configured Google Maps rendering, Phase 5 history/reports/settings UI, HTTPS/proxy deployment, live cloud-storage verification, database roles, backups and release security/load checks. Selfies require authorization. Browser refresh cookies require a same-site deployment; the supplied dashboard proxy uses the same origin.
