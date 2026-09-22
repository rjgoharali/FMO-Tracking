# REST API and Phase 4 live stream

Base URL in local development: `http://127.0.0.1:4000`. Use HTTPS outside local development. Requests/responses use JSON except check-in uploads and selfie responses. IDs are UUIDs unless specified. All `/api` responses have `Cache-Control: private, no-store`.

The laptop dashboard and Android app use this API. Phase 4 adds the browser interface, bulk snapshot and authenticated Socket.IO stream below. These are operational endpoints, not simulated telemetry.

## Phase 4 tracking snapshot and socket contract

`GET /api/tracking/snapshot?limit=200&afterId=<last FMO UUID>` is ADMIN/SUPER_ADMIN-only. Limit is 1–500. Response: `{items,settings,serverTime,hasMore,nextAfterId}`. Each item contains `{fmo,session,attendance,lastLocation,lastSeen,status}`. It includes active employee accounts, including those without a duty. Last-known locations survive completion; freshness considers observations in the current session. Fetch every cursor page for all markers.

Connect Socket.IO on the same origin with path `/socket.io`, transport `websocket`, and auth `{token: accessToken}`. Origin must exactly match configured CORS origins. No token query parameters, anonymous/FMO subscriptions, custom rooms or location publishing are accepted. Every connection and outbound batch checks the database-backed administrator session; periodic checks also disconnect revoked/expired sessions.

| Event | Direction and behavior |
| --- | --- |
| `operations:ready` | Server to admin; connection established, includes server time |
| `tracking:update` | Server to admin; snapshot-shaped payload containing changed officers, after committed duty/location updates |
| `operations:invalidate` | Server to admin; refetch snapshots/summary after account, settings or attendance-reset changes |

Publications coalesce over 250ms. Events are notifications, not a durable queue; reconnect always reauthenticates and refetches. The browser also recovers every 30 seconds. Expiry/revocation can disconnect sockets; renew through the existing serialized HTTP refresh flow before reconnecting. A single-process publisher is implemented; coordinated horizontal fanout remains release work.

Attendance list items additionally include `trackingStatus` and `serverDurationSeconds` (null until server completion). Offline device-reported duration remains separately labeled in attendance detail/session responses.

## Authentication and authorization

```http
POST /api/auth/login
Content-Type: application/json

{"employeeCode":"CHK-FMO-001","password":"<your password>","client":"mobile"}
```

Successful response contains `accessToken`, `expiresIn` (seconds), `tokenType: "Bearer"`, `user`, and (for mobile only) `refreshToken`. `employeeCode` is case-normalized. All passwords are hashed with scrypt. Login errors do not reveal whether an account exists or is inactive. Login has an IP rate limit and a database-backed per-account attempt limit (20 attempts per 15-minute window); password computation has bounded concurrency and a bounded wait queue.

Authenticated requests send `Authorization: Bearer <accessToken>`. Tokens carry issuer/audience/expiry and a session identifier. Every request checks account activation, authentication version and session revocation in PostgreSQL. Roles are FMO, ADMIN and SUPER_ADMIN. This is a single-organization deployment: both admin roles may manage that organization's FMOs; only SUPER_ADMIN may create other admins or read the audit feed. FMOs can read only their own records and cannot administer settings/accounts.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/auth/login` | Public, rate limited | Create a session |
| `POST /api/auth/refresh` | Refresh credential | Rotate refresh token and issue access token |
| `GET /api/auth/me` | Authenticated | Current identity/profile IDs |
| `POST /api/auth/logout` | Authenticated | Revoke current session and all its refresh tokens |
| `POST /api/auth/change-password` | Authenticated | `{currentPassword,newPassword}`; revoke all account sessions |

### Mobile session rules

Persist the refresh token in Android secure storage. Keep short-lived access tokens in memory where practical. Refresh with `{"refreshToken":"<token>"}`. Persist the replacement refresh token before subsequent requests. Tokens expire at the fixed session expiry; rotating them does not extend the session indefinitely. Clear credentials after logout/revocation.

Refresh must be serialized. Reusing a rotated token revokes that session, including its latest access token. This includes simultaneous refresh requests with the same token: one may succeed, but the other is treated as replay and revokes the session. If the refresh response is lost before the new token is saved, require login again. Do not lose the durable GPS queue during reauthentication.

### Laptop browser sessions

