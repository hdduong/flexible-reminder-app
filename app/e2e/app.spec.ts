import { expect, test } from "@playwright/test";

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

test("supports free-text reminder creation", async ({ page }) => {
  await page.getByRole("button", { name: "Reminders" }).click();

  await expect(page.getByRole("heading", { name: "New Reminder" })).toBeVisible();
  await expect(page.getByPlaceholder("Try bathroom")).toBeVisible();
  await expect(page.getByText("Try bathroom")).toBeVisible();
  await expect(page.getByText("Drink water")).toBeVisible();
  await expect(page.getByText("Study English")).toBeVisible();

  await page.getByPlaceholder("Try bathroom").fill("Stretch legs");
  await page.getByRole("button", { name: "Save Reminder" }).click();

  await expect(page.locator(".saved-list")).toContainText("Stretch legs");
});

test("shows privacy and snooze settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".settings-list")).toContainText("Default snooze");
  await expect(page.locator(".settings-list")).toContainText("10 minutes");
  await expect(page.locator(".settings-list")).toContainText("Privacy mode");
  await expect(page.locator(".settings-list")).toContainText("Export data");
});
