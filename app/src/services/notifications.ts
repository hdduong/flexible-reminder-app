import type {
  AppSettings,
  Reminder,
  ReminderOccurrence,
  NotificationPermissionStatus,
} from "../types";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { getSettings, listRemindersFromStorage, updateSettings } from "./storage";
import {
  addDays,
  generateOccurrencesForReminder,
} from "./schedule";
import { withNativeTimeout } from "./nativeTimeout";

const APP_NOTIFICATION_MARKER = "flexible-reminder";
const REMINDER_ACTION_TYPE_ID = "reminder-actions";
const NOTIFICATION_LOOKAHEAD_DAYS = 14;
const MAX_NOTIFICATIONS_PER_REMINDER = 32;
// iOS rejects a whole schedule batch if any trigger date reaches native code
// at or before "now"; a small lead avoids bridge-delay failures.
const MIN_NOTIFICATION_LEAD_MS = 5_000;
const TEST_NOTIFICATION_LEAD_MS = 10_000;
const DEFAULT_NOTIFICATION_SOUND = "default";
const NOTIFICATION_NATIVE_CALL_TIMEOUT_MS = 10_000;
const NOTIFICATION_PLUGIN_LOAD_TIMEOUT_MS = 5_000;

type PermissionResponse = Record<string, string | undefined>;

interface LocalNotificationDescriptor {
  id: number;
  title: string;
  body: string;
  sound?: string;
  silent?: boolean;
  schedule?: {
    at: Date | string;
    allowWhileIdle?: boolean;
  };
  extra?: Record<string, unknown>;
  actionTypeId?: string;
}

interface LocalNotificationsPlugin {
  checkPermissions?: () => Promise<PermissionResponse>;
  requestPermissions?: () => Promise<PermissionResponse>;
  registerActionTypes?: (options: {
    types: Array<{
      id: string;
      actions: Array<{ id: string; title: string; foreground?: boolean }>;
    }>;
  }) => Promise<void>;
  schedule(options: {
    notifications: LocalNotificationDescriptor[];
  }): Promise<void>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  getPending?: () => Promise<{
    notifications: Array<LocalNotificationDescriptor>;
  }>;
  getDeliveredNotifications?: () => Promise<{
    notifications: Array<LocalNotificationDescriptor>;
  }>;
  areEnabled?: () => Promise<{ value: boolean }>;
}

let localNotificationsPromise: Promise<LocalNotificationsPlugin | null> | null =
  null;
let actionTypesRegistered = false;

// Local notifications only exist inside the native Capacitor shell. When the
// app is opened in Safari or as a Home Screen web app, getPlatform() is "web",
// no native plugin is reachable, and no iOS permission prompt or Settings
// entry can ever appear — the UI uses this to say so explicitly instead of
// letting a web session masquerade as a broken native app. Deliberately the
// same predicate as loadLocalNotificationsPlugin, so the notice appears
// exactly when the plugin is unreachable.
export function isNativeNotificationPlatform(): boolean {
  return Capacitor.getPlatform() !== "web";
}

// The exact reason the most recent native notification call failed, verbatim
// ("not implemented", "…timed out after 10000ms", a plugin exception, …).
// Settings shows it next to the failure message so an on-device screenshot
// pinpoints the broken layer instead of requiring a tethered debugger.
let lastNativeNotificationError: string | null = null;

export function getLastNativeNotificationError(): string | null {
  return lastNativeNotificationError;
}

// Called at the start of each user-facing attempt (Enable / Send Test) so the
// detail shown in Settings is scoped to that attempt — a stale failure never
// decorates a fresh, genuine OS denial. Deliberately NOT cleared inside every
// native call: background reconciles run checkPermissions/getPending
// constantly and would race the message composition in Settings.
export function clearLastNativeNotificationError(): void {
  lastNativeNotificationError = null;
}

function recordNativeNotificationError(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  lastNativeNotificationError = `${label}: ${detail}`;
}

export async function requestNotificationPermission(): Promise<
  "granted" | "denied"
