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
  reconcileReminderNotifications,
  scheduleOccurrenceNotification,
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

// Exact shape of the three reminders earlier builds auto-seeded (after schedule
// normalization). Timezone is intentionally excluded because it is device-
// specific; everything else uniquely identifies an untouched sample.
interface LegacyStarterSignature {
  text: string;
  privateNotificationText: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  mode: ReminderSchedule["mode"];
  intervalMinutes: number | null;
  exactTimes: string[];
  snoozeMinutesOverride: number | null;
}

const LEGACY_STARTER_SIGNATURES: readonly LegacyStarterSignature[] = [
  {
    text: "Try bathroom",
    privateNotificationText: "Quick break",
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: "09:00",
    endTime: "17:00",
    mode: "interval",
    intervalMinutes: 120,
    exactTimes: [],
    snoozeMinutesOverride: 10,
  },
  {
    text: "Drink water",
    privateNotificationText: null,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startTime: "09:00",
    endTime: "17:00",
    mode: "interval",
    intervalMinutes: 180,
    exactTimes: [],
    snoozeMinutesOverride: 10,
  },
  {
    text: "Study English",
    privateNotificationText: null,
    daysOfWeek: [1, 2, 4],
    startTime: "18:30",
    endTime: "20:30",
    mode: "exact_times",
    intervalMinutes: null,
    exactTimes: ["18:30"],
    snoozeMinutesOverride: 10,
  },
];

function sameOrder(left: readonly (number | string)[], right: readonly (number | string)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchesLegacyStarter(reminder: Reminder): boolean {
  return LEGACY_STARTER_SIGNATURES.some((signature) => {
    const schedule = reminder.schedule;
    return (
      reminder.text === signature.text &&
      (reminder.privateNotificationText ?? null) === signature.privateNotificationText &&
      reminder.snoozeMinutesOverride === signature.snoozeMinutesOverride &&
      schedule.mode === signature.mode &&
      schedule.intervalMinutes === signature.intervalMinutes &&
      schedule.startTime === signature.startTime &&
      schedule.endTime === signature.endTime &&
      sameOrder(schedule.daysOfWeek, signature.daysOfWeek) &&
      sameOrder(schedule.exactTimes, signature.exactTimes)
    );
  });
}

// One-time migration: earlier builds auto-seeded three sample reminders. Remove
// any that still exactly match a seeded sample (so a reminder the user created
// or edited — even one sharing a sample's text — is never deleted), then record
// that it ran so it can never remove a later look-alike.
export async function removeLegacyStarterReminders(): Promise<void> {
  const alreadyCleaned = await readJson<boolean>(STARTER_CLEANUP_KEY, false);
  if (alreadyCleaned) {
    return;
  }

  const reminders = await listRemindersFromStorage();
  const remaining = reminders.filter((reminder) => !matchesLegacyStarter(reminder));

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
    void reconcileReminderNotifications(reminder.id, true);
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
  // Persist immediately and reconcile notifications on the serialized queue so
  // the UI never blocks on the native bridge and a late cancel can't wipe a
  // freshly scheduled reminder.
  void reconcileReminderNotifications(id, next.enabled);

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
  void reconcileReminderNotifications(id, false);
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
