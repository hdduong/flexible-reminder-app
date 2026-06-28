# Flexible Reminder — iPhone Reminder App

## Overview

Flexible Reminder is an iPhone app for creating free-text reminders with precise, repeatable schedules. A user can write any reminder text, choose the weekdays it should run, set an active time window such as `9:00 AM` to `5:00 PM`, and choose either interval reminders like `Every 2 hours` or exact reminder times.

The app is local-first: reminders, settings, and history live on the device, and notifications are scheduled using iPhone local notifications. No account, remote server, or internet connection is required for the MVP.

**One role:**
- **User** — creates reminders, receives notifications, marks reminders done, skips them, or delays them with `Later 10m`

**Three pieces built in parallel:**

| Piece | Purpose | Tech |
|-------|---------|------|
| `app/` | iPhone UI and app shell | React + Vite + TypeScript + Capacitor |
| `local-services/` | Scheduling, storage, notifications, actions | TypeScript services inside the app |
| `.github/workflows/` | iOS cloud build and TestFlight upload | GitHub Actions macOS runner |

---

## Product Rules

- Reminder text is always **free text**. No fixed categories.
- Each reminder owns its own schedule.
- A schedule can run on selected weekdays.
- A schedule has an active start/end time window.
- A reminder can repeat by interval or exact times.
- `Later` means snooze, defaulting to **10 minutes**.
- Privacy mode hides sensitive reminder text from notifications.
- MVP works offline.
- MVP does not require a backend server.

---

## Frontend — iPhone App

### Screen 1: Today

**Header**
- Title: `Today`
- Date subtitle
- Add button in the top right

**Up Next card**
- Shows the next scheduled reminder
- Example:
  - Reminder: `Try bathroom`
  - Time: `10:00 AM`
  - Schedule summary: `Mon-Fri · 9 AM-5 PM · every 2 hours`
- Actions:
  - **Done** — marks the reminder occurrence complete
  - **Later 10m** — schedules a one-time snooze notification 10 minutes later
  - **Skip** — dismisses this occurrence only

**Upcoming list**
- Shows remaining reminders for today
- Each row shows:
  - Time
  - Reminder text
  - Schedule summary
  - Small tag such as `daily`, `work`, or `exact`

**Bottom navigation**
- `Today`
- `Reminders`
- Center add button
- `Settings`

---

### Screen 2: New Reminder

**Reminder text**
- Required free-text field
- Example: `Try bathroom`
- Max length: 120 characters

**Private notification text**
- Optional
- Example: `Quick break`
- Used when privacy mode is enabled or when the user wants a softer lock-screen message

**Days**
- Weekday selector:
  - Mon
  - Tue
  - Wed
  - Thu
  - Fri
  - Sat
  - Sun
- At least one day must be selected

**Time window**
- Start time picker
- End time picker
- Example: `9:00 AM` to `5:00 PM`
- End time must be after start time

**Repeat**
- Summary row, example: `Every 2 hours`
- Opens Schedule screen

**Snooze**
- Summary row, default: `10 minutes`
- Can use app default or reminder-specific override

**Save Reminder**
- Validates input
- Persists reminder locally
- Schedules upcoming local notifications

---

### Screen 3: Schedule

**Selected days**
- Same weekday selector as New Reminder

**Active hours**
- Start time
- End time

**Repeat mode**
- **Interval**
  - User chooses every `X` minutes or hours
  - MVP options:
    - 15 minutes
    - 30 minutes
    - 1 hour
    - 2 hours
    - 3 hours
    - 4 hours
- **Exact Times**
  - User adds one or more exact times
  - Exact times must fall inside active hours

**Preview times**
- Shows generated reminder times for the selected schedule
- Example for `9 AM-5 PM` and `Every 2 hours`:
  - `9:00`
  - `11:00`
  - `1:00`
  - `3:00`
  - `5:00`

**Done**
- Saves schedule edits back to New Reminder or existing reminder edit flow

---

### Screen 4: Reminders

**Reminder list**
- Shows saved reminders
- Each row shows:
  - Reminder text
  - Schedule summary
  - Next reminder time
  - Enabled/disabled toggle

**Actions**
- Tap row to edit
- Swipe or menu to delete
- Toggle pauses/resumes scheduling

**Empty state**
- Message: `No reminders yet`
- CTA: `Add Reminder`

---

### Screen 5: Settings

Settings should contain only user-facing options.

**Rows**
- **Notifications** — status: `Allowed`, `Denied`, or `Not requested`
- **Default snooze** — default `10 minutes`
- **Privacy mode** — on/off
- **Week starts on** — `Monday` or `Sunday`
- **Export data** — exports reminders and history as JSON or CSV
- **About** — app version and support info

**Do not show in app Settings**
- Storage implementation
- GitHub Actions
- TestFlight
- Build system details

Those belong in developer documentation, not user settings.

---