> {
  clearLastNativeNotificationError();
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.requestPermissions) {
    await updateSettings({ notificationPermissionStatus: "denied" });
    return "denied";
  }

  let permissionStatus: "granted" | "denied" = "denied";

  try {
    // This shows the interactive iOS permission prompt and resolves only after
    // the user taps a choice. Wrapping it in a short native timeout can record
    // "denied" while the user is still deciding, which leaves reminders saved
    // but never scheduled.
    const response = await plugin.requestPermissions();
    const status = normalizePermissionStatus(response);
    permissionStatus = status === "granted" ? "granted" : "denied";
  } catch (error) {
    recordNativeNotificationError("requestPermissions", error);
    resetLocalNotificationsPlugin();
  }

  await updateSettings({ notificationPermissionStatus: permissionStatus });
  return permissionStatus;
}

export async function getNotificationPermissionStatus(): Promise<
  NotificationPermissionStatus
> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.checkPermissions) {
    return "denied";
  }

  try {
    return normalizePermissionStatus(
      await withNativeTimeout(
        plugin.checkPermissions(),
        "LocalNotifications.checkPermissions",
        NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
      ),
    );
  } catch (error) {
    recordNativeNotificationError("checkPermissions", error);
    resetLocalNotificationsPlugin();
    return "denied";
  }
}

export async function getNotificationDiagnostics(): Promise<{
  available: boolean;
  enabled: boolean | null;
  pending: number;
  delivered: number;
  nextAt: string | null;
}> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin) {
    return {
      available: false,
      enabled: null,
      pending: 0,
      delivered: 0,
      nextAt: null,
    };
  }

  const [enabled, pending, delivered] = await Promise.all([
    getNotificationsEnabled(plugin),
    getPendingNotifications(plugin, { resetOnFailure: false }),
    getDeliveredNotifications(plugin),
  ]);
  const appPending = (pending?.notifications ?? []).filter(isAppNotification);
  const appDelivered = (delivered?.notifications ?? []).filter(isAppNotification);
  const times = appPending
    .map((notification) => getNotificationScheduleTime(notification))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right);

  return {
    available: true,
    enabled,
    pending: appPending.length,
    delivered: appDelivered.length,
    nextAt: times.length > 0 ? new Date(times[0]).toISOString() : null,
  };
}

export async function sendTestNotification(): Promise<
  "scheduled" | "denied" | "unavailable"
> {
  clearLastNativeNotificationError();
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin) {
    return "unavailable";
  }

  const status = await getNotificationPermissionStatus();
  if (status !== "granted") {
    return "denied";
  }

  await ensureActionTypesRegistered(plugin);

  const at = new Date(Date.now() + TEST_NOTIFICATION_LEAD_MS);
  const notification: LocalNotificationDescriptor = {
    id: notificationIdForOccurrence(`test:${at.getTime()}`),
    title: "Test reminder",
    body: "If you can see this, notifications are working.",
    sound: DEFAULT_NOTIFICATION_SOUND,
    silent: false,
    schedule: {
      at,
      allowWhileIdle: true,
    },
    extra: {
      app: APP_NOTIFICATION_MARKER,
      test: true,
      scheduledFor: at.toISOString(),
    },
    actionTypeId: REMINDER_ACTION_TYPE_ID,
  };
  let scheduled = false;

  await enqueueReconcile("schedule test notification", async () => {
    try {
      await withNativeTimeout(
        plugin.schedule({ notifications: [notification] }),
        "LocalNotifications.schedule (test)",
        NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
      );
      scheduled = true;
    } catch (error) {
      recordNativeNotificationError("schedule", error);
      resetLocalNotificationsPlugin();
      throw error;
    }
  });

  return scheduled ? "scheduled" : "unavailable";
}

// Every native-queue mutation runs through this single FIFO so they never
// overlap or reorder: a late "cancel" can no longer wipe a freshly scheduled
// reminder, and two reschedules can't clobber each other. Each step logs its
// outcome + duration so scheduling is observable on-device instead of silent.
let reconcileTail: Promise<void> = Promise.resolve();

