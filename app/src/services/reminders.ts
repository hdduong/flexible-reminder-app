import type {
  CreateReminderInput,
  Reminder,
  ReminderEvent,
  ReminderEventType,
  ReminderOccurrence,
  ReminderSchedule,
  UpdateReminderInput,
} from "../types";
import { createUuid } from "../types";
import {
  appendReminderEvent,
  getSettings,
  listRemindersFromStorage,
  readJson,
  saveReminders,
  writeJson,
} from "./storage";
import {
  cancelOccurrenceNotification,
  cancelReminderNotifications,
  scheduleOccurrenceNotification,
  scheduleReminderNotifications,
} from "./notifications";
import {
  createOccurrence,
  getNextOccurrence as getNextScheduledOccurrence,
  getReminderIdFromOccurrenceId,
  getScheduledDateFromOccurrenceId,
  listTodayOccurrences as listScheduledTodayOccurrences,
  previewSchedule as previewReminderSchedule,
  validateReminderSchedule,
} from "./schedule";

const MAX_REMINDER_TEXT_LENGTH = 120;

const STARTER_CLEANUP_KEY = "migration:starterCleanup:v1";
const LEGACY_STARTER_TEXTS = new Set([
  "Try bathroom",
  "Drink water",
  "Study English",
]);

// One-time migration: earlier builds auto-seeded three sample reminders. Remove
// those still-untouched samples from existing installs (createdAt === updatedAt
// means the user never edited them), then record that it ran so a user who
// later creates a reminder with the same text is never affected.
export async function removeLegacyStarterReminders(): Promise<void> {
  const alreadyCleaned = await readJson<boolean>(STARTER_CLEANUP_KEY, false);
  if (alreadyCleaned) {
    return;
  }

  const reminders = await listRemindersFromStorage();
  const remaining = reminders.filter(
    (reminder) =>
      !(
        LEGACY_STARTER_TEXTS.has(reminder.text) &&
        reminder.createdAt === reminder.updatedAt
      ),
  );

  if (remaining.length !== reminders.length) {
    await saveReminders(remaining);
  }

  await writeJson(STARTER_CLEANUP_KEY, true);
}

export async function listReminders(): Promise<Reminder[]> {
  return (await listRemindersFromStorage()).filter(
    (reminder) => !reminder.deletedAt,
  );
}

export async function getReminder(id: string): Promise<Reminder | null> {
  const reminders = await listReminders();
  return reminders.find((reminder) => reminder.id === id) ?? null;
}

export async function createReminder(
  input: CreateReminderInput,
): Promise<Reminder> {
  const reminders = await listRemindersFromStorage();
  const now = new Date();
  const reminder: Reminder = {
    id: createUuid(`${now.toISOString()}:${input.text}:${reminders.length}`),
    text: normalizeReminderText(input.text),
    privateNotificationText: normalizeOptionalText(
      input.privateNotificationText,
    ),
    enabled: input.enabled ?? true,
    schedule: normalizeSchedule(input.schedule),
    snoozeMinutesOverride: normalizeOptionalMinutes(
      input.snoozeMinutesOverride,
    ),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deletedAt: null,
  };

  await saveReminders([...reminders, reminder]);

  if (reminder.enabled) {
    scheduleReminderNotificationsInBackground(reminder.id);
  }

  return reminder;
}

export async function updateReminder(
  id: string,
  input: UpdateReminderInput,
): Promise<Reminder> {
  const reminders = await listRemindersFromStorage();
  const index = reminders.findIndex(
    (reminder) => reminder.id === id && !reminder.deletedAt,
  );

  if (index < 0) {
    throw new Error(`Reminder "${id}" was not found.`);
  }

  const current = reminders[index];
  const next: Reminder = {
    ...current,
    text:
      input.text === undefined
        ? current.text
        : normalizeReminderText(input.text),
    privateNotificationText:
      input.privateNotificationText === undefined
        ? current.privateNotificationText
        : normalizeOptionalText(input.privateNotificationText),
    enabled: input.enabled ?? current.enabled,
    schedule:
      input.schedule === undefined
        ? current.schedule
        : normalizeSchedule(input.schedule),
    snoozeMinutesOverride:
      input.snoozeMinutesOverride === undefined
        ? current.snoozeMinutesOverride
        : normalizeOptionalMinutes(input.snoozeMinutesOverride),
    updatedAt: new Date().toISOString(),
  };

  reminders[index] = next;
  await saveReminders(reminders);
  await cancelReminderNotifications(id);

  if (next.enabled) {
    await scheduleReminderNotifications(id);
  }

  return next;
}

export async function deleteReminder(id: string): Promise<void> {
  const reminders = await listRemindersFromStorage();
  const index = reminders.findIndex(
    (reminder) => reminder.id === id && !reminder.deletedAt,
  );

  if (index < 0) {
    return;
  }

  const now = new Date().toISOString();
  reminders[index] = {
    ...reminders[index],
    enabled: false,
    updatedAt: now,
    deletedAt: now,
  };

  await saveReminders(reminders);
  await cancelReminderNotifications(id);
}

