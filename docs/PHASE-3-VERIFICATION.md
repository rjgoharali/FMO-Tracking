# Phase 3 verification — Android FMO client

Status: **source implemented; acceptance incomplete**. The user later explicitly authorized Phase 4; its dashboard work does not close these Android acceptance gates.

Update on 2026-09-21: native dependencies are installed; full mobile typechecking, 15 core tests and Android JavaScript export pass. Native prebuild succeeds with the pinned Expo SDK 56 template. An authorized Infinix X6528 (Hot 40i), Android 13, is connected over USB. Native APK compilation and physical duty/camera/background trials remain open. Earlier dependency/device blockers below are historical. Expo Doctor passed 15/17 checks; its two remote checks timed out or received unexpected metadata responses.

A later Expo Doctor 1.20.4 run performed 22 checks and passed 17. It identified duplicate React/React Native peers and a React type mismatch; these were corrected with shared root pins (React 19.2.3, React Native 0.85.3, React types 19.2.14), confirmed by resolving packages from both the mobile directory and root. Full mobile typechecking passes after correction. Native directories are generated and ignored; production must regenerate them from app configuration. The remote schema check still failed due network access. Doctor also flags the SDK 56 Hermes regression: [Expo documents the affected worklets/reanimated imports and SDK 57 fixes](https://expo.dev/changelog/sdk-57#known-regressions). This app does not import either library; review the supported SDK upgrade before production release and do not infer eight-hour stability from unit tests.

The laptop build reached native resource and Java/Kotlin compilation, but APK packaging remains blocked by external dependency resolution. The exact missing artifact is `com.google.prefab:cli:2.1.0`; Gradle cannot resolve `dl.google.com` from this environment, and the artifact is not cached. No APK is claimed or provided until that official dependency can be downloaded. The generated Android project is ready under the ignored `mobile/android` directory, and the Android JavaScript export remains available under `mobile/dist`.

## Checks performed

On 2026-09-20, Node 24.13.1/npm 11.8.0 on Windows:

| Check | Result |
| --- | --- |
| `npm run mobile:core:check` | Passed strict TypeScript checks for core and tests |
| `npm run mobile:test` | 15 passed, 0 failed; real Node SQLite, no native module mocks presented as Android evidence |
| TypeScript syntax parse of all 14 mobile TS/TSX files | Passed; syntax only, not Expo typechecking |
| `npm run typecheck` | Existing backend/shared/database typecheck passed |
| `npm run build` | Existing backend production compilation passed |
| Native dependencies, full mobile typecheck, Metro export | Not performed: dependency download blocked |
| Android APK, merged manifest, physical phone | Not performed; no connected device was detected |

Core tests exercise real SQLite durability across file close/reopen, point ownership and deduplication, stop gates, single unfinished duty, acknowledgment validation, rejection retention, lost-response retries, independent attendance, end ordering/reconciliation, process interruption during end, stable selfie retry evidence, no new check-in after stop, authentication revocation versus network failure, uncertain refresh rotation, server authorization denial, account switching/logout protection, bearer authentication and synchronization leases. HTTP outcomes are test fixtures, not claims of native GPS/device verification.

The earlier Phase 2 evidence records 39 passing backend tests against embedded and real PostgreSQL. This continuation did not modify backend behavior or rerun that integration suite; it reran its typecheck/build.

## Original Phase 3 blocker (historical)

The original Phase 3 npm registry request was rejected by **automatic approval review** at its usage limit. No alternate route bypassed that rejection. A later explicitly authorized Phase 4 session successfully installed dashboard dependencies using approved registry access and Windows' trusted certificate store. Mobile SDK dependencies remain staged in mobile/dependencies.json; run `npm run mobile:setup` when resuming native acceptance. The current root lockfile includes backend and dashboard dependencies.

JDK 17, Android SDK platforms 34–36 and adb are installed. No connected Android phone was detected. Tool availability alone does not establish compatibility with the as-yet-unbuilt Expo native project.

## Remaining acceptance steps

1. Restore installation/build access, run mobile setup and retain the resulting manifest/lockfile. Verify the selected Expo release's exact JDK/Android requirements. Run full mobile typechecking and Android JS export; fix any native API/type mismatches.
2. Prebuild Android, inspect the merged manifest and produce/install a development APK. Verify precise/background permissions, Android 13+ notification permission and location foreground-service declarations for the target SDK.
3. Connect a physical phone. Sign in against PostgreSQL-backed API with an actual FMO. Ensure wrong credentials/admin accounts fail. Never use fabricated movement as test evidence.
4. Start duty: confirm server session/start time/initial GPS, persistent notification and last-fix updates. Verify no attendance exists yet. Deny foreground/background/notification permission and disable GPS; verify useful errors and no false active state.
5. Check in: use only the front camera, capture a new selfie, verify authoritative attendance time, GPS/accuracy and authenticated private image retrieval. Confirm duplicate taps/retries create only one attendance row. Test expired challenges and rejection/retake.
6. Lock the phone and switch apps. Verify real GPS observations and server receipts over the configured interval on deployment device models. Run a full eight-hour duty and measure battery, gaps, timing and accuracy. Do not infer this from an emulator.
7. Enable airplane mode while GPS remains enabled. Accumulate points, kill/reopen the process without clearing app data, restore connectivity and confirm every valid point uploads once. Test mixed rejected acknowledgments without deleting retained evidence.
8. End duty offline. Confirm collection gate/native service stop immediately, final fix or explicit failure is retained, and app restart does not resume tracking. Restore connectivity and verify points precede idempotent end finalization. Compare device-reported stop with server completion.
9. Interrupt process during start, selfie response, refresh rotation and final-fix/end response. Verify safe request replay, reauthentication when rotation is uncertain and no duplicate attendance/location/end records.
10. Revoke permissions, disable GPS, force-stop, reboot and apply vendor battery restrictions. Confirm honest paused/stale UI and foreground recovery. No automatic reboot guarantee is claimed.
11. Test stopped-duty privacy: monitor native service/task callbacks and API traffic after confirmed/local end; there must be no newly collected ongoing GPS. Uploading retained pre-stop records is permitted.
12. Build the production variant with HTTPS, verify cleartext/backup restrictions and private files, then validate organizational signing/deployment. Record actual phone model, OS version, build ID, server logs and measured results here.

Only after these gates pass should Phase 3 be marked complete. The subsequent explicit user request authorized Phase 4 dashboard work before Android acceptance; do not treat that as Android verification.
