# Flexible Reminder

Flexible Reminder is a local-first iPhone reminder app built with React, Vite,
TypeScript, and Capacitor. The MVP stores reminders on device and schedules iOS
local notifications without a backend.

## Local App Development

From the repository root:

```sh
cd app
npm install
npm run dev
```

Build the web bundle for Capacitor:

```sh
cd app
npm run build
```

Run automated tests:

```sh
cd app
npm test
npx playwright install chromium
npm run test:e2e
```

The Playwright suite runs the app at an iPhone-sized viewport and attaches a
`today-mobile.png` screenshot to the test results.

Capacitor is configured with:

- App ID: `com.hdduong.flexiblereminder`
- App name: `Flexible Reminder`
- Web directory: `dist`
- iOS project path: `../ios`

When the app dependencies are in place, create or sync the iOS project from
`app/`:

```sh
npx cap add ios
npx cap sync ios
```

The logo asset lives at `app/public/logo-lock-buzz.svg`.

## iOS GitHub Actions

The workflow at `.github/workflows/ios-testflight.yml` runs on pull requests,
pushes to `main`, and manual dispatch. It installs dependencies in `app/`,
builds the Vite app, runs Vitest and Playwright, adds or syncs the Capacitor iOS
project, then:

- builds an unsigned simulator app when signing secrets are missing
- archives, exports an IPA, and uploads to TestFlight when signing secrets are configured
- uploads the Playwright report and test screenshots as workflow artifacts
- uploads the generated `ios/` project as a workflow artifact for inspection

Required repository secrets for signed TestFlight uploads:

- `APPLE_TEAM_ID`
- `IOS_DISTRIBUTION_CERTIFICATE_BASE64`
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE_BASE64`
- `IOS_PROVISIONING_PROFILE_SPECIFIER`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_API_ISSUER_ID`
- `APP_STORE_CONNECT_API_PRIVATE_KEY`

Without those secrets, the workflow still validates the web build and generated
iOS project with an unsigned simulator build.