export async function setReminderEnabled(
  id: string,
  enabled: boolean,
): Promise<Reminder> {
  return updateReminder(id, { enabled });
}

export async function enableReminder(id: string): Promise<Reminder> {
  return setReminderEnabled(id, true);
}

export async function disableReminder(id: string): Promise<Reminder> {
  return setReminderEnabled(id, false);
}

export async function previewSchedule(
  input: ReminderSchedule,
): Promise<ReminderOccurrence[]> {
  return previewReminderSchedule(input);
}

export async function listTodayOccurrences(
  date: string,
): Promise<ReminderOccurrence[]> {
  return listScheduledTodayOccurrences(await listReminders(), date);
}

export async function getNextOccurrence(
  now = new Date(),
): Promise<ReminderOccurrence | null> {
  return getNextScheduledOccurrence(await listReminders(), now);
}

export async function markDone(occurrenceId: string): Promise<void> {
  const context = await getOccurrenceContext(occurrenceId);

  await appendReminderEvent(
    createReminderEvent(context.reminder, occurrenceId, "done", {
      scheduledFor: context.scheduledFor,
    }),
  );
  await cancelOccurrenceNotification(occurrenceId);
}

export async function skipOccurrence(occurrenceId: string): Promise<void> {
  const context = await getOccurrenceContext(occurrenceId);

  await appendReminderEvent(
    createReminderEvent(context.reminder, occurrenceId, "skip", {
      scheduledFor: context.scheduledFor,
    }),
  );
  await cancelOccurrenceNotification(occurrenceId);
}

export async function snoozeOccurrence(
  occurrenceId: string,
  minutes?: number,
): Promise<void> {
  const context = await getOccurrenceContext(occurrenceId);
  const settings = await getSettings();
  const snoozeMinutes =
    minutes ??
    context.reminder.snoozeMinutesOverride ??
    settings.defaultSnoozeMinutes;

  if (!Number.isInteger(snoozeMinutes) || snoozeMinutes <= 0) {
    throw new Error("Snooze minutes must be a positive integer.");
  }

  const snoozedFor = new Date(Date.now() + snoozeMinutes * 60_000);
  const snoozedOccurrence = createOccurrence(
    context.reminder.id,
    snoozedFor,
    "snooze",
  );

  await appendReminderEvent(
    createReminderEvent(context.reminder, occurrenceId, "snooze", {
      scheduledFor: context.scheduledFor,
      metadata: {
        minutes: snoozeMinutes,
        snoozedOccurrenceId: snoozedOccurrence.id,
        snoozedFor: snoozedOccurrence.scheduledFor,
      },
    }),
  );

  await cancelOccurrenceNotification(occurrenceId);
  await scheduleOccurrenceNotification(
    context.reminder,
    snoozedOccurrence,
    settings,
  );
}

async function getOccurrenceContext(
  occurrenceId: string,
): Promise<{ reminder: Reminder; scheduledFor: string }> {
  const reminderId = getReminderIdFromOccurrenceId(occurrenceId);
  const scheduledDate = getScheduledDateFromOccurrenceId(occurrenceId);

  if (!reminderId || !scheduledDate) {
    throw new Error(`Invalid occurrence id "${occurrenceId}".`);
  }

  const reminder = await getReminder(reminderId);

  if (!reminder) {
    throw new Error(`Reminder "${reminderId}" was not found.`);
  }

  return {
    reminder,
    scheduledFor: scheduledDate.toISOString(),
  };
}

function createReminderEvent(
  reminder: Reminder,
  occurrenceId: string,
  type: ReminderEventType,
  input: {
    scheduledFor: string;
    metadata?: Record<string, unknown> | null;
  },
): ReminderEvent {
  const createdAt = new Date().toISOString();

  return {
    id: createUuid(
      `${reminder.id}:${occurrenceId}:${type}:${input.scheduledFor}:${createdAt}`,
    ),
    reminderId: reminder.id,
    occurrenceId,
    type,
    scheduledFor: input.scheduledFor,
    createdAt,
    metadata: input.metadata ?? null,
  };
}

function normalizeReminderText(text: string): string {
  const normalizedText = text.trim();

  if (!normalizedText) {
    throw new Error("Reminder text is required.");
  }

  if (normalizedText.length > MAX_REMINDER_TEXT_LENGTH) {
    throw new Error(
      `Reminder text must be ${MAX_REMINDER_TEXT_LENGTH} characters or less.`,
    );
  }

  return normalizedText;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalMinutes(
  value: number | null | undefined,
): number | null {
  if (value == null) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Snooze minutes must be a positive integer.");
  }

  return value;
}

function normalizeSchedule(schedule: ReminderSchedule): ReminderSchedule {
  return validateReminderSchedule(schedule);
}

function scheduleReminderNotificationsInBackground(reminderId: string): void {
  void scheduleReminderNotifications(reminderId).catch(() => undefined);
}
