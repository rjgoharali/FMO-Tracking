# Phase 1 verification

Status: **Phase 1 foundation implemented and local acceptance checks passed.** Phase 2 has not started.

Verified on 20 September 2026 (Asia/Karachi), on Windows with Node.js 24.13.1 and npm 11.8.0.

| Check | Result |
| --- | --- |
| Dependency installation and lockfile creation | Passed; npm reported 0 known vulnerabilities at installation time |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 19 tests, 0 failures, 0 skipped |
| `npm run build` | Passed; compiled JavaScript and migration assets emitted into `dist/` |
| PostgreSQL schema execution | Passed against PGlite 0.3.16's embedded PostgreSQL engine |
| Docker image/Compose execution | Not run: Docker unavailable on this machine |
| Native PostgreSQL 17 tests | Not run locally: PostgreSQL unavailable; CI job and `TEST_DATABASE_URL` option provided |
| CI workflow | Configured, not executed here |
| Mobile build and physical Android tracking | Not implemented in Phase 1; Phase 3 acceptance gate |
| Admin dashboard build/browser checks | Not implemented in Phase 1; Phase 4 acceptance gate |

The initial TypeScript run caught an error-handler type issue, which was fixed. Windows sandboxing blocked test child processes with `EPERM`; the complete `npm run check` suite then passed with approved execution outside that restriction. Dependency download also required approved network access. No TLS verification was disabled.

## Tested behavior

1. Environment validation rejects missing/placeholder JWT secrets and unsafe CORS configuration.
2. Backend liveness and readiness are distinct; database errors are sanitized.
3. Security headers, exact-origin CORS and rate limiting work.
4. Password hashes use independent salts and correctly reject incorrect passwords.
5. Migrations rerun safely, detect modified history and roll back failures transactionally.
6. Eight-hour/45-second defaults and freshness thresholds are validated.
7. Only one active duty per FMO; starting duty creates no attendance.
8. Check-in requires an owned active duty and is unique per session.
9. Finished duty cannot be reopened; a subsequent duty is permitted.
10. Location ownership, invalid coordinates, NaN, future timestamps and pre-duty timestamps are constrained.
11. Duplicate offline retries preserve one row and its original observation timestamp.
12. Delayed points inside a completed duty's collection window remain accepted; after-end points are rejected.
13. Ordinary location/audit history deletion and location mutation are rejected.
14. FMO profiles cannot attach to admin-role users; plaintext-shaped password values are rejected.
15. Demo seeding requires explicit development consent and is idempotent, with 6 separately salted accounts, 3 attendance records and 48 marked synthetic points.
16. Shared status logic separates attendance from GPS freshness and completion.
17. Shared location contracts reject client-supplied ownership fields, invalid data and oversized batches.

These are foundation tests, not end-to-end login, mobile queue, selfie verification, concurrent network-client or live-map tests. Actual PostgreSQL concurrency, API authorization and Android behavior must pass their later gates before deployment.
