# Delivery phases and acceptance gates

The original plan used sequential acceptance gates. The user subsequently explicitly requested Phase 4 while Phase 3 native/device checks remained open; Phase 4 proceeded under that instruction. Unverified gates remain recorded, not implicitly passed.

**Current status:** Phases 1 and 2 are complete. Phase 3 has 15 passing core tests, full mobile typechecking, JavaScript export and native project generation; APK/device workflow acceptance remains open. Phase 4 laptop UI and real-time server pass web build, WebSocket and Chrome workflow checks. Phase 5 history, reports/CSV and settings are implemented and browser-tested. Google Maps rendering, physical tracking trials and release hardening remain open. See [Phase 3 evidence](PHASE-3-VERIFICATION.md), [Phase 4 evidence](PHASE-4-VERIFICATION.md) and [Phase 5 evidence](PHASE-5-VERIFICATION.md).

| Phase | Scope | Acceptance gate |
| --- | --- | --- |
| **1 — Foundation** | Workspace, TypeScript, shared contracts, PostgreSQL schema, migration runner, seed, health server, Docker/CI configuration, documentation | Local typecheck, embedded PostgreSQL constraint tests, migration tests, seed tests, and production compilation pass; external-tool limitations are recorded |
| 2 — Backend workflows | Admin/FMO login, short-lived access tokens and rotating refresh tokens, revocation, role/ownership checks, duty start/check-in/location/end, private local/S3 storage, camera challenge, FMO/settings management, audit events, REST contracts | Integration tests for login, denial cases, all business transitions, duplicate retries, concurrency, batch reconciliation, file validation, private selfie access, and attendance retrieval on PostgreSQL |
| 3 — Android application | Expo development build, secure login, separate Start Duty and Check-In, front-camera-only capture, foreground/background tracking, SQLite outbox, reconnect, final-location/end recovery, profile and privacy notice | Android build passes; physical-device locked-screen/background tests; airplane-mode queue and restart recovery; permission/GPS failure tests; stopped-duty privacy checks; document force-stop/reboot limitations |
| 4 — Admin operations | Responsive React/Next.js/Tailwind UI, login, summary, FMO CRUD, Google map with clustering and marker details, authorized Socket.IO updates, attendance and private selfie viewer | Web production build; authenticated browser workflows; real mobile/API location changes update map without reload; unauthorized socket connections denied |
| 5 — History and reports | FMO/date/session selection, complete paginated routes/polylines, last-seen and GPS quality, daily attendance and duration reports, CSV export, organization settings | Timezone/date boundary tests; complete long-session routes; safe CSV export; settings affect new sessions and mobile configuration correctly |
| 6 — Release hardening | Deployment profiles, runtime DB role, HTTPS/proxy configuration, backup/restore, retention controls, observation/alerts, scale tests, complete operator docs, signed Android release procedure | Full tests/builds; actual eight-hour device trials; 50–500 FMO load testing; recovery and privacy review; no unresolved critical failures |

## Cross-phase requirements

- Never infer attendance from duty start. Attendance requires its own server-confirmed check-in.
- Live camera capture is not biometric identity or liveness verification. Add verification through an explicit provider interface; baseline remains `NOT_VERIFIED`.
- Never present seeded or simulated movement as live telemetry. Distinguish all demo records in client UI.
- Use server timestamps for duty/attendance. Preserve validated device observation time separately from server receipt time for offline GPS.
- Queue IDs persist across retries. A batch acknowledgment identifies accepted, duplicate, and rejected points; the mobile client deletes only confirmed accepted/duplicate entries.
- Server derives ownership from authentication. Client-supplied IDs are lookup targets, never authority.
- Late queued points from a finished duty may upload within that duty's recorded collection window. Uploading retained points is not new tracking.
- Stop collecting at explicit End Duty, durably retain pending points/end intent, and retry network finalization. Do not restart collection merely because an old server session remains active during an outage.
- No automatic duty end in the initial workflow; expected end is a reminder, not silent data loss. Any future auto-end must be explicit and tested.
- Android restrictions are reported honestly. Do not claim uninterrupted tracking after force-stop or on unsupported devices.

## Phase 1 completion definition

The foundation is complete when its local gates pass and reproducible external checks are supplied. Running Docker, a native PostgreSQL server, the future Android app, and deployment acceptance is not implied by a successful TypeScript build. Record unavailable tooling honestly rather than declaring those checks passed.

## Phase 2 completion

Backend REST workflows, role/ownership checks, private storage, admin actions, migrations, documentation and acceptance tests are implemented. Concurrent starts/check-ins/refreshes/location retries were tested against a real PostgreSQL server. The camera challenge is not a claim of live biometric verification. No Android background service, laptop dashboard, Google map or Socket.IO stream is claimed in this phase.
