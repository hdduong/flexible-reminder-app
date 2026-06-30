import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  CreateReminderInput,
  Reminder,
  ReminderOccurrence,
  ReminderSchedule,
  Weekday,
} from "./types";
import { createDefaultSettings } from "./types";
import {
  createReminder,
  deleteReminder,
  listReminders,
  markDone,
  setReminderEnabled,
  skipOccurrence,
  snoozeOccurrence,
  updateReminder,
} from "./services/reminders";
import { getSettings, updateSettings } from "./services/storage";
import {
  listTodayOccurrences as listScheduledTodayOccurrences,
  previewSchedule as previewReminderSchedule,
} from "./services/schedule";
import {
  requestNotificationPermission,
  rescheduleAllNotifications,
} from "./services/notifications";

type RepeatMode = "interval" | "exact_times";
type Tab = "today" | "reminders" | "settings";

type DraftReminder = {
  id: string | null;
  text: string;
  privateNotificationText: string;
  enabled: boolean;
  daysOfWeek: Weekday[];
  startTime: string;
  endTime: string;
  repeatMode: RepeatMode;
  intervalMinutes: number;
  exactTimes: string[];
  snoozeMinutes: number;
};

type DisplayOccurrence = {
  id: string;
  reminderId: string;
  reminderText: string;
  time: string;
  summary: string;
  tag: string;
  raw: ReminderOccurrence;
};

const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const workweek: Weekday[] = [1, 2, 3, 4, 5];
const appVersion = import.meta.env.VITE_APP_VERSION;
const repeatHourOptions = Array.from({ length: 25 }, (_, hour) => hour);
const repeatMinuteOptions = Array.from({ length: 60 }, (_, minute) => minute);
const maxRepeatIntervalMinutes = 24 * 60;
const swipeRevealPixels = 96;
const swipeOpenThresholdPixels = 44;

const starterInputs: CreateReminderInput[] = [
  {
    text: "Try bathroom",
    privateNotificationText: "Quick break",
    schedule: {
      daysOfWeek: workweek,
      startTime: "09:00",
      endTime: "17:00",
      mode: "interval",
      intervalMinutes: 120,
      exactTimes: [],
      timezone: getDeviceTimezone(),
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
      timezone: getDeviceTimezone(),
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
      timezone: getDeviceTimezone(),
    },
    snoozeMinutesOverride: 10,
  },
];

const newReminderTemplate: DraftReminder = {
  id: null,
  text: "",
  privateNotificationText: "",
  enabled: true,
  daysOfWeek: workweek,
  startTime: "09:00",
  endTime: "17:00",
  repeatMode: "interval",
  intervalMinutes: 120,
  exactTimes: ["09:00", "12:00", "15:00"],
  snoozeMinutes: 10,
};

