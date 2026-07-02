import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("renders the Today screen and captures light/dark mobile screenshots", async ({
  page,
}, testInfo) => {
  await expect(page.getByText("Flexible Reminder")).toBeVisible();
  await expect(page.locator(".up-next-card")).toBeVisible();
  await expect(page.locator(".tab-bar")).toContainText("Reminders");
  await expect(page.getByText("Loading reminders...")).toHaveCount(0);

  await page.emulateMedia({ colorScheme: "light" });
  const lightScreenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("today-light-mobile.png"),
  });

  await testInfo.attach("today-light-mobile", {
    body: lightScreenshot,
    contentType: "image/png",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  const darkScreenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("today-dark-mobile.png"),
  });

  await testInfo.attach("today-dark-mobile", {
    body: darkScreenshot,
    contentType: "image/png",
  });
});

test("supports free-text reminder creation", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Reminders" }).click();

  await expect(page.getByRole("heading", { name: "New Reminder" })).toBeVisible();
  await expect(page.getByPlaceholder("Try bathroom")).toBeVisible();
  await expect(page.locator(".saved-list")).toContainText("No reminders yet");
  await expect(page.getByLabel("Repeat hours")).toHaveValue("2");
  await expect(page.getByLabel("Repeat minutes")).toHaveValue("0");

  await page.getByLabel("Repeat hours").selectOption("1");
  await page.getByLabel("Repeat minutes").selectOption("45");

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("repeat-dropdowns-mobile.png"),
  });

  await testInfo.attach("repeat-dropdowns-mobile", {
    body: screenshot,
    contentType: "image/png",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  const darkFormScreenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("repeat-dropdowns-dark-mobile.png"),
  });

  await testInfo.attach("repeat-dropdowns-dark-mobile", {
    body: darkFormScreenshot,
    contentType: "image/png",
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Save Reminder" }).click();
  await expect(page.getByRole("alert")).toHaveText("Reminder text is required.");
  await expect(page.getByPlaceholder("Try bathroom")).toHaveAttribute("aria-invalid", "true");

  const validationScreenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("required-text-toast-mobile.png"),
  });

  await testInfo.attach("required-text-toast-mobile", {
    body: validationScreenshot,
    contentType: "image/png",
  });

  await page.getByPlaceholder("Try bathroom").fill("Stretch legs");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Save Reminder" }).click();

  await expect(page.getByRole("status")).toHaveText("Reminder saved.");
  await expect(page.locator(".saved-list")).toContainText("Stretch legs");
  await expect(page.locator(".saved-list")).toContainText("every 1 hour 45 min");

  const saveScreenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("save-confirmation-mobile.png"),
  });

  await testInfo.attach("save-confirmation-mobile", {
    body: saveScreenshot,
    contentType: "image/png",
  });

  await page.locator(".saved-row-main", { hasText: "Stretch legs" }).click();
  await expect(page.getByRole("heading", { name: "Edit Reminder" })).toBeVisible();
  await expect(page.getByLabel("Repeat hours")).toHaveValue("1");
  await expect(page.getByLabel("Repeat minutes")).toHaveValue("45");

  await page.getByLabel("Repeat hours").selectOption("0");
  await page.getByLabel("Repeat minutes").selectOption("20");
  await page.getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByRole("status")).toHaveText("Changes saved.");
  await expect(page.locator(".saved-list")).toContainText("every 20 min");
});

test("today action buttons visibly clear the current reminder", async ({
  page,
}, testInfo) => {
  const exactTime = await getFutureTodayTime(page);

  await page.getByRole("button", { name: "Reminders" }).click();
  await page.getByPlaceholder("Try bathroom").fill("Take medicine");
  await page.getByLabel("Start").fill("00:00");
  await page.getByLabel("End").fill("23:59");
  await page.getByRole("button", { name: "Sun" }).click();
  await page.getByRole("button", { name: "Sat" }).click();
  await page.getByRole("button", { name: "Exact Times" }).click();
  await page.getByLabel("Exact times").fill(exactTime);
  await page.getByRole("button", { name: "Save Reminder" }).click();
  await expect(page.getByRole("status")).toHaveText("Reminder saved.");

  await page.getByRole("button", { name: "Today", exact: true }).click();

  const upNextCard = page.locator(".up-next-card");
  await expect(upNextCard).toContainText("Take medicine");

  await upNextCard.getByRole("button", { name: "Done" }).click();

  await expect(page.getByRole("status")).toHaveText("Marked done.");
  await expect(upNextCard).toContainText("No reminders left");
  await expect(upNextCard).not.toContainText("Take medicine");

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("today-action-done-mobile.png"),
  });

  await testInfo.attach("today-action-done-mobile", {
    body: screenshot,
    contentType: "image/png",
  });
});

test("removes saved reminders with a swipe action", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Reminders" }).click();

  await page.getByPlaceholder("Try bathroom").fill("Walk dog");
  await page.getByRole("button", { name: "Save Reminder" }).click();
  await expect(page.getByRole("status")).toHaveText("Reminder saved.");

  const savedList = page.locator(".saved-list");
  const savedRow = savedList.locator(".swipe-row", {
    hasText: "Walk dog",
  });
  await expect(savedRow).toBeVisible();

  await swipeLeft(savedRow);

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("swipe-remove-mobile.png"),
  });

  await testInfo.attach("swipe-remove-mobile", {
    body: screenshot,
    contentType: "image/png",
  });

  await page.getByRole("button", { name: "Remove Walk dog" }).click();

  await expect(page.getByRole("status")).toHaveText("Reminder removed.");
  await expect(savedList).not.toContainText("Walk dog");
  await expect(savedList).toContainText("No reminders yet");
});

test("shows privacy and snooze settings", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(/Notifications/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send Test" })).toBeVisible();
  await expect(page.locator(".settings-list")).toContainText("Default snooze");
  await expect(page.locator(".settings-list")).toContainText("10 minutes");
  await expect(page.locator(".settings-list")).toContainText("Privacy mode");
  await expect(page.locator(".settings-list")).toContainText("Export data");

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("settings-notification-diagnostics-mobile.png"),
  });

  await testInfo.attach("settings-notification-diagnostics-mobile", {
    body: screenshot,
    contentType: "image/png",
  });
});

async function swipeLeft(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();

  if (!box) {
    throw new Error("Unable to find row bounds for swipe.");
  }

  const startX = box.x + box.width * 0.68;
  const endX = startX - 132;
  const y = box.y + box.height / 2;
  const page = locator.page();

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 8 });
  await page.mouse.up();
}

async function getFutureTodayTime(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date();
    const candidate = new Date(now.getTime() + 5 * 60_000);
    const sameDay =
      candidate.getFullYear() === now.getFullYear() &&
      candidate.getMonth() === now.getMonth() &&
      candidate.getDate() === now.getDate();
    const futureToday = sameDay
      ? candidate
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);

    return `${String(futureToday.getHours()).padStart(2, "0")}:${String(
      futureToday.getMinutes(),
    ).padStart(2, "0")}`;
  });
}
