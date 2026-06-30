import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Reminder, ReminderOccurrence } from "../types";
import { createDefaultSettings } from "../types";
import { scheduleOccurrenceNotifications } from "./notifications";

const capacitorMocks = vi.hoisted(() => ({
  getPlatform: vi.fn(() => "ios"),
}));

const localNotificationMocks = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  registerActionTypes: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  getPending: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: capacitorMocks,
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: localNotificationMocks,
}));

const reminder: Reminder = {
  id: "reminder-1",
  text: "Drink water",
  privateNotificationText: null,
  enabled: true,
  schedule: {
    daysOfWeek: [1],
    startTime: "09:00",
    endTime: "17:00",
    mode: "interval",
    intervalMinutes: 120,
    exactTimes: [],
    timezone: "America/Los_Angeles",
  },
  snoozeMinutesOverride: null,
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:00.000Z",
  deletedAt: null,
};

const settings: AppSettings = createDefaultSettings(
  new Date("2026-06-29T00:00:00.000Z"),
);

describe("notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorMocks.getPlatform.mockReturnValue("ios");
    localNotificationMocks.checkPermissions.mockResolvedValue({
      display: "granted",
    });
    localNotificationMocks.registerActionTypes.mockResolvedValue(undefined);
    localNotificationMocks.schedule.mockResolvedValue({ notifications: [] });
  });

  it("adds default sound to scheduled local notifications on iOS", async () => {
    const scheduledFor = new Date(Date.now() + 60_000);

    await scheduleOccurrenceNotifications(
      reminder,
      [createOccurrence(scheduledFor)],
      settings,
    );

    expect(localNotificationMocks.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          body: "Drink water",
          sound: "default",
          title: "Reminder",
        }),
      ],
    });
  });

  it("skips past and too-close occurrences before calling native scheduling", async () => {
    const now = Date.now();
    const past = createOccurrence(new Date(now - 1_000));
    const tooClose = createOccurrence(new Date(now + 1_000));
    const future = createOccurrence(new Date(now + 60_000));

    await scheduleOccurrenceNotifications(
      reminder,
      [past, tooClose, future],
      settings,
    );

    const [{ notifications }] = localNotificationMocks.schedule.mock.calls[0];
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        extra: expect.objectContaining({
          occurrenceId: future.id,
          scheduledFor: future.scheduledFor,
        }),
      }),
    );
  });
});

function createOccurrence(scheduledFor: Date): ReminderOccurrence {
  return {
    id: `occ:schedule:${reminder.id}:${scheduledFor.getTime()}`,
    reminderId: reminder.id,
    scheduledFor: scheduledFor.toISOString(),
    status: "pending",
    source: "schedule",
  };
}