function enqueueReconcile(
  label: string,
  work: () => Promise<void>,
): Promise<void> {
  const run = reconcileTail.then(async () => {
    const startedAt = Date.now();
    try {
      await work();
      console.info(`[notifications] ${label}: ok (${Date.now() - startedAt}ms)`);
    } catch (error) {
      console.error(
        `[notifications] ${label}: failed (${Date.now() - startedAt}ms)`,
        error,
      );
    }
  });
  // The wrapper above swallows + logs, so the chain never rejects and stays alive.
  reconcileTail = run;
  return run;
}

// Serialized entry point for the reminder write path (create/update/delete):
// schedule when the reminder should be active, otherwise cancel. Because the
// queue preserves submission order, a disable-then-enable sequence ends up
// scheduled (not cancelled), fixing the "saved but never arrives" race.
export function reconcileReminderNotifications(
  reminderId: string,
  enabled: boolean,
): Promise<void> {
  return enqueueReconcile(
    `${enabled ? "schedule" : "cancel"} ${reminderId}`,
    () =>
      enabled
        ? scheduleReminderNotifications(reminderId)
        : cancelReminderNotifications(reminderId),
  );
}

let pendingReschedule: Promise<void> | null = null;

export function rescheduleAllNotifications(): Promise<void> {
  // Coalesce: reuse an already queued/running full reschedule instead of piling
  // up duplicates. It runs on the shared queue, so it never overlaps a
  // per-reminder reconcile.
  if (pendingReschedule) {
    return pendingReschedule;
  }

  pendingReschedule = enqueueReconcile(
    "reschedule-all",
    runRescheduleAllNotifications,
  );
  void pendingReschedule.finally(() => {
    pendingReschedule = null;
  });

  return pendingReschedule;
}

export function rescheduleAllNotificationsInBackground(): void {
  void rescheduleAllNotifications().catch((error) => {
    console.warn("[notifications] background reschedule failed", error);
  });
}

async function runRescheduleAllNotifications(): Promise<void> {
  const reminders = await listRemindersFromStorage();

  await cancelAllAppNotifications();

  for (const reminder of reminders) {
    if (reminder.enabled && !reminder.deletedAt) {
      await scheduleReminderNotifications(reminder.id, { skipCancel: true });
    }
  }
}

export async function scheduleReminderNotifications(
  reminderId: string,
  options: { skipCancel?: boolean } = {},
): Promise<void> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin) {
    return;
  }

  if (!options.skipCancel) {
    await cancelReminderNotifications(reminderId);
  }

  const reminders = await listRemindersFromStorage();
  const reminder = reminders.find(
    (candidate) => candidate.id === reminderId && !candidate.deletedAt,
  );

  if (!reminder?.enabled) {
    return;
  }

  if ((await getNotificationPermissionStatus()) !== "granted") {
    return;
  }

  const now = new Date();
  const occurrences = generateOccurrencesForReminder(reminder, {
    from: now,
    through: addDays(now, NOTIFICATION_LOOKAHEAD_DAYS),
    limit: MAX_NOTIFICATIONS_PER_REMINDER,
  });

  await scheduleOccurrenceNotifications(reminder, occurrences);
}

export async function cancelReminderNotifications(
  reminderId: string,
): Promise<void> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.getPending) {
    return;
  }

  const pending = await getPendingNotifications(plugin);

  if (!pending) {
    return;
  }

  const ids = pending.notifications
    .filter((notification) => notification.extra?.reminderId === reminderId)
    .filter(isAppNotification)
    .map((notification) => ({ id: notification.id }));

  await cancelNotifications(plugin, ids);
}

export async function cancelOccurrenceNotification(
  occurrenceId: string,
): Promise<void> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.getPending) {
    return;
  }

  const pending = await getPendingNotifications(plugin);

  if (!pending) {
    return;
  }

  const ids = pending.notifications
    .filter((notification) => notification.extra?.occurrenceId === occurrenceId)
    .filter(isAppNotification)
    .map((notification) => ({ id: notification.id }));

  await cancelNotifications(plugin, ids);
}

