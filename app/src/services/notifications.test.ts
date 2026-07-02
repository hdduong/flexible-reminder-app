import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Reminder, ReminderOccurrence } from "../types";
import { createDefaultSettings } from "../types";
import {
  getNotificationDiagnostics,
  isNativeNotificationPlatform,
  requestNotificationPermission,
  rescheduleAllNotifications,
  scheduleOccurrenceNotifications,
  sendTestNotification,
} from "./notifications";

const capacitorMocks = vi.hoisted(() => ({
  getPlatform: vi.fn(() => "ios"),
}));

const localNotificationMocks = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  registerActionTypes: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  getPending: vi.fn(),
  getDeliveredNotifications: vi.fn(),
  areEnabled: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  reminders: [] as Reminder[],
  getSettings: vi.fn(),
  listRemindersFromStorage: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: capacitorMocks,
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: localNotificationMocks,
}));

vi.mock("./storage", () => ({
  getSettings: storageMocks.getSettings,
  listRemindersFromStorage: storageMocks.listRemindersFromStorage,
  updateSettings: storageMocks.updateSettings,
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
    storageMocks.reminders = [];
    storageMocks.getSettings.mockResolvedValue(settings);
    storageMocks.listRemindersFromStorage.mockImplementation(
      async () => storageMocks.reminders,
    );
    storageMocks.updateSettings.mockImplementation(async (input) => ({
      ...settings,
      ...input,
    }));
    capacitorMocks.getPlatform.mockReturnValue("ios");
    localNotificationMocks.checkPermissions.mockResolvedValue({
      display: "granted",
    });
    localNotificationMocks.requestPermissions.mockResolvedValue({
      display: "granted",
    });
    localNotificationMocks.registerActionTypes.mockResolvedValue(undefined);
    localNotificationMocks.schedule.mockResolvedValue({ notifications: [] });
    localNotificationMocks.cancel.mockResolvedValue(undefined);
    localNotificationMocks.getPending.mockResolvedValue({ notifications: [] });
    localNotificationMocks.getDeliveredNotifications.mockResolvedValue({
      notifications: [],
    });
    localNotificationMocks.areEnabled.mockResolvedValue({ value: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats only the web platform as notification-incapable", () => {
    expect(isNativeNotificationPlatform()).toBe(true);

    capacitorMocks.getPlatform.mockReturnValue("web");
    expect(isNativeNotificationPlatform()).toBe(false);
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
          silent: false,
          sound: "default",
          title: "Reminder",
        }),
      ],
    });
  });

  it("waits for the iOS permission prompt without a native timeout", async () => {
    vi.useFakeTimers();
    const permissionDeferred = createDeferred<Record<string, string>>();
    localNotificationMocks.requestPermissions.mockReturnValueOnce(
      permissionDeferred.promise,
    );

    const permission = requestNotificationPermission();

    await vi.advanceTimersByTimeAsync(65_000);
    expect(storageMocks.updateSettings).not.toHaveBeenCalled();

    permissionDeferred.resolve({ display: "granted" });
    await expect(permission).resolves.toBe("granted");
    expect(storageMocks.updateSettings).toHaveBeenCalledWith({
      notificationPermissionStatus: "granted",
    });
  });

  it("reports pending and delivered app notification diagnostics", async () => {
    const nextAt = new Date(Date.now() + 60_000).toISOString();
    localNotificationMocks.getPending.mockResolvedValueOnce({
      notifications: [
        {
          id: 1,
          title: "Reminder",
          body: "Drink water",
          schedule: { at: nextAt },
          extra: { app: "flexible-reminder" },
        },
        {
          id: 2,
          title: "Other",
          body: "Ignore",
          schedule: { at: new Date(Date.now() + 30_000).toISOString() },
          extra: { app: "someone-else" },
        },
      ],
    });
    localNotificationMocks.getDeliveredNotifications.mockResolvedValueOnce({
      notifications: [
        {
          id: 3,
          title: "Reminder",
          body: "Already delivered",
          extra: { app: "flexible-reminder" },
        },
      ],
    });

    await expect(getNotificationDiagnostics()).resolves.toEqual({
      available: true,
      delivered: 1,
      enabled: true,
      nextAt,
      pending: 1,
    });
  });

  it("schedules a visible test notification for on-device verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T12:00:00.000Z"));

    await expect(sendTestNotification()).resolves.toBe("scheduled");

    expect(localNotificationMocks.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          body: "If you can see this, notifications are working.",
          silent: false,
          sound: "default",
          title: "Test reminder",
          extra: expect.objectContaining({
            app: "flexible-reminder",
            test: true,
          }),
          schedule: expect.objectContaining({
            at: new Date("2026-06-29T12:00:10.000Z"),
            allowWhileIdle: true,
          }),
        }),
      ],
    });
  });

  it("does not request permission from the test notification action", async () => {
    localNotificationMocks.checkPermissions.mockResolvedValueOnce({
      display: "denied",
    });

    await expect(sendTestNotification()).resolves.toBe("denied");

    expect(localNotificationMocks.requestPermissions).not.toHaveBeenCalled();
    expect(localNotificationMocks.schedule).not.toHaveBeenCalled();
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

  it("coalesces overlapping full notification rebuilds", async () => {
    const cancelDeferred = createDeferred<void>();
    const storedReminder: Reminder = {
      ...reminder,
      schedule: {
        ...reminder.schedule,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "00:00",
        endTime: "23:59",
        intervalMinutes: 60,
      },
    };

    localNotificationMocks.getPending.mockResolvedValue({
      notifications: [
        {
          id: 1,
          title: "Reminder",
          body: "Drink water",
          extra: { app: "flexible-reminder" },
        },
      ],
    });
    localNotificationMocks.cancel
      .mockReturnValueOnce(cancelDeferred.promise)
      .mockResolvedValue(undefined);

    storageMocks.reminders = [storedReminder];

    const first = rescheduleAllNotifications();
    const second = rescheduleAllNotifications();

    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(localNotificationMocks.cancel).toHaveBeenCalledTimes(1);
    });

    cancelDeferred.resolve();
    await first;

    expect(localNotificationMocks.schedule).toHaveBeenCalledTimes(1);
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}
