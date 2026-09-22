# History, reports and local setup verification

Verified on 2026-09-21:

- Backend typecheck/build and 47 tests passed with embedded PostgreSQL; all 47 also passed against isolated PostgreSQL 17.
- Dashboard typecheck and production build passed. After correcting the history select's test locator and aligning React dependencies, the complete Chrome suite passed: 7 tests, 0 failures.
- History retrieves every session/route page, deduplicates stable IDs and sorts observations by collection time with bigint-safe tie breaking. Google polyline rendering still requires a configured Maps key and map ID.
- Daily reports enforce admin access and organization-local duty-start dates. CSV export traverses all pages, escapes cells and neutralizes spreadsheet formulas. Unit tests cover CSV safety and route ordering.
- Organization settings save through the audited backend endpoint. The browser workflow saves and restores duty duration. Existing sessions retain expected-end snapshots.
- Local setup recovered PostgreSQL, applied migrations, bootstrapped a private local admin and seeded five explicitly marked demo FMOs. API and dashboard startup succeeded.
- Mobile: 15 core tests, full typecheck and Android JavaScript export passed. Native dependencies are installed. Expo prebuild now pins the matching SDK 56 template. A USB-authorized Infinix X6528 running Android 13 was detected; native build and physical workflow results must be recorded separately.

The local dashboard is http://localhost:3000. Credentials are in ignored `.local-runtime/admin-access.txt`; demo passwords are in `.local-runtime/demo-access.json`. Do not publish either file.

Remaining acceptance includes real Google rendering, Android APK/device trials, a complete eight-hour trial, scale/load testing and deployment hardening. Expo Doctor completed 15 of 17 checks; two remote metadata/schema checks failed due network availability. The dependency audit reported 10 moderate Expo-toolchain advisories; the offered major downgrade was not applied.