export async function scheduleOccurrenceNotification(
  reminder: Reminder,
  occurrence: ReminderOccurrence,
  settings?: AppSettings,
): Promise<void> {
  await scheduleOccurrenceNotifications(reminder, [occurrence], settings);
}

export async function scheduleOccurrenceNotifications(
  reminder: Reminder,
  occurrences: ReminderOccurrence[],
  settings?: AppSettings,
): Promise<void> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin || occurrences.length === 0) {
    return;
  }

  if ((await getNotificationPermissionStatus()) !== "granted") {
    return;
  }

  await ensureActionTypesRegistered(plugin);

  const appSettings = settings ?? (await getSettings());
  const earliestScheduledAt = Date.now() + MIN_NOTIFICATION_LEAD_MS;
  const notifications = occurrences
    .filter(
      (occurrence) =>
        new Date(occurrence.scheduledFor).getTime() >= earliestScheduledAt,
    )
    .map((occurrence) =>
      toLocalNotification(reminder, occurrence, appSettings),
  );

  if (notifications.length > 0) {
    try {
      await withNativeTimeout(
        plugin.schedule({ notifications }),
        "LocalNotifications.schedule",
        NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      // The reminder write path is the most common scheduling failure; record
      // it so Settings can surface the reason, same as the test-notification
      // path.
      recordNativeNotificationError("schedule", error);
      resetLocalNotificationsPlugin();
    }
  }
}

export function notificationIdForOccurrence(occurrenceId: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < occurrenceId.length; index += 1) {
    hash ^= occurrenceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return ((hash >>> 0) % 2147483646) + 1;
}

export function getNotificationText(
  reminder: Reminder,
  settings: AppSettings,
): { title: string; body: string } {
  if (settings.privacyMode) {
    return {
      title:
        reminder.privateNotificationText?.trim() ||
        settings.privacyFallbackText ||
        "Reminder",
      body: "",
    };
  }

  return {
    title: "Reminder",
    body: reminder.text,
  };
}

async function cancelAllAppNotifications(): Promise<void> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.getPending) {
    return;
  }

  const pending = await getPendingNotifications(plugin);

  if (!pending) {
    return;
  }

  const ids = pending.notifications
    .filter(isAppNotification)
    .map((notification) => ({ id: notification.id }));

  await cancelNotifications(plugin, ids);
}

function toLocalNotification(
  reminder: Reminder,
  occurrence: ReminderOccurrence,
  settings: AppSettings,
): LocalNotificationDescriptor {
  const text = getNotificationText(reminder, settings);

  return {
    id: notificationIdForOccurrence(occurrence.id),
    title: text.title,
    body: text.body,
    sound: DEFAULT_NOTIFICATION_SOUND,
    silent: false,
    schedule: {
      at: new Date(occurrence.scheduledFor),
      allowWhileIdle: true,
    },
    extra: {
      app: APP_NOTIFICATION_MARKER,
      reminderId: reminder.id,
      occurrenceId: occurrence.id,
      scheduledFor: occurrence.scheduledFor,
      source: occurrence.source,
    },
    actionTypeId: REMINDER_ACTION_TYPE_ID,
  };
}

async function ensureActionTypesRegistered(
  plugin: LocalNotificationsPlugin,
): Promise<void> {
  if (actionTypesRegistered || !plugin.registerActionTypes) {
    return;
  }

  try {
    await withNativeTimeout(
      plugin.registerActionTypes({
        types: [
          {
            id: REMINDER_ACTION_TYPE_ID,
            actions: [
              { id: "done", title: "Done", foreground: false },
              { id: "later10", title: "Later 10m", foreground: false },
              { id: "skip", title: "Skip", foreground: false },
            ],
          },
        ],
      }),
      "LocalNotifications.registerActionTypes",
      NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
    );
    actionTypesRegistered = true;
  } catch {
    actionTypesRegistered = true;
  }
}

