import type {
  LocalTimeString,
  Reminder,
  ReminderOccurrence,
  ReminderOccurrenceSource,
  ReminderSchedule,
  Weekday,
} from "../types";

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PREVIEW_REMINDER_ID = "preview";
const DEFAULT_LOOKAHEAD_DAYS = 30;
const DEFAULT_OCCURRENCE_LIMIT = 64;

export interface ScheduleGenerationOptions {
  from?: Date;
  through?: Date;
  limit?: number;
  includePast?: boolean;
  reminderId?: string;
}

export interface SchedulePreviewOptions {
  date?: Date | string;
  limit?: number;
  reminderId?: string;
}

export function parseLocalTime(time: LocalTimeString): number {
  const match = LOCAL_TIME_PATTERN.exec(time);

  if (!match) {
    throw new Error(`Invalid local time "${time}". Expected HH:mm.`);
  }

  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

export function formatLocalTime(totalMinutes: number): LocalTimeString {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}`;
}

export function validateReminderSchedule(
  schedule: ReminderSchedule,
): ReminderSchedule {
  const daysOfWeek = normalizeDaysOfWeek(schedule.daysOfWeek);
  const startMinutes = parseLocalTime(schedule.startTime);
  const endMinutes = parseLocalTime(schedule.endTime);

  if (daysOfWeek.length === 0) {
    throw new Error("A reminder schedule must include at least one weekday.");
  }

  if (endMinutes <= startMinutes) {
    throw new Error("Schedule endTime must be after startTime.");
  }

  if (schedule.mode === "interval") {
    const intervalMinutes = schedule.intervalMinutes;

    if (!Number.isInteger(intervalMinutes) || Number(intervalMinutes) <= 0) {
      throw new Error("Interval schedules require a positive intervalMinutes.");
    }

    return {
      ...schedule,
      daysOfWeek,
      intervalMinutes: Number(intervalMinutes),
      exactTimes: [],
      timezone: schedule.timezone || getDeviceTimezone(),
    };
  }

  if (schedule.mode === "exact_times") {
    const exactTimes = [...new Set(schedule.exactTimes ?? [])].sort(
      compareLocalTimes,
    );

    if (exactTimes.length === 0) {
      throw new Error("Exact-time schedules require at least one exact time.");
    }

    for (const exactTime of exactTimes) {
      const minutes = parseLocalTime(exactTime);

      if (minutes < startMinutes || minutes > endMinutes) {
        throw new Error(
          `Exact time "${exactTime}" falls outside the active time window.`,
        );
      }
    }

    return {
      ...schedule,
      daysOfWeek,
      intervalMinutes: null,
      exactTimes,
      timezone: schedule.timezone || getDeviceTimezone(),
    };
  }

  throw new Error(`Unsupported schedule mode "${String(schedule.mode)}".`);
}

export function getScheduleTimes(schedule: ReminderSchedule): LocalTimeString[] {
  const normalized = validateReminderSchedule(schedule);
  const startMinutes = parseLocalTime(normalized.startTime);
  const endMinutes = parseLocalTime(normalized.endTime);

  if (normalized.mode === "exact_times") {
    return normalized.exactTimes;
  }

  const intervalMinutes = normalized.intervalMinutes ?? 0;
  const times: LocalTimeString[] = [];

  for (
    let minutes = startMinutes;
    minutes <= endMinutes;
    minutes += intervalMinutes
  ) {
    times.push(formatLocalTime(minutes));
  }

  return times;
}

export function generateOccurrencesForReminder(
  reminder: Reminder,
  options: ScheduleGenerationOptions = {},
): ReminderOccurrence[] {
  if (!reminder.enabled || reminder.deletedAt) {
    return [];
  }

  return generateOccurrencesForSchedule(reminder.schedule, {
    ...options,
    reminderId: reminder.id,
  });
}

export function generateOccurrencesForSchedule(
  schedule: ReminderSchedule,
  options: ScheduleGenerationOptions = {},
): ReminderOccurrence[] {
  const normalized = validateReminderSchedule(schedule);
  const from = cloneDate(options.from ?? new Date());
  const through = cloneDate(
    options.through ?? addDays(from, DEFAULT_LOOKAHEAD_DAYS),
  );
  const limit = options.limit ?? DEFAULT_OCCURRENCE_LIMIT;
  const includePast = options.includePast ?? false;
  const reminderId = options.reminderId ?? PREVIEW_REMINDER_ID;
  const times = getScheduleTimes(normalized).map((time) => parseLocalTime(time));
  const occurrences: ReminderOccurrence[] = [];

  if (through.getTime() < from.getTime() || limit <= 0) {
    return occurrences;
  }

  for (
    let day = startOfLocalDay(from);
    day.getTime() <= through.getTime();
    day = addDays(day, 1)
  ) {
    if (!normalized.daysOfWeek.includes(day.getDay() as Weekday)) {
      continue;
    }

    for (const minutes of times) {
      const scheduledFor = dateAtLocalMinutes(day, minutes);

      if (scheduledFor.getTime() > through.getTime()) {
        continue;
      }

      if (!includePast && scheduledFor.getTime() < from.getTime()) {
        continue;
      }

      occurrences.push(
        createOccurrence(reminderId, scheduledFor, "schedule"),
      );

      if (occurrences.length >= limit) {
        return occurrences.sort(compareOccurrences);
      }
    }
  }

  return occurrences.sort(compareOccurrences);
}

export function previewSchedule(
  schedule: ReminderSchedule,
  options: SchedulePreviewOptions = {},
): ReminderOccurrence[] {
  const normalized = validateReminderSchedule(schedule);
  const baseDate = startOfLocalDay(parseLocalDate(options.date ?? new Date()));
  const previewDay = findNextSelectedDay(baseDate, normalized.daysOfWeek);

  return generateOccurrencesForSchedule(normalized, {
    from: previewDay,
    through: endOfLocalDay(previewDay),
    includePast: true,
    limit: options.limit ?? DEFAULT_OCCURRENCE_LIMIT,
    reminderId: options.reminderId ?? PREVIEW_REMINDER_ID,
  });
}

export function listTodayOccurrences(
  reminders: Reminder[],
  date: Date | string = new Date(),
  now = new Date(),
): ReminderOccurrence[] {
  const targetDay = startOfLocalDay(parseLocalDate(date));
  const currentDay = startOfLocalDay(now);

  if (targetDay.getTime() < currentDay.getTime()) {
    return [];
  }

  const from = isSameLocalDate(targetDay, now) ? now : targetDay;
  const through = endOfLocalDay(targetDay);

  return reminders
    .flatMap((reminder) =>
      generateOccurrencesForReminder(reminder, {
        from,
        through,
        includePast: false,
      }),
    )
    .sort(compareOccurrences);
}

export function getNextOccurrence(
  reminders: Reminder[],
  now = new Date(),
): ReminderOccurrence | null {
  const through = addDays(now, DEFAULT_LOOKAHEAD_DAYS);
  const [nextOccurrence] = reminders
    .flatMap((reminder) =>
      generateOccurrencesForReminder(reminder, {
        from: now,
        through,
        limit: 1,
      }),
    )
    .sort(compareOccurrences);

  return nextOccurrence ?? null;
}

export function createOccurrenceId(
  source: ReminderOccurrenceSource,
  reminderId: string,
  scheduledFor: Date,
): string {
  return `occ:${source}:${reminderId}:${scheduledFor.getTime()}`;
}

export function createOccurrence(
  reminderId: string,
  scheduledFor: Date,
  source: ReminderOccurrenceSource,
): ReminderOccurrence {
  return {
    id: createOccurrenceId(source, reminderId, scheduledFor),
    reminderId,
    scheduledFor: scheduledFor.toISOString(),
    status: "pending",
    source,
  };
}

export function getReminderIdFromOccurrenceId(
  occurrenceId: string,
): string | null {
  const parts = occurrenceId.split(":");

  if (parts.length !== 4 || parts[0] !== "occ") {
    return null;
  }

  return parts[2] || null;
}

export function getScheduledDateFromOccurrenceId(
  occurrenceId: string,
): Date | null {
  const parts = occurrenceId.split(":");
  const timestamp = Number.parseInt(parts[3] ?? "", 10);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp);
}

export function addDays(date: Date, days: number): Date {
  const next = cloneDate(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfLocalDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
}

export function parseLocalDate(date: Date | string): Date {
  if (date instanceof Date) {
    return cloneDate(date);
  }

  const localDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (localDateMatch) {
    return new Date(
      Number.parseInt(localDateMatch[1], 10),
      Number.parseInt(localDateMatch[2], 10) - 1,
      Number.parseInt(localDateMatch[3], 10),
    );
  }

  return new Date(date);
}

function normalizeDaysOfWeek(daysOfWeek: number[]): Weekday[] {
  return [...new Set(daysOfWeek)]
    .map((day) => {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`Invalid weekday "${day}". Expected 0 through 6.`);
      }

      return day as Weekday;
    })
    .sort((left, right) => left - right);
}

function compareLocalTimes(left: LocalTimeString, right: LocalTimeString) {
  return parseLocalTime(left) - parseLocalTime(right);
}

function compareOccurrences(
  left: ReminderOccurrence,
  right: ReminderOccurrence,
) {
  return (
    new Date(left.scheduledFor).getTime() -
    new Date(right.scheduledFor).getTime()
  );
}

function findNextSelectedDay(from: Date, daysOfWeek: Weekday[]): Date {
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addDays(from, offset);

    if (daysOfWeek.includes(candidate.getDay() as Weekday)) {
      return candidate;
    }
  }

  return from;
}

function dateAtLocalMinutes(day: Date, minutes: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
  );
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return startOfLocalDay(left).getTime() === startOfLocalDay(right).getTime();
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function getDeviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}
