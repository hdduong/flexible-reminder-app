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

type PermissionResponse = Record<string, string | undefined>;

interface LocalNotificationDescriptor {
  id: number;
  title: string;
  body: string;
  schedule?: {
    at: Date;
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
}

let localNotificationsPromise: Promise<LocalNotificationsPlugin | null> | null =
  null;
let actionTypesRegistered = false;

export async function requestNotificationPermission(): Promise<
  "granted" | "denied"
> {
  const plugin = await getLocalNotificationsPlugin();

  if (!plugin?.requestPermissions) {
    await updateSettings({ notificationPermissionStatus: "denied" });
    return "denied";
  }

  let permissionStatus: "granted" | "denied" = "denied";

  try {
    const response = await withNativeTimeout(
      plugin.requestPermissions(),
      "LocalNotifications.requestPermissions",
    );
    const status = normalizePermissionStatus(response);
    permissionStatus = status === "granted" ? "granted" : "denied";
  } catch {
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
      ),
    );
  } catch {
    resetLocalNotificationsPlugin();
    return "denied";
  }
}

let rescheduleInFlight: Promise<void> | null = null;
let rescheduleQueued = false;

export function rescheduleAllNotifications(): Promise<void> {
  // A reschedule cancels the whole app queue and rebuilds it, so two running
  // at once can clobber each other (one cancels while the other schedules).
  // Serialize: run one at a time, coalescing extra calls into a single
  // trailing re-run so the final state reflects the latest data.
  if (rescheduleInFlight) {
    rescheduleQueued = true;
    return rescheduleInFlight;
  }

  rescheduleInFlight = (async () => {
    try {
      do {
        rescheduleQueued = false;
        await runRescheduleAllNotifications();
      } while (rescheduleQueued);
    } finally {
      rescheduleInFlight = null;
    }
  })();

  return rescheduleInFlight;
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
    .filter((notification) => notification.extra?.app === APP_NOTIFICATION_MARKER)
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
    .filter((notification) => notification.extra?.app === APP_NOTIFICATION_MARKER)
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
  const now = Date.now();
  const notifications = occurrences
    .filter((occurrence) => new Date(occurrence.scheduledFor).getTime() >= now)
    .map((occurrence) =>
      toLocalNotification(reminder, occurrence, appSettings),
  );

  if (notifications.length > 0) {
    try {
      await withNativeTimeout(
        plugin.schedule({ notifications }),
        "LocalNotifications.schedule",
      );
    } catch {
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
    .filter((notification) => notification.extra?.app === APP_NOTIFICATION_MARKER)
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
    );
  } catch {
    resetLocalNotificationsPlugin();
    return null;
  }
}

async function getPendingNotifications(
  plugin: LocalNotificationsPlugin,
): Promise<{ notifications: LocalNotificationDescriptor[] } | null> {
  if (!plugin.getPending) {
    return null;
  }

  try {
    return await withNativeTimeout(
      plugin.getPending(),
      "LocalNotifications.getPending",
    );
  } catch {
    resetLocalNotificationsPlugin();
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
    );
  } catch {
    resetLocalNotificationsPlugin();
  }
}

function resetLocalNotificationsPlugin(): void {
  // Drop the cached plugin handle and action-type registration so the next
  // call re-resolves them. A transient native failure/timeout must not disable
  // notifications for the rest of the session — the foreground reschedule and
  // later actions can retry once the bridge is responsive again.
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