function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings());
  const [draft, setDraft] = useState<DraftReminder>(newReminderTemplate);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dismissedOccurrenceIds, setDismissedOccurrenceIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!successMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => setSuccessMessage(null), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [successMessage]);

  useEffect(() => {
    // Refresh the scheduled-notification queue whenever the app returns to the
    // foreground, so reminders keep firing past the bounded lookahead window.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void rescheduleAllNotifications();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  async function bootstrap() {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [storedSettings, storedReminders] = await Promise.all([getSettings(), listReminders()]);

      if (storedReminders.length === 0) {
        for (const input of starterInputs) {
          await createReminder(input);
        }
      }

      setSettings(storedSettings);
      setReminders(await listReminders());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to load reminders.");
    } finally {
      setIsLoading(false);
    }

    // Best-effort, after the UI is shown: ask for notification permission (the
    // OS prompt only appears the first time) and schedule the stored reminders.
    // Nothing here blocks loading, and failures are non-fatal.
    void enableNotifications();
  }

  async function enableNotifications() {
    try {
      await requestNotificationPermission();
      setSettings(await getSettings());
      await rescheduleAllNotifications();
    } catch {
      // Notifications are best-effort; the app still works without them.
    }
  }

  async function refreshReminders() {
    setReminders(await listReminders());
  }

  const todayOccurrences = useMemo(() => {
    return toDisplayOccurrences(listScheduledTodayOccurrences(reminders, new Date(), new Date()), reminders);
  }, [reminders]);

  const pendingOccurrences = todayOccurrences.filter((occurrence) => !dismissedOccurrenceIds.includes(occurrence.id));
  const upNext = pendingOccurrences[0] ?? todayOccurrences[0] ?? null;
  const preview = useMemo(() => {
    try {
      return toDisplayOccurrences(
        previewReminderSchedule(toSchedule(draft), { limit: 8, reminderId: draft.id ?? "preview" }),
        [fromDraft(draft)],
      );
    } catch {
      return [];
    }
  }, [draft]);

  function openNewReminder() {
    setEditingId(null);
    setDraft({ ...newReminderTemplate, snoozeMinutes: settings.defaultSnoozeMinutes });
    setSuccessMessage(null);
    setTab("reminders");
  }

  function editReminder(reminder: Reminder) {
    setEditingId(reminder.id);
    setDraft(toDraft(reminder, settings.defaultSnoozeMinutes));
    setSuccessMessage(null);
    setTab("reminders");
  }

  async function saveReminder() {
    setErrorMessage(null);
    setSuccessMessage(null);
    const wasEditing = Boolean(editingId);

    try {
      const input = toCreateInput(draft);
      if (editingId) {
        await updateReminder(editingId, input);
      } else {
        const saved = await createReminder(input);
        setEditingId(saved.id);
        setDraft(toDraft(saved, settings.defaultSnoozeMinutes));
      }
      await refreshReminders();
      setSuccessMessage(wasEditing ? "Changes saved." : "Reminder saved.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to save reminder.");
    }
  }

  async function toggleReminder(id: string, enabled: boolean) {
    await setReminderEnabled(id, enabled);
    await refreshReminders();
  }

  async function removeReminder(id: string) {
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await deleteReminder(id);

      if (editingId === id) {
        setEditingId(null);
        setDraft({
          ...newReminderTemplate,
          snoozeMinutes: settings.defaultSnoozeMinutes,
        });
      }

      await refreshReminders();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to remove reminder.",
      );
    }
  }

  async function handleOccurrenceAction(action: "done" | "later" | "skip", occurrence: DisplayOccurrence) {
    setDismissedOccurrenceIds((current) => [...new Set([...current, occurrence.id])]);

    if (action === "done") {
      await markDone(occurrence.id);
      return;
    }

    if (action === "skip") {
      await skipOccurrence(occurrence.id);
      return;
    }

    await snoozeOccurrence(occurrence.id, settings.defaultSnoozeMinutes);
  }

  async function saveSettings(next: AppSettings) {
    setSettings(next);
    setSettings(await updateSettings(next));
  }

  if (isLoading) {
    return (
      <main className="app-shell">
        <section className="phone loading-phone">
          <BuzzLogo />
          <strong>Loading reminders...</strong>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="phone">
        <StatusBar />
        <div className="phone-content">
          {tab === "today" && (
            <TodayScreen
              upNext={upNext}
              upcoming={pendingOccurrences.slice(1, 5)}
              onAdd={openNewReminder}
              onAction={handleOccurrenceAction}
              snoozeMinutes={settings.defaultSnoozeMinutes}
            />
          )}

          {tab === "reminders" && (
            <RemindersScreen
              reminders={reminders}
              draft={draft}
              preview={preview}
              editingId={editingId}
              errorMessage={errorMessage}
              successMessage={successMessage}
              onDraftChange={setDraft}
              onSave={saveReminder}
              onEdit={editReminder}
              onToggle={toggleReminder}
              onDelete={removeReminder}
              onNew={openNewReminder}
            />
          )}

          {tab === "settings" && (
            <SettingsScreen settings={settings} onChange={saveSettings} reminderCount={reminders.length} />
          )}
        </div>
        <TabBar active={tab} onChange={setTab} onAdd={openNewReminder} />
      </section>
    </main>
  );
}

function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span>9:41</span>
      <div className="status-icons">
        <span>5G</span>
        <span className="battery" />
      </div>
    </div>
  );
}

function BuzzLogo() {
  return (
    <svg className="buzz-logo" viewBox="0 0 64 64" role="img" aria-label="Buzz reminder logo">
      <path className="buzz-line" d="M12 18c-5 4-8 9-8 14s3 10 8 14M52 18c5 4 8 9 8 14s-3 10-8 14" />
      <path className="buzz-line" d="M19 24c-2.5 2.2-4 5-4 8s1.5 5.8 4 8M45 24c2.5 2.2 4 5 4 8s-1.5 5.8-4 8" />
      <circle className="buzz-core" cx="32" cy="32" r="12" />
      <circle className="buzz-dot" cx="32" cy="32" r="4.2" />
    </svg>
  );
}