Login with `client: "web"` and a configured `Origin`, e.g. `http://localhost:3000`. The response never contains a refresh token. Instead, it sets `fmo_refresh` with `HttpOnly`, `SameSite=Strict`, path `/api/auth`, and `Secure` in production. Browser refresh sends `{}` with credentials included and a trusted Origin. Untrusted or missing Origin is rejected for cookie refresh. Body refresh tokens are accepted only for mobile sessions, and ambiguous cookie/body credentials are rejected.

Deploy the dashboard and API on the same site, e.g. `admin.example.org` and `api.example.org`, or use a same-origin reverse proxy. Strict cookies do not support unrelated dashboard/API sites. Keep access tokens in browser memory, not persistent localStorage. Coordinate refresh across requests/tabs. API data and selfies must not be cached by a service worker. Logout uses the bearer access token and clears the cookie.

## Location point contract

Fields below describe a real reading supplied by the future Android location service; example coordinates are illustrative only.

```json
{
  "clientPointId": "<persistent UUID generated once>",
  "latitude": 32.932,
  "longitude": 72.855,
  "accuracy": 8,
  "recordedAt": "<ISO 8601 timestamp with timezone>",
  "speed": 1.2,
  "batteryLevel": 86,
  "mocked": false
}
```

`speed` is optional/null in meters per second; `batteryLevel` is optional/null on a 0–100 scale. Never fabricate missing values. Accuracy is required, in meters. FMO ownership comes from authentication; do not send an FMO ID with a duty mutation. Unknown body fields are rejected.

The server preserves raw `deviceRecordedAt` and server `receivedAt`. A device clock up to two minutes ahead is bounded to receipt time in normalized `recordedAt`; larger future values are rejected. Observations older than the session start minus two minutes are rejected. After end, observations must be at or before the reported offline stop, if present, or authoritative server end. Device observations are not proof of physical location; mock flags are diagnostic, not tamper-proof attestation.

Quality values: `GOOD` (<=10m), `ACCEPTABLE` (within configured threshold), `POOR` (above threshold), `MOCKED`; old/demo data may be `UNASSESSED`. Poor/mock tracking points are retained and labeled. Duty start/check-in reject mock GPS and accuracy above the configured threshold. Both require a reading within two minutes of server time.

## Duty workflow

### 1. Read current duty

`GET /api/duty/current` (FMO) returns `session`, `attendance`, `lastLocation`, settings and `trackingAuthorized`; `session` is null when there is no active duty. `trackingAuthorized` is the **server state**, not evidence that an Android service is running. A locally persisted End Duty intent takes precedence and must not restart collection.

### 2. Start Duty

`POST /api/duty/start` (FMO):

```json
{
  "requestId": "<persistent start UUID>",
  "location": "<location point object>",
  "device": {
    "installationId": "<stable application installation UUID>",
    "model": "<optional model>",
    "osVersion": "<optional version>",
    "appVersion": "<optional version>"
  }
}
```

Returns 201 for a new session, 200 for an exact retry. Records the initial location and authoritative server start/expected end, using configured duration (default 480 minutes) and interval (45 seconds). **Creates no attendance.** One active duty per FMO is enforced even for concurrent requests. Reusing an ID with different data returns 409. Retrying a historical start may return a COMPLETED session with `trackingAuthorized: false`; never start collection just because the HTTP status is 200.

### 3. Obtain camera challenge

`POST /api/duty/check-in/challenge` with `{"dutySessionId":"<session UUID>"}` requires an active owned session without current attendance. Returns `challengeToken`, `expiresAt`, and camera instructions. A challenge is valid for two minutes; issuing another invalidates previous unused challenges for that session. The mobile client must then open its front camera and capture a fresh photo, with no gallery picker.

### 4. Check-In

`POST /api/duty/check-in` accepts `multipart/form-data` with exactly:

- `metadata`: a JSON string containing `{requestId,dutySessionId,challengeToken,location}`.
- `selfie`: one JPEG/PNG file, at most 5 MiB; a single image, at least 160 pixels per side, no side above 6000 pixels, at most 20 million input pixels.

No base64 JSON or arbitrary remote URL is accepted. Image signature and actual decoding are validated; the image is auto-oriented, resized to at most 1600×1600, re-encoded as JPEG and stripped of EXIF/GPS metadata. The server timestamp is authoritative. The private storage key is not included in responses.

Returns 201 plus `attendance` on success, 200 for an exact retry with the same request ID, metadata and original image bytes. Only one current attendance is allowed per session. An expired/reused challenge fails unless the request is an exact retry of already confirmed attendance. Reusing a previously submitted normalized image for the same FMO is rejected. This is only a basic replay check: a modified image can evade it.

