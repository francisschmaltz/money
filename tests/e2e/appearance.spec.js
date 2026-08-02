import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const wcag22Tags = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

const primarySignedInRoutes = [
  "/",
  "/plan",
  "/insights",
  "/transactions?period=90",
  "/recurring",
  "/portfolio",
  "/credit",
  "/accounts",
  "/search",
  "/settings#insights",
  "/format-rules",
  "/format-rules/categories",
];

async function saveAppearance(page, appearance) {
  const result = await page.evaluate(async (nextAppearance) => {
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    const response = await fetch("/api/v1/me/appearance", {
      method: "PUT",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ appearance: nextAppearance }),
    });
    return {
      body: await response.json().catch(() => null),
      status: response.status,
    };
  }, appearance);
  expect(result).toEqual({
    body: { updated: true, appearance },
    status: 200,
  });
}

async function openAppearancePicker(page) {
  const accountMenu = page.locator(".account-menu");
  if (!(await accountMenu.evaluate((menu) => menu.open))) {
    await accountMenu.locator(":scope > summary").click();
  }
  await expect(accountMenu.locator("[data-appearance-picker]")).toBeVisible();
  return accountMenu;
}

async function chooseAppearance(page, label) {
  const accountMenu = await openAppearancePicker(page);
  const option = accountMenu.getByRole("radio", { name: label });
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/v1/me/appearance") &&
      candidate.request().method() === "PUT",
  );
  await accountMenu.getByText(label, { exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(option).toBeChecked();
  await expect(option).toBeEnabled();
}

async function settleVisuals(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await saveAppearance(page, "system");
  await page.reload();
});

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  try {
    await saveAppearance(page, "system");
  } catch {
    // A route-interception test may intentionally leave the write unavailable.
  }
});

test("System follows live OS appearance changes", async ({ page }) => {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-appearance", "system");
  await expect(root).toHaveAttribute("data-resolved-theme", "light");

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(root).toHaveAttribute("data-resolved-theme", "dark");
  expect(
    await root.evaluate((element) => getComputedStyle(element).colorScheme),
  ).toBe("dark");

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(root).toHaveAttribute("data-resolved-theme", "light");
});

test("manual appearance overrides the OS and syncs to another browser", async ({
  browser,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await chooseAppearance(page, "Light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "light",
  );

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await chooseAppearance(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");

  const otherContext = await browser.newContext({
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/");
  await expect(otherPage.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  await saveAppearance(otherPage, "light");
  await page.evaluate(() => window.moneyAppearance.refresh());
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "light",
  );
  await otherContext.close();
});

test("a failed save restores the prior theme and exposes the error", async ({
  page,
}) => {
  await page.route("**/api/v1/me/appearance", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "preference_unavailable",
        message: "Appearance preference is unavailable.",
      }),
    });
  });

  const accountMenu = await openAppearancePicker(page);
  await accountMenu.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "light",
  );
  await expect(
    accountMenu.getByRole("radio", { name: "System" }),
  ).toBeChecked();
  await expect(accountMenu.locator("[data-appearance-status]")).not.toBeEmpty();
});

test("appearance controls remain accessible and fit at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const accountMenu = await openAppearancePicker(page);
  const system = accountMenu.getByRole("radio", { name: "System" });
  await system.focus();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/v1/me/appearance") &&
      candidate.request().method() === "PUT",
  );
  await page.keyboard.press("ArrowRight");
  expect((await response).ok()).toBe(true);
  await expect(accountMenu.getByRole("radio", { name: "Light" })).toBeChecked();

  const geometry = await accountMenu
    .locator(".account-menu__panel")
    .evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        viewport: document.documentElement.clientWidth,
      };
    });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
});

test("charts update their chrome without being recreated", async ({ page }) => {
  const canvas = page.locator('canvas[data-chart="line"]').first();
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  const before = await canvas.evaluate((element) => {
    window.__appearanceChart = element.moneyChart;
    return {
      grid: element.moneyChart.options.scales.y.grid.color,
      tick: element.moneyChart.options.scales.y.ticks.color,
    };
  });

  await chooseAppearance(page, "Dark");
  const after = await canvas.evaluate((element) => ({
    sameChart: window.__appearanceChart === element.moneyChart,
    grid: element.moneyChart.options.scales.y.grid.color,
    tick: element.moneyChart.options.scales.y.ticks.color,
  }));
  expect(after.sameChart).toBe(true);
  expect(after.grid).not.toBe(before.grid);
  expect(after.tick).not.toBe(before.tick);
});

test("representative dark surfaces match visual baselines", async ({ page }) => {
  await chooseAppearance(page, "Dark");
  await settleVisuals(page);

  await page.setViewportSize({ width: 390, height: 844 });
  const accountMenu = await openAppearancePicker(page);
  await expect(accountMenu.locator(".account-menu__panel")).toHaveScreenshot(
    "appearance-menu-dark-mobile.png",
  );
  await accountMenu.locator(":scope > summary").click();
  await expect(page.locator(".summary-card--hero")).toHaveScreenshot(
    "appearance-dashboard-dark-mobile.png",
  );

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/settings#insights");
  await settleVisuals(page);
  await expect(page.locator("[data-insight-admin]")).toHaveScreenshot(
    "appearance-settings-dark-desktop.png",
  );
});

test("primary routes have no automated dark-mode accessibility violations", async ({
  page,
}) => {
  await chooseAppearance(page, "Dark");
  for (const path of primarySignedInRoutes) {
    const response = await page.goto(path);
    expect(response?.ok(), `${path} should render successfully`).toBe(true);
    await expect(page.locator("html")).toHaveAttribute(
      "data-resolved-theme",
      "dark",
    );
    const results = await new AxeBuilder({ page })
      .withTags(wcag22Tags)
      .analyze();
    expect(
      results.violations,
      `${path}: ${results.violations
        .map((violation) => violation.id)
        .join(", ")}`,
    ).toEqual([]);
  }
});