## Backend / Local Services

MVP has no remote backend. The “backend” is a local TypeScript service layer inside the Capacitor app.

### Local Service Modules

| Service | Responsibility |
|---------|----------------|
| `ReminderService` | Create, update, delete, enable, disable reminders |
| `ScheduleEngine` | Generate reminder occurrences from schedule rules |
| `NotificationService` | Request permission, schedule, cancel, and reschedule local notifications |
| `ReminderActionService` | Handle Done, Skip, and Later actions |
| `SettingsService` | Load and save app settings |
| `PrivacyService` | Decide notification title/body based on privacy mode |
| `ExportService` | Export reminders and history |

### Notification Behavior

The app schedules local notifications for upcoming reminder occurrences. It should keep the pending notification queue bounded and refresh it when:

- A reminder is created
- A reminder is edited
- A reminder is disabled
- A reminder is deleted
- The app opens
- A notification action is taken
- The date changes

**Notification actions**

```
done      Marks this occurrence complete
later10   Schedules a one-time reminder 10 minutes from now
skip      Marks this occurrence skipped
```

**Privacy mode**

If privacy mode is off:
```
Notification title/body can show the real reminder text.
```

If privacy mode is on:
```
Notification should show privateNotificationText if provided.
Otherwise show generic text such as "Reminder".
```

---

## Database Contract

MVP storage uses Capacitor Preferences. Data is stored as versioned JSON.

Later, the same data models can move to SQLite without changing the UI contract.

### Preferences Keys

```
settings:v1       AppSettings
reminders:v1      Reminder[]
events:v1         ReminderEvent[]
```

---

## Data Models

### Reminder

```
id                    string (uuid)
text                  string (required, max 120 chars)
privateNotificationText string | null
enabled               boolean
schedule              ReminderSchedule
snoozeMinutesOverride number | null
createdAt             datetime
updatedAt             datetime
deletedAt             datetime | null
```

### ReminderSchedule

```
daysOfWeek       number[]   // 0=Sunday, 1=Monday, ... 6=Saturday
startTime        string     // "HH:mm", local device time
endTime          string     // "HH:mm", local device time
mode             "interval" | "exact_times"
intervalMinutes  number | null
exactTimes       string[]   // ["09:00", "12:00", "15:00"]
timezone         string     // device timezone at creation/update
```

### ReminderOccurrence

Generated by `ScheduleEngine`; not necessarily persisted unless an action is taken.

```
id             string
reminderId     string
scheduledFor   datetime
status         "pending" | "done" | "skipped" | "snoozed" | "missed"
source         "schedule" | "snooze"
```

### ReminderEvent

```
id             string (uuid)
reminderId     string
occurrenceId   string
type           "done" | "skip" | "snooze" | "missed" | "notification_tapped"
scheduledFor   datetime
createdAt      datetime
metadata        object | null
```

### AppSettings

```
notificationPermissionStatus  "unknown" | "granted" | "denied"
defaultSnoozeMinutes          number   // default 10
privacyMode                   boolean
privacyFallbackText           string   // default "Reminder"
weekStartsOn                  "monday" | "sunday"
schemaVersion                 number
updatedAt                     datetime
```

---

## Local API Contract

The React UI should call local services through a stable TypeScript API. This keeps UI, storage, and notification logic separated.

### Reminders

```ts
listReminders(): Promise<Reminder[]>
getReminder(id: string): Promise<Reminder | null>
createReminder(input: CreateReminderInput): Promise<Reminder>
updateReminder(id: string, input: UpdateReminderInput): Promise<Reminder>
deleteReminder(id: string): Promise<void>
setReminderEnabled(id: string, enabled: boolean): Promise<Reminder>
```

### Today / Occurrences

```ts
listTodayOccurrences(date: string): Promise<ReminderOccurrence[]>
getNextOccurrence(now: Date): Promise<ReminderOccurrence | null>
previewSchedule(input: ReminderSchedule): Promise<ReminderOccurrence[]>
```

### Reminder Actions

```ts
markDone(occurrenceId: string): Promise<void>
skipOccurrence(occurrenceId: string): Promise<void>
snoozeOccurrence(occurrenceId: string, minutes?: number): Promise<void>
```

If `minutes` is omitted, use `settings.defaultSnoozeMinutes`.

### Settings

```ts
getSettings(): Promise<AppSettings>
updateSettings(input: Partial<AppSettings>): Promise<AppSettings>
```

### Notifications

```ts
requestNotificationPermission(): Promise<"granted" | "denied">
rescheduleAllNotifications(): Promise<void>
scheduleReminderNotifications(reminderId: string): Promise<void>
cancelReminderNotifications(reminderId: string): Promise<void>
```

### Export

```ts
exportData(format: "json" | "csv"): Promise<{ filename: string; data: string }>
```

---

## Optional Future HTTP API

Do not build this for MVP unless cloud sync is requested later.

