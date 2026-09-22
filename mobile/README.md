# Phase 3 — FMO Android application

The Android client source is implemented, with **15 passing mobile core tests**, installed native dependencies, full Expo typechecking and Android JavaScript export. APK compilation and physical-device acceptance remain open. See [verification evidence](../docs/PHASE-3-VERIFICATION.md).

The laptop is the administrator's monitoring device. This Android application is for FMOs; the implemented Phase 4 dashboard is documented in [admin setup](../admin-dashboard/README.md).

## Implemented workflow

1. Sign in with an FMO account through the real backend. Tokens use Android-backed Expo SecureStore; passwords are never persisted by the app.
2. Read the location notice and press **Start duty**. Request precise/background location and notification permissions, capture GPS, persist a stable request ID and await server confirmation. Start the visible location foreground service for the authorized session.
3. Separately press **Check in • live selfie**. Obtain a short-lived server challenge, open only the front camera, capture a new photo/GPS fix and submit multipart evidence. There is no gallery picker. Attendance appears confirmed only after a backend response.
4. A top-level TaskManager task writes observations to SQLite before attempting upload. Background/locked-screen operation uses Expo Location with a foreground-service notification. The configurable interval defaults to 45 seconds; Android may batch or delay updates.
5. Press **End duty**. Close the durable collection gate before stopping the native service. Attempt a final fix, persist an idempotent end request, and upload retained observations before finalization. Offline completion remains explicitly pending. Reopening never resumes a locally stopped duty.

Start, check-in and completion timestamps come from the server. Device-reported stop time is separate from server completion. Expected end defaults to eight hours and never silently stops tracking. The UI shows recent-fix/service state, accuracy, connection versus last server response, pending/rejected records, profile and privacy notice. Demo accounts are labeled.

## Dependency setup

Requirements: Node 24 LTS, npm 11+, Android Studio, the JDK/SDK required by the selected Expo release, and a physical Android phone with USB debugging. This workspace has JDK 17 and SDK platforms 34–36, but compatibility with the generated native project is not verified.

The root lockfile includes backend, dashboard and mobile dependencies. React 19.2.3 and React Native 0.85.3 are pinned at the root to prevent npm from auto-installing incompatible native peers. Native prebuild uses the matching Expo SDK 56 template. `npm ci` installs the complete workspace; `mobile:setup` is a dependency-maintenance command, not necessary for every checkout.

From the repository root:

~~~powershell
npm ci
npm run mobile:setup
Copy-Item mobile/.env.example mobile/.env
~~~

The setup script installs Expo SDK 56, reads that installed release's bundledNativeModules.json and installs matching React, React Native and Expo modules. It updates mobile/package.json and the root package-lock.json. Review and retain those changes before CI uses npm ci. Missing compatibility entries stop setup rather than guessing versions. The exact dependency tree and generated Android SDK target still require verification.

Set EXPO_PUBLIC_API_URL in mobile/.env. This public build-time address contains no secrets:

- Emulator: http://10.0.2.2:4000 reaches the laptop backend.
- USB phone: run adb reverse tcp:4000 tcp:4000, then use http://127.0.0.1:4000; alternatively use a reachable HTTPS development endpoint.
- LAN phone: use the laptop's LAN address with a deliberately configured backend bind/firewall. Default loopback bindings are not reachable from another LAN device.
- Production/preview: HTTPS and APP_VARIANT=production are required. Release JavaScript and Android configuration reject insecure production configuration. Never deploy the development variant.

Start PostgreSQL, migrate and run the backend using the root README. Use seeded credentials only for development; no passwords are embedded in the app.

## Development checks and build

~~~powershell
# Available with the existing root dependencies:
npm run mobile:core:check
npm run mobile:test

# Require successful mobile:setup:
npm run mobile:typecheck
npm run mobile:export
npm run prebuild:android -w @fmo/mobile
npm run android -w @fmo/mobile
npm run mobile:start
~~~

Use an **Expo development build**, not Expo Go. Generated mobile/android is ignored; app.config.ts and plugins/with-network-policy.cjs define native configuration. Inspect the merged manifest before acceptance. Expo export verifies JavaScript bundling, not an APK or a foreground service.

