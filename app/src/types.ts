export type ISODateTimeString = string;
export type LocalTimeString = string;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ReminderScheduleMode = "interval" | "exact_times";

export interface ReminderSchedule {
  daysOfWeek: Weekday[];
  startTime: LocalTimeString;
  endTime: LocalTimeString;
  mode: ReminderScheduleMode;
  intervalMinutes: number | null;
  exactTimes: LocalTimeString[];
  timezone: string;
}

export interface Reminder {
  id: string;
  text: string;
  privateNotificationText: string | null;
  enabled: boolean;
  schedule: ReminderSchedule;
  snoozeMinutesOverride: number | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  deletedAt: ISODateTimeString | null;
}

export type ReminderOccurrenceStatus =
  | "pending"
  | "done"
  | "skipped"
  | "snoozed"
  | "missed";

export type ReminderOccurrenceSource = "schedule" | "snooze";

export interface ReminderOccurrence {
  id: string;
  reminderId: string;
  scheduledFor: ISODateTimeString;
  status: ReminderOccurrenceStatus;
  source: ReminderOccurrenceSource;
}

export type ReminderEventType =
  | "done"
  | "skip"
  | "snooze"
  | "missed"
  | "notification_tapped";

export interface ReminderEvent {
  id: string;
  reminderId: string;
  occurrenceId: string;
  type: ReminderEventType;
  scheduledFor: ISODateTimeString;
  createdAt: ISODateTimeString;
  metadata: Record<string, unknown> | null;
}

export type NotificationPermissionStatus = "unknown" | "granted" | "denied";
export type WeekStartsOn = "monday" | "sunday";

export interface AppSettings {
  notificationPermissionStatus: NotificationPermissionStatus;
  defaultSnoozeMinutes: number;
  privacyMode: boolean;
  privacyFallbackText: string;
  weekStartsOn: WeekStartsOn;
  schemaVersion: number;
  updatedAt: ISODateTimeString;
}

export interface CreateReminderInput {
  text: string;
  privateNotificationText?: string | null;
  enabled?: boolean;
  schedule: ReminderSchedule;
  snoozeMinutesOverride?: number | null;
}

export interface UpdateReminderInput {
  text?: string;
  privateNotificationText?: string | null;
  enabled?: boolean;
  schedule?: ReminderSchedule;
  snoozeMinutesOverride?: number | null;
}

export const DEFAULT_SCHEMA_VERSION = 1;
export const DEFAULT_SNOOZE_MINUTES = 10;
export const DEFAULT_PRIVACY_FALLBACK_TEXT = "Reminder";

export function createDefaultSettings(now = new Date()): AppSettings {
  return {
    notificationPermissionStatus: "unknown",
    defaultSnoozeMinutes: DEFAULT_SNOOZE_MINUTES,
    privacyMode: false,
    privacyFallbackText: DEFAULT_PRIVACY_FALLBACK_TEXT,
    weekStartsOn: "monday",
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
  };
}

let fallbackUuidCounter = 0;

export function createUuid(seed?: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

  if (randomUUID) {
    return randomUUID();
  }

  return createDeterministicUuid(
    seed ?? `flexible-reminder:${fallbackUuidCounter++}`,
  );
}

export function createDeterministicUuid(seed: string): string {
  const hex = [
    hash32(seed, 0x811c9dc5),
    hash32(seed, 0x9e3779b9),
    hash32(seed, 0x85ebca6b),
    hash32(seed, 0xc2b2ae35),
  ]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("")
    .split("");

  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
}

function hash32(input: string, seed: number): number {
  let hash = seed >>> 0;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  return hash >>> 0;
}
