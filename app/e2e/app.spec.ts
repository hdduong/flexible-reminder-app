import { expect, test, type Locator } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("renders the Today screen and captures a mobile screenshot", async ({
  page,
}, testInfo) => {
  await expect(page.getByText("Flexible Reminder")).toBeVisible();
  await expect(page.locator(".up-next-card")).toBeVisible();
  await expect(page.locator(".tab-bar")).toContainText("Reminders");
  await expect(page.getByText("Loading reminders...")).toHaveCount(0);

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("today-mobile.png"),
  });

  await testInfo.attach("today-mobile", {
    body: screenshot,
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

  await page.getByPlaceholder("Try bathroom").fill("Stretch legs");
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

  await expect(savedList).not.toContainText("Walk dog");
  await expect(savedList).toContainText("No reminders yet");
});

test("shows privacy and snooze settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".settings-list")).toContainText("Default snooze");
  await expect(page.locator(".settings-list")).toContainText("10 minutes");
  await expect(page.locator(".settings-list")).toContainText("Privacy mode");
  await expect(page.locator(".settings-list")).toContainText("Export data");
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
