import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("@capacitor/core");
  vi.doUnmock("@capacitor/preferences");
});

describe("storage", () => {
  it("keeps Preferences available after a read timeout", async () => {
    const nativeReminders = [{ id: "native-reminder" }];
    const preferences = {
      get: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ value: JSON.stringify(nativeReminders) }),
      remove: vi.fn(),
      set: vi.fn(),
    };

    const { readJson, STORAGE_KEYS } = await loadNativeStorage(preferences);
    const timedOutRead = readJson<Array<{ id: string }>>(
      STORAGE_KEYS.reminders,
      [],
    );

    await expect(timedOutRead).resolves.toEqual([]);
    await expect(
      readJson<Array<{ id: string }>>(STORAGE_KEYS.reminders, []),
    ).resolves.toEqual(nativeReminders);
    expect(preferences.get).toHaveBeenCalledTimes(2);
  });
});

function loadNativeStorage(preferences: {
  get: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  vi.doMock("@capacitor/core", () => ({
    Capacitor: {
      getPlatform: () => "ios",
    },
  }));
  vi.doMock("@capacitor/preferences", () => ({
    Preferences: preferences,
  }));

  return import("./storage");
}
