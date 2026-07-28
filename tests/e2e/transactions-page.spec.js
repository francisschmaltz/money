import { expect, test } from "@playwright/test";

test.use({ timezoneId: "America/Los_Angeles" });

test("transaction times use the browser timezone without fake precision", async ({
  page,
}) => {
  await page.goto("/transactions");

  const precise = page
    .locator('.transaction-row[href*="transaction=txn_whole_foods"] time')
    .first();
  await expect(precise).toHaveText("Jul 25, 2026, 1:34 PM");
  await expect(precise).toHaveAttribute(
    "datetime",
    "2026-07-25T20:34:00.000Z",
  );
  await expect(precise).not.toContainText(/GMT|:\d{2}:\d{2}/);

  const dateOnly = page
    .locator('.transaction-row[href*="transaction=txn_apple_services"] time')
    .first();
  await expect(dateOnly).toHaveText("Jul 24, 2026");
  await expect(dateOnly).toHaveAttribute("datetime", "2026-07-24");
  await expect(dateOnly).not.toHaveAttribute("data-local-date-time", /.+/);

  await page.goto("/transactions?transaction=txn_whole_foods");
  await expect(
    page.locator(".selected-detail time[data-local-date-time]"),
  ).toHaveText("Jul 25, 2026, 1:34 PM");

  await page.goto("/");
  await expect(
    page
      .locator('.transaction-row[href*="transaction=txn_whole_foods"] time')
      .first(),
  ).toHaveText("Jul 25, 2026, 1:34 PM");
});
