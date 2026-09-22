# Phase 2 verification

Status: **Phase 2 backend implemented and acceptance checks passed.** Phase 3 has not started. The laptop browser remains the intended admin interface; its UI is Phase 4.

Verified on 20 September 2026 (Asia/Karachi), Windows, Node.js 24.13.1 and npm 11.8.0.

| Check | Result |
| --- | --- |
| `npm run check` | Passed: strict TypeScript checking, 39 tests, production compilation and SQL-asset copy |
| Final `npm run typecheck` and `npm run build` | Passed after the final timezone validation refinement |
| Embedded PostgreSQL integration suite | 39 passed, 0 failures, 0 skipped |
| `npm run test:postgres` | 39 passed, 0 failures, 0 skipped against PostgreSQL **17.10** |
| Concurrent API operations | Passed with separate real PostgreSQL pool connections: identical/distinct starts, duplicate check-ins, concurrent new GPS point uploads, refresh rotation/replay |
| Actual HTTP listener | Authenticated identity response and anonymous duty denial verified over loopback HTTP |
| Local private storage | Write/read, no-overwrite, traversal rejection and image processing verified |
| S3 SDK transport | Signed PUT/GET verified with the real AWS SDK against an isolated local HTTP protocol fixture |
| Actual S3/cloud account | Not configured or tested; requires deployment credentials and bucket policy verification |
| Dependency installation audit | npm reported 0 known vulnerabilities at install time |
| Docker image / Compose | Not executed: Docker is unavailable on this machine; CI build remains configured |
| CI workflow | Updated, not run remotely in this workspace |
| Android / laptop dashboard / Google Maps / WebSockets | Not implemented in Phase 2; their acceptance gates remain pending |

The real database binary was obtained as workspace-local test tooling from `@embedded-postgres/windows-x64@17.10.0-beta.17`; `postgres --version` reported 17.10. No Windows service or system database was installed or modified. The harness created a random-password database on a random loopback port, then stopped it and removed its generated data directory. Downloaded binaries are ignored under `.test-tools`; they are not application dependencies or deployment artifacts.

## Verified backend behavior

- Valid/invalid login, identity responses without credential leakage, expired/forged tokens, role denial and cross-FMO record denial. Accounts missing their FMO profile cannot authenticate.
- Web HttpOnly/SameSite refresh cookies and trusted-Origin enforcement; mobile body refresh tokens; rotation, replay revocation, concurrent refresh handling, logout and password-change revocation.
- Independent Start Duty and Check-In, configurable duration snapshots, initial GPS validation and one active session under simultaneous requests.
- Real multipart image ingestion, signature/type/size/dimension/decoding checks, metadata stripping, challenge expiry and replay behavior, mocked/poor GPS denial, and storage-failure rollback.
- Authenticated private selfie access, no public storage keys in attendance responses, no-cache behavior and stored-image integrity checks.
- Duplicate-safe location batches with individual accepted/duplicate/rejected results; invalid points do not stall valid points; ID-content conflicts are detected; poor/mock observations are labeled.
- Irreversible and retry-safe duty completion, explicit missing-final-GPS evidence, reported offline stop separate from server timestamps, delayed in-window uploads after completion, and no new post-end observations.
- Complete route pagination, last-location preservation and stale uploads not falsely refreshing an offline officer.
- FMO management/activation, active-duty deactivation protection, settings authorization, audit records, evidence-preserving attendance resets and fresh recapture after reset.
- Migration checksums/rollback/idempotency, database ownership/window constraints, append-only history and explicit idempotent demo seeding.

## Important boundaries

The suite proves backend behavior, not Android camera origin or background tracking. Live camera capture, secure mobile credentials, durable SQLite queue behavior, phone permission/restart/reboot handling and eight-hour device trials are Phase 3 work. The default selfie verifier returns `NOT_VERIFIED`; there is no face recognition/liveness claim.

The laptop dashboard is not yet runnable. Phase 4 will connect it to these APIs and implement authenticated Socket.IO events and Google Maps. CSV/report presentation remains Phase 5.

Production deployment still requires HTTPS/proxy validation, restricted runtime database grants, live private-object-store verification, backups/restore, retention/orphan-object procedures, coordinated rate limits for multiple servers, observation/alerts and a complete security review. Private file writes and database commits are not a distributed transaction; a failed check-in can leave an unreferenced private object, intentionally not auto-deleted after an ambiguous commit.

See [API contracts and recovery rules](API.md) and the [root README](../README.md) for setup and commands.