### Reminders

```
GET    /api/reminders
POST   /api/reminders
GET    /api/reminders/:id
PATCH  /api/reminders/:id
DELETE /api/reminders/:id
POST   /api/reminders/:id/enable
POST   /api/reminders/:id/disable
```

### Occurrences

```
GET  /api/occurrences/today
POST /api/occurrences/:id/done
POST /api/occurrences/:id/skip
POST /api/occurrences/:id/snooze
```

### Settings

```
GET   /api/settings
PATCH /api/settings
```

---

## Design Tokens

Variant 2 uses a warm parchment direction with precise reminder controls.

| Token | Value | Usage |
|-------|-------|-------|
| Paper | `#F7EFE4` | Canvas / warm background |
| Phone | `#FCFAF7` | App background |
| Ink | `#2B1B12` | Primary text |
| Muted | `#7B6A5B` | Secondary text |
| Line | `#E1D3C1` | Borders |
| Soft | `#F1E6D6` | Inputs / secondary surfaces |
| Terracotta | `#CF623B` | Primary buttons |
| Terracotta Dark | `#A9472A` | Pressed/action state |
| Sage | `#6D7B5E` | Success / calm status |
| Sage Soft | `#E7EDDF` | Success background |
| Amber | `#C9862F` | Snooze / warning accent |
| Amber Soft | `#FAE8C8` | Snooze background |
| Dark Card | `#2A1A12` | Up Next card |
| Heading Font | Newsreader | Titles |
| UI Font | Inter | Forms, rows, buttons |

---

## Behavior Details

### Schedule Generation

For interval schedules:

1. Start at `startTime`.
2. Add `intervalMinutes`.
3. Continue until generated time is greater than `endTime`.
4. Only include occurrences on selected weekdays.
5. Only schedule future occurrences.

Example:

```
Days: Mon-Fri
Window: 09:00-17:00
Repeat: Every 2 hours
Generated times: 09:00, 11:00, 13:00, 15:00, 17:00
```

For exact-time schedules:

1. Use the user-selected `exactTimes`.
2. Reject times outside the active window.
3. Only include occurrences on selected weekdays.

### Snooze / Later

`Later 10m` and `Snooze 10 min` mean the same thing.

```
scheduledFor = now + 10 minutes
source = "snooze"
```

The snoozed notification does not change the normal repeating schedule.

### Done

Marks the occurrence complete and records a `done` event.

### Skip

Marks only the current occurrence skipped. Future scheduled occurrences remain active.

### Reminder Editing

When a reminder is edited:

1. Save updated reminder.
2. Cancel pending notifications for that reminder.
3. Recompute future occurrences.
4. Schedule new notifications.

### Permission Handling

If notification permission is denied:

- App still allows reminder creation.
- Today and Reminders screens still work.
- Show warning in Settings: `Notifications denied`.
- Provide a path to open iOS app settings.

---

## Out of Scope

- User accounts
- Cloud sync
- Remote backend server
- Shared reminders
- Calendar integration
- Location-based reminders
- Medical tracking or diagnosis
- AI-generated schedules
- Apple Watch app
- Home screen widgets
- Paid subscriptions

---

## Project Structure

```
flexible-reminder/
├── app/
│   ├── src/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── today/
│   │   │   ├── reminders/
│   │   │   ├── schedule/
│   │   │   └── settings/
│   │   ├── services/
│   │   │   ├── reminders/
│   │   │   ├── schedule/
│   │   │   ├── notifications/
│   │   │   ├── storage/
│   │   │   └── export/
│   │   ├── types/
│   │   └── main.tsx
│   ├── capacitor.config.ts
│   ├── package.json
│   └── vite.config.ts
├── ios/
├── .github/
│   └── workflows/
│       └── ios-testflight.yml
└── README.md
```

---

## Tech Stack

| Layer | Stack |
|-------|-------|
| App UI | React + Vite + TypeScript |
| Mobile shell | Capacitor |
| Notifications | `@capacitor/local-notifications` |
| Storage MVP | `@capacitor/preferences` |
| Storage later | SQLite if reminders/history grow |
| Styling | CSS modules or Tailwind, using Variant 2 tokens |
| Testing | Vitest for schedule engine, Playwright for web UI smoke tests |
| iOS build | GitHub Actions macOS runner |
| Distribution | TestFlight / App Store Connect |
| Local machine | Windows; no local iOS build required |

---

## Acceptance Criteria

- User can create a free-text reminder.
- User can select weekdays.
- User can set start and end time.
- User can choose interval repeat or exact times.
- App previews generated reminder times.
- App schedules local iPhone notifications.
- Notification can be marked Done, Later 10m, or Skip.
- Privacy mode hides sensitive reminder text from notifications.
- Settings include only user-facing controls.
- App works without internet.
- iOS build runs from GitHub Actions, not local macOS.