async function getLocalNotificationsPlugin(): Promise<LocalNotificationsPlugin | null> {
  if (!localNotificationsPromise) {
    localNotificationsPromise = loadLocalNotificationsPlugin();
  }

  try {
    return await withNativeTimeout(
      localNotificationsPromise,
      "LocalNotifications plugin load",
      NOTIFICATION_PLUGIN_LOAD_TIMEOUT_MS,
    );
  } catch (error) {
    recordNativeNotificationError("plugin load", error);
    resetLocalNotificationsPlugin();
    return null;
  }
}

async function getPendingNotifications(
  plugin: LocalNotificationsPlugin,
  options: { resetOnFailure?: boolean } = {},
): Promise<{ notifications: LocalNotificationDescriptor[] } | null> {
  if (!plugin.getPending) {
    return null;
  }

  try {
    return await withNativeTimeout(
      plugin.getPending(),
      "LocalNotifications.getPending",
      NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
    );
  } catch {
    if (options.resetOnFailure !== false) {
      resetLocalNotificationsPlugin();
    }
    return null;
  }
}

async function getDeliveredNotifications(
  plugin: LocalNotificationsPlugin,
): Promise<{ notifications: LocalNotificationDescriptor[] } | null> {
  if (!plugin.getDeliveredNotifications) {
    return null;
  }

  try {
    return await withNativeTimeout(
      plugin.getDeliveredNotifications(),
      "LocalNotifications.getDeliveredNotifications",
      NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

async function getNotificationsEnabled(
  plugin: LocalNotificationsPlugin,
): Promise<boolean | null> {
  if (!plugin.areEnabled) {
    return null;
  }

  try {
    return (
      await withNativeTimeout(
        plugin.areEnabled(),
        "LocalNotifications.areEnabled",
        NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
      )
    ).value;
  } catch {
    return null;
  }
}

async function cancelNotifications(
  plugin: LocalNotificationsPlugin,
  notifications: Array<{ id: number }>,
): Promise<void> {
  if (notifications.length === 0) {
    return;
  }

  try {
    await withNativeTimeout(
      plugin.cancel({ notifications }),
      "LocalNotifications.cancel",
      NOTIFICATION_NATIVE_CALL_TIMEOUT_MS,
    );
  } catch {
    resetLocalNotificationsPlugin();
  }
}

function isAppNotification(notification: LocalNotificationDescriptor): boolean {
  return notification.extra?.app === APP_NOTIFICATION_MARKER;
}

function getNotificationScheduleTime(
  notification: LocalNotificationDescriptor,
): number {
  const at = notification.schedule?.at;

  if (at instanceof Date) {
    return at.getTime();
  }

  if (typeof at === "string") {
    return new Date(at).getTime();
  }

  return Number.NaN;
}

function resetLocalNotificationsPlugin(): void {
  // Surface the failure instead of swallowing it silently, then drop the cached
  // plugin handle and action-type registration so the next call re-resolves
  // them. A transient native failure/timeout must not disable notifications for
  // the rest of the session — the foreground reschedule and later actions can
  // retry once the bridge is responsive again.
  console.warn(
    "[notifications] native call failed or timed out; plugin reset for retry",
  );
  localNotificationsPromise = null;
  actionTypesRegistered = false;
}

async function loadLocalNotificationsPlugin(): Promise<LocalNotificationsPlugin | null> {
  if (Capacitor.getPlatform() === "web") {
    return null;
  }

  // Statically imported (see storage.ts) to avoid a dynamic import() that can
  // hang in the iOS WKWebView and freeze the app on first launch.
  return LocalNotifications as unknown as LocalNotificationsPlugin;
}

function normalizePermissionStatus(
  response: PermissionResponse,
): NotificationPermissionStatus {
  const display = response.display ?? response.receive ?? response.permission;

  if (display === "granted") {
    return "granted";
  }

  if (display === "denied") {
    return "denied";
  }

  return "unknown";
}
