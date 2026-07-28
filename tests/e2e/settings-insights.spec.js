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

  await card
    .getByRole("button", { name: "Run insights now" })
    .click();
  await expect(card.getByRole("status")).toContainText(
    "Insight run queued.",
  );
  expect(runRequest.method()).toBe("POST");
  expect(runRequest.headers()["x-csrf-token"]).toBeTruthy();

  await page.goto("/settings#insights");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("[data-insight-admin]")
    .getByRole("button", { name: "Clear all insights" })
    .click();
  await expect(
    page.locator("[data-insight-admin]").getByRole("status"),
  ).toContainText("Insights cleared.");
  expect(clearRequest.method()).toBe("DELETE");
  expect(clearRequest.headers()["x-csrf-token"]).toBeTruthy();
});