function TodayScreen({
  upNext,
  upcoming,
  onAdd,
  onAction,
  snoozeMinutes,
}: {
  upNext: DisplayOccurrence | null;
  upcoming: DisplayOccurrence[];
  onAdd: () => void;
  onAction: (action: "done" | "later" | "skip", occurrence: DisplayOccurrence) => void;
  snoozeMinutes: number;
}) {
  return (
    <div className="screen today-screen">
      <header className="screen-header">
        <div>
          <div className="brand-row">
            <BuzzLogo />
            <span>Flexible Reminder</span>
          </div>
          <h1>Today</h1>
          <p>{formatLongDate(new Date())}</p>
        </div>
        <button className="icon-button" onClick={onAdd} aria-label="Add reminder">
          +
        </button>
      </header>

      <section className="up-next-card">
        <p className="eyebrow">Up next {upNext ? `· ${formatDisplayTime(upNext.time)}` : ""}</p>
        <h2>{upNext?.reminderText ?? "No reminders left"}</h2>
        <p>{upNext?.summary ?? "Add a free-text reminder to start your day."}</p>
        {upNext && (
          <div className="action-row">
            <button onClick={() => void onAction("done", upNext)}>Done</button>
            <button className="secondary-dark" onClick={() => void onAction("later", upNext)}>
              Later {snoozeMinutes}m
            </button>
            <button className="secondary-dark" onClick={() => void onAction("skip", upNext)}>
              Skip
            </button>
          </div>
        )}
      </section>

      <section>
        <div className="section-title">Upcoming</div>
        <div className="list">
          {upcoming.length ? (
            upcoming.map((item) => <OccurrenceRow key={item.id} occurrence={item} />)
          ) : (
            <div className="empty-state">All clear for the current schedule.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function RemindersScreen({
  reminders,
  draft,
  preview,
  editingId,
  errorMessage,
  successMessage,
  onDraftChange,
  onSave,
  onEdit,
  onToggle,
  onDelete,
  onNew,
}: {
  reminders: Reminder[];
  draft: DraftReminder;
  preview: DisplayOccurrence[];
  editingId: string | null;
  errorMessage: string | null;
  successMessage: string | null;
  onDraftChange: (next: DraftReminder) => void;
  onSave: () => void;
  onEdit: (reminder: Reminder) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="screen reminders-screen">
      <header className="screen-header compact">
        <div>
          <h1>{editingId ? "Edit Reminder" : "New Reminder"}</h1>
          <p>Free text, weekdays, exact active hours.</p>
        </div>
        <button className="icon-button" onClick={onNew} aria-label="New reminder">
          +
        </button>
      </header>

      <section className="editor-panel">
        <label>
          <span>Reminder text</span>
          <input value={draft.text} maxLength={120} placeholder="Try bathroom" onChange={(event) => onDraftChange({ ...draft, text: event.target.value })} />
        </label>

        <label>
          <span>Private notification text</span>
          <input
            value={draft.privateNotificationText}
            placeholder="Quick break (optional)"
            onChange={(event) => onDraftChange({ ...draft, privateNotificationText: event.target.value })}
          />
        </label>

        <div>
          <span className="field-label">Days</span>
          <div className="chip-row">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                className={draft.daysOfWeek.includes(day as Weekday) ? "chip selected" : "chip"}
                onClick={() => onDraftChange({ ...draft, daysOfWeek: toggleDay(draft.daysOfWeek, day as Weekday) })}
              >
                {dayLabels[day]}
              </button>
            ))}
          </div>
        </div>

        <div className="two-col">
          <label>
            <span>Start</span>
            <input type="time" value={draft.startTime} onChange={(event) => onDraftChange({ ...draft, startTime: event.target.value })} />
          </label>
          <label>
            <span>End</span>
            <input type="time" value={draft.endTime} onChange={(event) => onDraftChange({ ...draft, endTime: event.target.value })} />
          </label>
        </div>

        <div className="segmented">
          <button className={draft.repeatMode === "interval" ? "selected" : ""} onClick={() => onDraftChange({ ...draft, repeatMode: "interval" })}>
            Interval
          </button>
          <button className={draft.repeatMode === "exact_times" ? "selected" : ""} onClick={() => onDraftChange({ ...draft, repeatMode: "exact_times" })}>
            Exact Times
          </button>
        </div>

        {draft.repeatMode === "interval" ? (
          <RepeatIntervalFields draft={draft} onDraftChange={onDraftChange} />
        ) : (
          <label>
            <span>Exact times</span>
            <input
              value={draft.exactTimes.join(", ")}
              placeholder="09:00, 12:00, 15:00"
              onChange={(event) => onDraftChange({ ...draft, exactTimes: event.target.value.split(",").map((value) => value.trim()) })}
            />
          </label>
        )}

        <div>
          <span className="field-label">Preview</span>
          <div className="preview-row">
            {preview.map((occurrence) => (
              <span key={occurrence.id}>{formatDisplayTime(occurrence.time)}</span>
            ))}
          </div>
        </div>

        {successMessage && (
          <div className="success-message" role="status" aria-live="polite">
            {successMessage}
          </div>
        )}

        {errorMessage && (
          <div className="error-message" role="alert">
            {errorMessage}
          </div>
        )}

        <button className="primary-button" onClick={() => void onSave()}>
          {editingId ? "Save Changes" : "Save Reminder"}
        </button>
      </section>

      <section>
        <div className="section-title">Saved reminders</div>
        <div className="saved-list">
          {reminders.map((reminder) => (
            <SwipeableReminderRow
              key={reminder.id}
              reminder={reminder}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsScreen({
  settings,
  onChange,
  reminderCount,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  reminderCount: number;
}) {
  return (
    <div className="screen settings-screen">
      <header className="screen-header compact">
        <div>
          <h1>Settings</h1>
          <p>User-facing options only.</p>
        </div>
      </header>

      <section className="permission-card">
        <BuzzLogo />
        <div>
          <strong>Notifications {settings.notificationPermissionStatus === "granted" ? "allowed" : "not requested"}</strong>
          <span>Local iPhone reminders work offline.</span>
        </div>
      </section>

      <div className="settings-list">
        <SettingsRow label="Default snooze" value={`${settings.defaultSnoozeMinutes} minutes`}>
          <select
            value={settings.defaultSnoozeMinutes}
            onChange={(event) => onChange({ ...settings, defaultSnoozeMinutes: Number(event.target.value) })}
          >
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Privacy mode" value={settings.privacyMode ? "On" : "Off"}>
          <label className="switch">
            <input type="checkbox" checked={settings.privacyMode} onChange={(event) => onChange({ ...settings, privacyMode: event.target.checked })} />
            <span />
          </label>
        </SettingsRow>

        <SettingsRow label="Week starts on" value={settings.weekStartsOn === "monday" ? "Monday" : "Sunday"}>
          <select value={settings.weekStartsOn} onChange={(event) => onChange({ ...settings, weekStartsOn: event.target.value as AppSettings["weekStartsOn"] })}>
            <option value="monday">Monday</option>
            <option value="sunday">Sunday</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Export data" value={`${reminderCount} reminders`} />
        <SettingsRow label="About" value={`Flexible Reminder ${appVersion}`} />
      </div>
    </div>
  );
}

function SettingsRow({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div>
        <strong>{label}</strong>
        <span>{value}</span>
      </div>
      {children}
    </div>
  );
}

function SwipeableReminderRow({
  reminder,
  onEdit,
  onToggle,
  onDelete,
}: {
  reminder: Reminder;
  onEdit: (reminder: Reminder) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const dragStartX = useRef<number | null>(null);
  const dragStartOffset = useRef(0);
  const didSwipe = useRef(false);
  const [isRemoveOpen, setIsRemoveOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const currentOffset =
    dragStartX.current === null
      ? isRemoveOpen
        ? -swipeRevealPixels
        : 0
      : dragOffset;

  function closeRemoveAction() {
    setIsRemoveOpen(false);
    setDragOffset(0);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;

    if (target.closest(".switch")) {
      return;
    }

    dragStartX.current = event.clientX;
    dragStartOffset.current = isRemoveOpen ? -swipeRevealPixels : 0;
    setDragOffset(dragStartOffset.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartX.current === null) {
      return;
    }

    const delta = event.clientX - dragStartX.current;
    const nextOffset = Math.max(
      -swipeRevealPixels,
      Math.min(0, dragStartOffset.current + delta),
    );

    setDragOffset(nextOffset);
  }

  function finishSwipe() {
    if (dragStartX.current === null) {
      return;
    }

    didSwipe.current =
      Math.abs(dragOffset - dragStartOffset.current) > 8;
    const shouldOpen = dragOffset <= -swipeOpenThresholdPixels;
    dragStartX.current = null;
    setIsRemoveOpen(shouldOpen);
    setDragOffset(shouldOpen ? -swipeRevealPixels : 0);
  }

  function handleEdit() {
    if (didSwipe.current) {
      didSwipe.current = false;
      return;
    }

    if (isRemoveOpen) {
      closeRemoveAction();
      return;
    }

    onEdit(reminder);
  }

  return (
    <div className={isRemoveOpen ? "swipe-row remove-open" : "swipe-row"}>
      <button
        className="remove-reminder-button"
        onClick={() => onDelete(reminder.id)}
        aria-label={`Remove ${reminder.text}`}
        aria-hidden={!isRemoveOpen}
        tabIndex={isRemoveOpen ? 0 : -1}
      >
        Remove
      </button>
      <div
        className="saved-row"
        style={{
          transform: `translateX(${currentOffset}px)`,
          transition: dragStartX.current !== null ? "none" : undefined,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={finishSwipe}
      >
        <button className="saved-row-main" onClick={handleEdit}>
          <div>
            <strong>{reminder.text}</strong>
            <span>{summarizeReminder(reminder)}</span>
          </div>
        </button>
        <label className="switch">
          <input
            type="checkbox"
            checked={reminder.enabled}
            onChange={(event) => void onToggle(reminder.id, event.target.checked)}
            aria-label={`${reminder.text} enabled`}
          />
          <span />
        </label>
      </div>
    </div>
  );
}

function RepeatIntervalFields({
  draft,
  onDraftChange,
}: {
  draft: DraftReminder;
  onDraftChange: (next: DraftReminder) => void;
}) {
  const repeatInterval = getRepeatIntervalParts(draft.intervalMinutes);
  const minuteOptions = getRepeatMinuteOptions(repeatInterval.hours);

  return (
    <div className="repeat-field">
      <span className="field-label">Repeat every</span>
      <div className="repeat-grid">
        <label>
          <span>Hours</span>
          <select
            aria-label="Repeat hours"
            value={repeatInterval.hours}
            onChange={(event) =>
              onDraftChange(
                updateDraftRepeatInterval(
                  draft,
                  "hours",
                  Number(event.target.value),
                ),
              )
            }
          >
            {repeatHourOptions.map((hour) => (
              <option key={hour} value={hour}>
                {hour} {hour === 1 ? "hour" : "hours"}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Minutes</span>
          <select
            aria-label="Repeat minutes"
            value={repeatInterval.minutes}
            onChange={(event) =>
              onDraftChange(
                updateDraftRepeatInterval(
                  draft,
                  "minutes",
                  Number(event.target.value),
                ),
              )
            }
          >
            {minuteOptions.map((minute) => (
              <option key={minute} value={minute}>
                {minute} {minute === 1 ? "minute" : "minutes"}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function OccurrenceRow({ occurrence }: { occurrence: DisplayOccurrence }) {
  return (
    <div className="occurrence-row">
      <strong>{formatDisplayTime(occurrence.time)}</strong>
      <div>
        <span>{occurrence.reminderText}</span>
        <small>{occurrence.summary}</small>
      </div>
      <em>{occurrence.tag}</em>
    </div>
  );
}

function TabBar({ active, onChange, onAdd }: { active: Tab; onChange: (tab: Tab) => void; onAdd: () => void }) {
  return (
    <nav className="tab-bar" aria-label="Primary">
      <button className={active === "today" ? "active" : ""} onClick={() => onChange("today")}>
        Today
      </button>
      <button className={active === "reminders" ? "active" : ""} onClick={() => onChange("reminders")}>
        Reminders
      </button>
      <button className="add-tab" onClick={onAdd} aria-label="Add reminder">
        +
      </button>
      <button className={active === "settings" ? "active" : ""} onClick={() => onChange("settings")}>
        Settings
      </button>
    </nav>
  );
}

function toDisplayOccurrences(occurrences: ReminderOccurrence[], reminders: Reminder[]): DisplayOccurrence[] {
  return occurrences.map((occurrence) => {
    const reminder = reminders.find((item) => item.id === occurrence.reminderId);
    const time = toLocalTime(new Date(occurrence.scheduledFor));
    return {
      id: occurrence.id,
      reminderId: occurrence.reminderId,
      reminderText: reminder?.text ?? "Reminder",
      time,
      summary: reminder ? summarizeReminder(reminder) : "",
      tag: reminder?.schedule.mode === "exact_times" ? "exact" : reminder?.schedule.daysOfWeek.length === 7 ? "daily" : "work",
      raw: occurrence,
    };
  });
}

function toSchedule(draft: DraftReminder): ReminderSchedule {
  return {
    daysOfWeek: draft.daysOfWeek,
    startTime: draft.startTime,
    endTime: draft.endTime,
    mode: draft.repeatMode,
    intervalMinutes:
      draft.repeatMode === "interval"
        ? clampRepeatIntervalMinutes(draft.intervalMinutes)
        : null,
    exactTimes: draft.repeatMode === "exact_times" ? draft.exactTimes.filter(Boolean) : [],
    timezone: getDeviceTimezone(),
  };
}

function toCreateInput(draft: DraftReminder): CreateReminderInput {
  return {
    text: draft.text,
    privateNotificationText: draft.privateNotificationText || null,
    enabled: draft.enabled,
    schedule: toSchedule(draft),
    snoozeMinutesOverride: draft.snoozeMinutes,
  };
}

function toDraft(reminder: Reminder, defaultSnoozeMinutes: number): DraftReminder {
  return {
    id: reminder.id,
    text: reminder.text,
    privateNotificationText: reminder.privateNotificationText ?? "",
    enabled: reminder.enabled,
    daysOfWeek: reminder.schedule.daysOfWeek,
    startTime: reminder.schedule.startTime,
    endTime: reminder.schedule.endTime,
    repeatMode: reminder.schedule.mode,
    intervalMinutes: clampRepeatIntervalMinutes(
      reminder.schedule.intervalMinutes ?? 120,
    ),
    exactTimes: reminder.schedule.exactTimes.length ? reminder.schedule.exactTimes : ["09:00"],
    snoozeMinutes: reminder.snoozeMinutesOverride ?? defaultSnoozeMinutes,
  };
}

function fromDraft(draft: DraftReminder): Reminder {
  const now = new Date().toISOString();
  return {
    id: draft.id ?? "preview",
    text: draft.text || "Untitled reminder",
    privateNotificationText: draft.privateNotificationText || null,
    enabled: draft.enabled,
    schedule: toSchedule(draft),
    snoozeMinutesOverride: draft.snoozeMinutes,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function summarizeReminder(reminder: Reminder) {
  const daySummary = reminder.schedule.daysOfWeek.length === 7 ? "Every day" : reminder.schedule.daysOfWeek.map((day) => dayLabels[day]).join(" ");
  const repeat = reminder.schedule.mode === "exact_times" ? "exact time" : `every ${formatInterval(reminder.schedule.intervalMinutes ?? 0)}`;
  return `${daySummary} · ${formatDisplayTime(reminder.schedule.startTime)}-${formatDisplayTime(reminder.schedule.endTime)} · ${repeat}`;
}

function formatInterval(minutes: number) {
  const normalized = clampRepeatIntervalMinutes(minutes);
  const hours = Math.floor(normalized / 60);
  const remainingMinutes = normalized % 60;

  if (hours === 0) return `${remainingMinutes} min`;

  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  if (remainingMinutes === 0) return hourText;

  return `${hourText} ${remainingMinutes} min`;
}

function getRepeatIntervalParts(intervalMinutes: number) {
  const normalized = clampRepeatIntervalMinutes(intervalMinutes);
  return {
    hours: Math.floor(normalized / 60),
    minutes: normalized % 60,
  };
}

function getRepeatMinuteOptions(hours: number) {
  if (hours === 24) {
    return [0];
  }

  if (hours === 0) {
    return repeatMinuteOptions.slice(1);
  }

  return repeatMinuteOptions;
}

function updateDraftRepeatInterval(
  draft: DraftReminder,
  unit: "hours" | "minutes",
  value: number,
): DraftReminder {
  const current = getRepeatIntervalParts(draft.intervalMinutes);
  const next = {
    ...current,
    [unit]: value,
  };

  return {
    ...draft,
    intervalMinutes: clampRepeatIntervalMinutes(
      next.hours * 60 + next.minutes,
    ),
  };
}

function clampRepeatIntervalMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) {
    return 1;
  }

  return Math.min(
    maxRepeatIntervalMinutes,
    Math.max(1, Math.trunc(minutes)),
  );
}

function formatDisplayTime(time: string) {
  const [hourString, minuteString] = time.split(":");
  const hour = Number(hourString);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minuteString} ${suffix}`;
}

function toggleDay(days: Weekday[], day: Weekday) {
  const next = days.includes(day) ? days.filter((item) => item !== day) : [...days, day];
  return (next.length ? next.sort((a, b) => a - b) : days) as Weekday[];
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

function toLocalTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getDeviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

export default App;
