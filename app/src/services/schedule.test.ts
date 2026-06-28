import { describe, expect, it } from "vitest";
import type { Reminder, ReminderSchedule } from "../types";
import {
  getNextOccurrence,
  listTodayOccurrences,
  previewSchedule,
  validateReminderSchedule,
} from "./schedule";

const workdayIntervalSchedule: ReminderSchedule = {
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "09:00",
  endTime: "17:00",
  mode: "interval",
  intervalMinutes: 120,
  exactTimes: [],
  timezone: "America/Los_Angeles",
};

describe("schedule service", () => {
  it("previews interval schedules including the end of the window", () => {
    const occurrences = previewSchedule(workdayIntervalSchedule, {
      date: "2026-06-29",
    });

    expect(occurrences.map((occurrence) => localTime(occurrence.scheduledFor)))
      .toEqual(["09:00", "11:00", "13:00", "15:00", "17:00"]);
  });

  it("rejects exact times outside the active window", () => {
    expect(() =>
      validateReminderSchedule({
        ...workdayIntervalSchedule,
        mode: "exact_times",
        intervalMinutes: null,
        exactTimes: ["08:59", "12:00"],
      }),
    ).toThrow(/outside the active time window/);
  });

  it("lists only future occurrences for the selected local day", () => {
    const reminder = createReminder(workdayIntervalSchedule);
    const occurrences = listTodayOccurrences(
      [reminder],
      "2026-06-29",
      new Date(2026, 5, 29, 10, 30),
    );

    expect(occurrences.map((occurrence) => localTime(occurrence.scheduledFor)))
      .toEqual(["11:00", "13:00", "15:00", "17:00"]);
  });

  it("gets the next occurrence across reminders", () => {
    const occurrence = getNextOccurrence(
      [createReminder(workdayIntervalSchedule)],
      new Date(2026, 5, 29, 17, 30),
    );

    expect(occurrence?.reminderId).toBe("reminder-1");
    expect(localTime(occurrence?.scheduledFor ?? "")).toBe("09:00");
  });
});

function createReminder(schedule: ReminderSchedule): Reminder {
  return {
    id: "reminder-1",
    text: "Try bathroom",
    privateNotificationText: null,
    enabled: true,
    schedule,
    snoozeMinutesOverride: null,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    deletedAt: null,
  };
}

function localTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
