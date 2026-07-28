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

test("bulk selection checkboxes share one centerline", async ({ page }) => {
  for (const viewport of [
    { width: 1024, height: 900 },
    { width: 480, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/transactions");
    await page.getByRole("button", { name: "Select & edit" }).click();

    const alignment = await page.evaluate(() => {
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
      };
      const selectAll = document.querySelector("[data-bulk-select-all]");
      const selectAllCenter = center(selectAll);

      return [
        ...document.querySelectorAll("[data-bulk-transaction-select]"),
      ].map((input) => {
        const inputCenter = center(input);
        const controlCenter = center(
          input.closest(".transaction-select-control"),
        );
        return {
          horizontalDelta: Math.abs(inputCenter.x - selectAllCenter.x),
          verticalDelta: Math.abs(inputCenter.y - controlCenter.y),
        };
      });
    });

    expect(alignment.length).toBeGreaterThan(0);
    for (const { horizontalDelta, verticalDelta } of alignment) {
      expect(horizontalDelta).toBeLessThanOrEqual(0.5);
      expect(verticalDelta).toBeLessThanOrEqual(0.5);
    }
  }
});

test("one transaction can change category without creating a rule", async ({
  page,
}) => {
  let write;
  await page.route(
    "**/api/v1/transactions/batch-edit",
    async (route) => {
      write = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated_count: 1 }),
      });
    },
  );
  await page.goto("/transactions?transaction=txn_whole_foods");

  const section = page.locator(".transaction-category-override");
  const form = section.locator("[data-transaction-category-form]");
  await expect(form).toBeVisible();
  await expect(
    section.getByText("No automatic cleanup rule is created"),
  ).toBeVisible();
  await form
    .getByLabel("Spending category")
    .selectOption({ label: "Dining" });
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          "/api/v1/transactions/batch-edit",
    ),
    form
      .getByRole("button", { name: "Save for this transaction" })
      .click(),
  ]);

  expect(write).toEqual({
    transaction_ids: ["txn_whole_foods"],
    changes: { category_primary: "Dining" },
  });
});
