import { expect, test } from "@playwright/test";

test("Settings shows insight state and wires run and clear controls", async ({
  page,
}) => {
  let runRequest;
  let clearRequest;
  await page.route(
    "**/api/v1/settings/insights/run",
    async (route) => {
      runRequest = route.request();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          queued: true,
          job_id: "job-manual",
          status: "queued",
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights",
    async (route) => {
      clearRequest = route.request();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cleared: true,
          findings_deleted: 10,
          feedback_preserved: true,
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const card = page.locator("[data-insight-admin]");
  await expect(
    card.getByRole("heading", { name: "Insight status" }),
  ).toBeVisible();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await expect(card.getByText("Last run", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Next scheduled run", { exact: true }),
  ).toBeVisible();

  const runInsights = card.getByRole("button", {
    name: "Run insights now",
  });
  await runInsights.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toContainText(
    "Insight run queued.",
  );
  expect(runRequest.method()).toBe("POST");
  expect(runRequest.headers()["x-csrf-token"]).toBeTruthy();

  await page.goto("/settings#insights");
  const clearOpen = page
    .locator("[data-insight-admin]")
    .getByRole("button", { name: "Clear all insights" });
  const clearDialog = page.locator("[data-insights-clear-dialog]");
  await clearOpen.focus();
  await page.keyboard.press("Enter");
  await expect(clearDialog).toBeVisible();
  await expect(clearDialog).toContainText(
    "Feedback, ignored patterns, and classification corrections remain",
  );
  await page.keyboard.press("Escape");
  await expect(clearDialog).toBeHidden();
  await expect(clearOpen).toBeFocused();

  await page.keyboard.press("Enter");
  await clearDialog
    .getByRole("button", { name: /^Clear \d+ insights?$/ })
    .click();
  await expect(
    clearDialog.locator("[data-insights-clear-dialog-status]"),
  ).toHaveText("Insights cleared.");
  expect(clearRequest.method()).toBe("DELETE");
  expect(clearRequest.headers()["x-csrf-token"]).toBeTruthy();
});

test("failed insight clearing stays visible and actionable in the dialog", async ({
  page,
}) => {
  let releaseRequest;
  await page.route(
    "**/api/v1/settings/insights",
    async (route) => {
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Insights are busy. Try again.",
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const clearOpen = page.getByRole("button", {
    name: "Clear all insights",
  });
  const dialog = page.locator("[data-insights-clear-dialog]");
  const status = dialog.locator(
    "[data-insights-clear-dialog-status]",
  );
  const clear = dialog.getByRole("button", {
    name: /^Clear \d+ insights?$/,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel" });

  await clearOpen.click();
  await clear.click();
  await expect(status).toHaveText("Clearing insights…");
  await expect(clear).toBeDisabled();
  await expect(cancel).toBeDisabled();

  await expect.poll(() => typeof releaseRequest).toBe("function");
  releaseRequest();
  await expect(status).toHaveText("Insights are busy. Try again.");
  await expect(dialog).toBeVisible();
  await expect(clear).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expect(clear).toBeFocused();

  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(clearOpen).toBeFocused();
});

test("Run insights exposes its in-flight state and ignores a second activation", async ({
  page,
}) => {
  let releaseRequest;
  let requestCount = 0;
  await page.route(
    "**/api/v1/settings/insights/run",
    async (route) => {
      requestCount += 1;
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          queued: true,
          job_id: "job-delayed",
          status: "queued",
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const card = page.locator("[data-insight-admin]");
  const run = card.getByRole("button", { name: "Run insights now" });
  await run.focus();
  await page.keyboard.press("Enter");

  await expect(run).toBeDisabled();
  await expect(card.getByRole("status")).toHaveText(
    "Queueing insight run…",
  );
  await run.evaluate((button) => button.click());
  expect(requestCount).toBe(1);

  await expect.poll(() => typeof releaseRequest).toBe("function");
  releaseRequest();
  await expect(card.getByRole("status")).toHaveText(
    "Insight run queued.",
  );
  expect(requestCount).toBe(1);
});