**The backend cannot prove that an untrusted client used a live camera.** Camera-only UX, challenges, time/quality bounds and image-reuse detection reduce basic abuse, but are not biometric identity/liveness verification. The `SelfieVerifier` interface in `backend/src/storage.ts` is injectable for a later provider; the installed default always records `NOT_VERIFIED`.

### 5. Upload queued locations

`POST /api/duty/location`:

```json
{"dutySessionId":"<session UUID>","points":["<1–200 location point objects>"]}
```

Returns HTTP 200 with `acknowledgments` in input order. Each has `index`, `clientPointId`, `status` (`accepted`, `duplicate`, `rejected`), optional rejection `code`, and optional `quality`. A malformed point does not block valid points. Invalid top-level bodies return 400. Database/system failure rolls back the batch and returns an error; retain and retry the whole batch with unchanged point IDs.

The server persists each `(dutySessionId,clientPointId)` once. Same ID plus different location data returns `POINT_ID_CONFLICT`. **Delete local records only after accepted/duplicate acknowledgment.** Retain rejected records with their reason for reconciliation; do not retry them forever without intervention. Invalid point IDs can be mapped by response `index`. No full-batch success should be inferred merely from HTTP 200.

Out-of-order uploads do not replace a newer last-known position. Freshness uses normalized observation time, not upload receipt or device heartbeat. The response includes current configured `trackingIntervalSeconds`; the mobile client must also read settings on resume to pick up changes. Existing duty expected end and original interval snapshot remain unchanged for audit.

### 6. End Duty

`POST /api/duty/end`:

```json
{
  "requestId": "<persistent end UUID>",
  "dutySessionId": "<session UUID>",
  "finalLocation": "<location point object>",
  "reportedStopTime": "<optional ISO timestamp from an offline stop>"
}
```

Records authoritative server `actualEndTime`, a final point and the optional **unverified client-reported** stop separately. Returns the completed session and `trackingAuthorized: false`. Exact retries return 200 without creating additional final points. Different end requests after completion return 409. Final GPS may be poor/mock but is labeled, so losing accuracy does not prevent stopping duty. Final observation must be within two minutes of the reported stop (or server time for an online stop).

If GPS cannot produce a final point, send `finalLocation: null` and `locationFailure: "GPS_UNAVAILABLE"` or `"PERMISSION_REVOKED"`. The response/session and audit explicitly record `endLocationFailure`; no coordinate is invented. Omitting both a point and an explanation is rejected.

Offline client sequence: persist end intent and any final point, **stop local collection/service immediately**, upload retained queue points, then retry the saved end request. Do not keep tracking just because the server is unreachable. Later retained points within the collection window are still accepted after completion. A claimed stop before already recorded activity returns `STOP_BEFORE_ACTIVITY` for reconciliation, without deleting history.

`serverDurationSeconds` uses authoritative start/end receipt timestamps. `reportedDurationSeconds` uses the client report when present and must be labeled unverified; never silently use it as a server-certified eight-hour duration. If the end request arrived late, the server duration includes the synchronization delay. Automatic ending remains disabled; attempts to enable it in settings are rejected rather than pretending it runs.

## Attendance and private selfies

| Method and path | Access / behavior |
| --- | --- |
| `GET /api/attendance?date=YYYY-MM-DD&fmoId=<uuid>&limit=50&offset=0` | Admin: organization records; FMO: own records only. Date is the organization-local check-in date |
| `GET /api/attendance/:id` | Authorized attendance plus duty details |
| `GET /api/attendance/:id/selfie` | Authorized raw image; no-store; stored SHA-256 integrity checked |
| `POST /api/attendance/:id/reset` | Admin, active duty only; body `{reason}` (5–500 characters) |

Reset supersedes the current attendance, records admin/time/reason, invalidates camera challenges and requires a new selfie. It does not delete or edit original coordinates/image evidence. Responses include `supersededAt` and `resetReason`; lists include historical superseded records so a dashboard must label them and count only current attendance. A stale retry of reset attendance returns `CHECK_IN_RESET`. Completed-duty records cannot be reset through this endpoint.

## FMO management and tracking reads

