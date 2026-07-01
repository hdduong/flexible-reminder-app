import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateReminderInput } from "../types";
import {
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  removeLegacyStarterReminders,
  updateReminder,
} from "./reminders";
import { cancelReminderNotifications } from "./notifications";
import { removeStoredValue, STORAGE_KEYS } from "./storage";

const STARTER_CLEANUP_KEY = "migration:starterCleanup:v1";

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

const legacyStarterInputs: CreateReminderInput[] = [
  {
    text: "Try bathroom",
    privateNotificationText: "Quick break",
    schedule: {
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "09:00",
      endTime: "17:00",
      mode: "interval",
      intervalMinutes: 120,
      exactTimes: [],
      timezone: "America/Los_Angeles",
    },
    snoozeMinutesOverride: 10,
  },
  {
    text: "Drink water",
    privateNotificationText: null,
    schedule: {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "17:00",
      mode: "interval",
      intervalMinutes: 180,
      exactTimes: [],
      timezone: "America/Los_Angeles",
    },
    snoozeMinutesOverride: 10,
  },
  {
    text: "Study English",
    privateNotificationText: null,
    schedule: {
      daysOfWeek: [1, 2, 4],
      startTime: "18:30",
      endTime: "20:30",
      mode: "exact_times",
      intervalMinutes: null,
      exactTimes: ["18:30"],
      timezone: "America/Los_Angeles",
    },
    snoozeMinutesOverride: 10,
  },
];

describe("reminders", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await removeStoredValue(STORAGE_KEYS.settings);
    await removeStoredValue(STORAGE_KEYS.reminders);
    await removeStoredValue(STORAGE_KEYS.events);
    await removeStoredValue(STARTER_CLEANUP_KEY);
  });

  it("does not block reminder creation on notification scheduling", async () => {
    const reminder = await createReminder(reminderInput);

    expect(reminder.text).toBe("Stretch");
    await expect(listReminders()).resolves.toHaveLength(1);
  });

  it("does not block reminder updates on notification scheduling", async () => {
    const created = await createReminder(reminderInput);

    // scheduleReminderNotifications is mocked to never resolve; updateReminder
    // must still resolve and persist because it reconciles in the background.
    const updated = await updateReminder(created.id, { text: "Stretch more" });

    expect(updated.text).toBe("Stretch more");
    await expect(getReminder(created.id)).resolves.toMatchObject({
      text: "Stretch more",
    });
  });

  it("does not block reminder deletion on notification cancellation", async () => {
    const created = await createReminder(reminderInput);
    vi.mocked(cancelReminderNotifications).mockReturnValueOnce(
      new Promise<void>(() => undefined),
    );

    await deleteReminder(created.id);

    await expect(listReminders()).resolves.toHaveLength(0);
    await expect(getReminder(created.id)).resolves.toBeNull();
  });

  it("removes untouched seeded starter reminders", async () => {
    for (const input of legacyStarterInputs) {
      await createReminder(input);
    }
    await expect(listReminders()).resolves.toHaveLength(3);

    await removeLegacyStarterReminders();

    await expect(listReminders()).resolves.toHaveLength(0);
  });

  it("keeps a reminder that shares a starter's text but differs in schedule", async () => {
    await createReminder({
      ...legacyStarterInputs[0],
      schedule: { ...legacyStarterInputs[0].schedule, intervalMinutes: 60 },
    });

    await removeLegacyStarterReminders();

    await expect(listReminders()).resolves.toHaveLength(1);
  });

  it("does not remove look-alikes created after the migration has already run", async () => {
    await removeLegacyStarterReminders();
    await createReminder(legacyStarterInputs[0]);

    await removeLegacyStarterReminders();

    await expect(listReminders()).resolves.toHaveLength(1);
  });
});