For EAS production, authenticate the EAS CLI, configure organizational project/signing credentials and the HTTPS API environment, then run eas build --platform android --profile production from mobile/. The supplied eas.json defines development APK, internal preview APK and production AAB profiles. No EAS account, signing key, store submission or build was created. Keep signing credentials outside the repository.

The FMO application does not render a map and needs no Google Maps key. Laptop Google Maps integration belongs to Phase 4. Never put JWT/storage secrets into EXPO_PUBLIC variables.

## Permissions and privacy

For USB testing on a physical phone, use `EXPO_PUBLIC_API_URL=http://127.0.0.1:4000` in the ignored `mobile/.env`, then run `adb reverse tcp:4000 tcp:4000` and `adb reverse tcp:8081 tcp:8081`. Start the local API and Expo development server. Reapply reverse rules after reconnecting the phone. This connection is development-only; field deployment needs a reachable HTTPS API and a bundled, signed build. Do not use the emulator-only `10.0.2.2` address on a physical phone.

| Permission | Use |
| --- | --- |
| ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION | Foreground GPS; precise access required for start/resume |
| ACCESS_BACKGROUND_LOCATION | Background observations; requested after foreground permission |
| FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION | Visible location service configured through Expo's plugin |
| POST_NOTIFICATIONS | Visible tracking notification; required by this app on Android 13+ |
| CAMERA | Front-camera attendance capture, requested at check-in |
| INTERNET, network state | Backend communication/reconnect |

Notification: **FMO Field Tracking Active — Your duty location is currently being recorded.** Microphone/gallery/media permissions are blocked. Android backup is disabled. SQLite and selfie files are application-private; SQLite is not separately encrypted. Uninstalling or clearing app data removes pending local records.

Camera capture, mock-location flags and the server challenge are basic anti-abuse measures, **not biometric identity verification, liveness verification or device attestation**. Backend verification remains modular and defaults to NOT_VERIFIED.

## Offline and recovery behavior

- Stable UUIDs identify GPS observations with accuracy, original time, available speed/battery and session ownership. SQLite WAL and transactions protect the queue. Uploads use bounded batches and retry backoff.
- Only accepted/duplicate acknowledgments remove points. Malformed acknowledgments retain the entire batch. Rejected points stay locally with reasons for review; there is no automatic purge.
- Saved selfie bytes and metadata are unchanged across retries. A challenge must be obtained online before capture. Expired, unaccepted captures require a new live selfie. No new attendance submission occurs after a local stop; already confirmed attendance can be recovered.
- Start requires server confirmation. An uncertain response replays the same request ID. Recovered sessions require foreground permission confirmation/resume.
- Refresh tokens rotate once. A lost refresh response requires same-account sign-in instead of replaying the token. Network uncertainty preserves authorized offline collection; confirmed revocation pauses it. Cached profile access keeps End Duty available during reauthentication.
- Switching accounts/logout is blocked while a duty or GPS synchronization remains unfinished.
- End closes collection first. Pending end survives restart. A crash during final capture recovers after a 90-second guard with an explicit GPS-unavailable end; it never restarts tracking.
- Settings refresh during foreground reconciliation. The native interval is reapplied on foreground recovery/resume; immediate remote reconfiguration while backgrounded is not promised.

## Android limitations

Force-stop, reboot, permission revocation, disabled GPS and manufacturer battery restrictions can interrupt tracking. There is no reboot receiver or guaranteed force-stop recovery. Reopen the app afterward to review duty state and permissions. A registration flag alone does not mean GPS is active: the UI also requires a recent observation.

Complete the [device checklist](../docs/PHASE-3-VERIFICATION.md), including an eight-hour trial on deployment phone models. Review Android battery settings with the FMO; do not silently bypass power management. Target intervals are requests, not delivery guarantees.

References: [Expo Location](https://docs.expo.dev/versions/latest/sdk/location/), [Expo TaskManager](https://docs.expo.dev/versions/latest/sdk/task-manager/), [Android background location](https://developer.android.com/develop/sensors-and-location/location/background), [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
