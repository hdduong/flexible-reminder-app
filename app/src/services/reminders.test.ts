import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateReminderInput } from "../types";
import { createReminder, listReminders } from "./reminders";
import { removeStoredValue, STORAGE_KEYS } from "./storage";

vi.mock("./notifications", () => ({
  cancelOccurrenceNotification: vi.fn(),
  cancelReminderNotifications: vi.fn(),
  scheduleOccurrenceNotification: vi.fn(),
  scheduleReminderNotifications: vi.fn(
    () => new Promise<void>(() => undefined),
  ),
}));

const reminderInput: CreateReminderInput = {
  text: "Stretch",
  privateNotificationText: null,
  schedule: {
    daysOfWeek: [1],
    startTime: "09:00",
    endTime: "17:00",
    mode: "interval",
    intervalMinutes: 120,
    exactTimes: [],
    timezone: "America/Los_Angeles",
  },
  snoozeMinutesOverride: 10,
};

describe("reminders", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await removeStoredValue(STORAGE_KEYS.settings);
    await removeStoredValue(STORAGE_KEYS.reminders);
    await removeStoredValue(STORAGE_KEYS.events);
  });

  it("does not block reminder creation on notification scheduling", async () => {
    const reminder = await createReminder(reminderInput);

    expect(reminder.text).toBe("Stretch");
    await expect(listReminders()).resolves.toHaveLength(1);
  });
});
