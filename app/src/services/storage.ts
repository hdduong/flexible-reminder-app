import type { AppSettings, Reminder, ReminderEvent } from "../types";
import { Capacitor } from "@capacitor/core";
import { DEFAULT_SCHEMA_VERSION, createDefaultSettings } from "../types";
import { NativeTimeoutError, withNativeTimeout } from "./nativeTimeout";

export const STORAGE_KEYS = {
  settings: "settings:v1",
  reminders: "reminders:v1",
  events: "events:v1",
} as const;

interface PreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface PreferencesModule {
  Preferences?: PreferencesPlugin;
}

const memoryStore = new Map<string, string>();
let preferencesPromise: Promise<PreferencesPlugin | null> | null = null;

export async function listRemindersFromStorage(): Promise<Reminder[]> {
  return readJson<Reminder[]>(STORAGE_KEYS.reminders, []);
}

export async function saveReminders(reminders: Reminder[]): Promise<void> {
  await writeJson(STORAGE_KEYS.reminders, reminders);
}

export async function listEventsFromStorage(): Promise<ReminderEvent[]> {
  return readJson<ReminderEvent[]>(STORAGE_KEYS.events, []);
}

export async function saveEvents(events: ReminderEvent[]): Promise<void> {
  await writeJson(STORAGE_KEYS.events, events);
}

export async function appendReminderEvent(event: ReminderEvent): Promise<void> {
  const events = await listEventsFromStorage();
  events.push(event);
  await saveEvents(events);
}

export async function getSettings(): Promise<AppSettings> {
  const storedSettings = await readJson<Partial<AppSettings> | null>(
    STORAGE_KEYS.settings,
    null,
  );

  if (!storedSettings) {
    return createDefaultSettings();
  }

  return {
    ...createDefaultSettings(new Date(storedSettings.updatedAt ?? Date.now())),
    ...storedSettings,
    schemaVersion: DEFAULT_SCHEMA_VERSION,
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeJson(STORAGE_KEYS.settings, settings);
}

export async function updateSettings(
  input: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ...current,
    ...input,
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  await saveSettings(next);
  return next;
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  const rawValue = await readRawValue(key);

  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson<T>(key: string, value: T): Promise<void> {
  await writeRawValue(key, JSON.stringify(value));
}

export async function removeStoredValue(key: string): Promise<void> {
  const preferences = await getPreferencesPlugin();

  if (preferences) {
    try {
      await withNativeTimeout(
        preferences.remove({ key }),
        `Preferences.remove(${formatStorageKey(key)})`,
      );
      return;
    } catch (error) {
      disablePreferencesAfterPermanentFailure(error);
    }
  }

  if (hasLocalStorage()) {
    globalThis.localStorage.removeItem(key);
    return;
  }

  memoryStore.delete(key);
}

async function readRawValue(key: string): Promise<string | null> {
  const preferences = await getPreferencesPlugin();

  if (preferences) {
    try {
      return (
        await withNativeTimeout(
          preferences.get({ key }),
          `Preferences.get(${formatStorageKey(key)})`,
        )
      ).value;
    } catch (error) {
      disablePreferencesAfterPermanentFailure(error);
    }
  }

  if (hasLocalStorage()) {
    return globalThis.localStorage.getItem(key);
  }

  return memoryStore.get(key) ?? null;
}

async function writeRawValue(key: string, value: string): Promise<void> {
  const preferences = await getPreferencesPlugin();

  if (preferences) {
    try {
      await withNativeTimeout(
        preferences.set({ key, value }),
        `Preferences.set(${formatStorageKey(key)})`,
      );
      return;
    } catch (error) {
      disablePreferencesAfterPermanentFailure(error);
    }
  }

  if (hasLocalStorage()) {
    globalThis.localStorage.setItem(key, value);
    return;
  }

  memoryStore.set(key, value);
}

async function getPreferencesPlugin(): Promise<PreferencesPlugin | null> {
  if (!preferencesPromise) {
    preferencesPromise = loadPreferencesPlugin();
  }

  try {
    return await withNativeTimeout(
      preferencesPromise,
      "Preferences plugin load",
    );
  } catch (error) {
    disablePreferencesAfterPermanentFailure(error);
    return null;
  }
}

async function loadPreferencesPlugin(): Promise<PreferencesPlugin | null> {
  if (Capacitor.getPlatform() === "web") {
    return null;
  }

  try {
    const module = (await import("@capacitor/preferences")) as PreferencesModule;

    return module.Preferences ?? null;
  } catch {
    return null;
  }
}

function hasLocalStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function formatStorageKey(key: string): string {
  return JSON.stringify(key);
}

function disablePreferencesAfterPermanentFailure(error: unknown): void {
  if (!(error instanceof NativeTimeoutError)) {
    preferencesPromise = Promise.resolve(null);
  }
}