| Method and path | Access / behavior |
| --- | --- |
| `GET /api/fmos?search=<text>&limit=50&offset=0` | Admin; paginated search |
| `POST /api/fmos` | Admin; `{employeeCode,name,password,phone?,email?}`; 201 |
| `PATCH /api/fmos/:id` | Admin; one or more of `{name,password,phone,email,isActive}`; use null to clear phone/email |
| `GET /api/fmos/:id` | Admin or self; profile, most recent session, attendance, last location/seen and status |
| `GET /api/fmos/:id/location` | Admin or self; last observation and last reliable observation separately |
| `GET /api/fmos/:id/sessions?date=YYYY-MM-DD&limit=50&offset=0` | Admin or self; date selects sessions by organization-local start date |
| `GET /api/fmos/:id/route?dutySessionId=<uuid>&afterId=0&limit=500` | Admin or self; complete paginated location history |
| `GET /api/dashboard/summary` | Admin; active FMO total, on-duty/check-in/tracking/offline/stale counts and distinct officers completing duty on the organization date |

Deactivating an FMO with an active duty returns `FMO_ON_DUTY`; the officer must finish it first so an administrative edit does not silently strand a collecting device. Deactivation or admin password reset revokes every account session. Password values never appear in audit metadata or API responses. There are no delete endpoints for officers, sessions or history.

Route pagination uses monotonically increasing database IDs serialized as **strings**, with `hasMore` and `nextAfterId` (limit at most 2000). This is ingestion order, allowing late offline points to be retrieved without loss. Fetch all pages, then sort by `recordedAt` and numeric ID before drawing a chronological polyline. Never convert bigint IDs to JavaScript floating-point numbers. New points during an active duty can appear on subsequent pages; a completed route is stable except for later queued uploads. Date/session picker and polylines remain client work in Phases 4–5.

Duty lifecycle and tracking freshness are independent. OFFLINE means no recent observation, not proof that internet is unavailable. Last known location remains after completion. `lastLocation` can be poor/mock and must show its quality; use `lastReliableLocation` for a separately labeled trusted-quality marker, not a claim of verified physical presence. Demo observations are labeled `isDemo`.

## Settings and administrators

`GET /api/settings` is authenticated and returns:

```json
{
  "organizationName": "Field Monitoring Organization",
  "timezone": "Asia/Karachi",
  "dutyDurationMinutes": 480,
  "trackingIntervalSeconds": 45,
  "staleAfterSeconds": 180,
  "offlineAfterSeconds": 600,
  "gpsAccuracyThresholdMeters": 100,
  "automaticDutyEnd": false
}
```

The actual response wraps this object in `settings`. Admins `PUT /api/settings` with the object above; changes are audited in the same transaction. Stale threshold must exceed tracking interval, and offline must exceed stale. Timezone is a validated IANA name. Existing expected duty-end snapshots do not change.

`POST /api/admin-users` (SUPER_ADMIN only) accepts `{employeeCode,name,password}` and creates an ADMIN, never another SUPER_ADMIN. `GET /api/audit-logs?limit=50&offset=0` is SUPER_ADMIN-only. Initial non-demo SUPER_ADMIN provisioning uses `npm run db:admin`; see the root README.

## Daily reports

`GET /api/reports/daily?date=YYYY-MM-DD&fmoId=<optional UUID>&limit=50&offset=0` requires ADMIN or SUPER_ADMIN. Maximum page size is 100. The response includes `items`, `hasMore`, `date`, `timezone` and authoritative `serverTime`. Dates select sessions by duty start in the organization timezone; active accounts without a session appear as not started. Historical employment membership is not reconstructed. Server duration and unverified device-reported duration are separate fields, so offline completion delays remain visible.

## Errors, limits and deployment notes

Errors use `{error,code,requestId}`; validation may add field-path `issues`. Common statuses are 400 malformed body, 401 unauthenticated/revoked, 403 role/origin denial, 404 missing/not-owned record, 409 conflicting transition/ID, 413 oversized image, 422 unacceptable GPS/challenge, 429 throttling, 503 unavailable image storage/authentication capacity. Never show database internals or credentials to a client. On transient failures preserve queued data and use bounded exponential backoff.

Global rate limiting is 120 requests/minute/IP, with stricter authentication and upload routes. Login also has a database-backed account counter. The in-memory IP limiter assumes one API process; coordinated multi-instance rate limits and trusted reverse-proxy configuration are release-hardening work. Do not blindly trust forwarded IP headers. Run `npm run db:migrate` before starting Phase 2; migration 001 is unchanged and 002 extends it.

Local files and S3 objects are private. Configure a nonpublic bucket and HTTPS endpoint. The app uses signed SDK PUT/GET and no public ACL; bucket policy must also block public reads. No live cloud account was configured for this phase. A storage PUT followed by a database rollback can leave a private orphan; there is intentionally no unsafe automatic deletion after an ambiguous commit. Add reviewed retention/cleanup during release hardening.
