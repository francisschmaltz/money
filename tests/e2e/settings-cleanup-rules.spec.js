import { expect, test } from "@playwright/test";

test("automatic cleanup can match contained normalized text", async ({
  page,
}) => {
  let submittedRule = null;
  let savedRule = null;
  await page.route(
    "**/api/v1/transaction-cleanup-rules**",
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        submittedRule = request.postDataJSON();
        savedRule = {
          id: "cleanup_rule_contains",
          matcher: {
            ...submittedRule.matcher,
            normalized_value: "motorsports",
          },
          changes: submittedRule.changes,
          enabled: submittedRule.enabled,
          matched_transaction_count: 3,
          updated_at: "2026-07-27T22:49:00.000Z",
        };
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ created: true, rule: savedRule }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rules: savedRule ? [savedRule] : [] }),
      });
    },
  );

  await page.goto("/format-rules");
  const section = page.locator("[data-cleanup-rules]");
  await section.getByRole("button", { name: "New rule" }).click();

  const dialog = page.getByRole("dialog", { name: "New rule" });
  await dialog
    .getByRole("combobox", { name: "Match field" })
    .selectOption("normalized_name");
  await dialog
    .getByRole("combobox", { name: "Match type" })
    .selectOption("contains");
  await dialog.getByRole("textbox", { name: "Match text" }).fill(
    "Motorsports",
  );
  const amountToggle = dialog.getByRole("checkbox", {
    name: "Match amount",
  });
  const amountBounds = await amountToggle.boundingBox();
  expect(amountBounds).not.toBeNull();
  expect(amountBounds.width).toBeLessThanOrEqual(20);
  expect(amountBounds.height).toBeLessThanOrEqual(20);

  const amountOperator = dialog.getByRole("combobox", {
    name: "Amount comparison",
  });
  const amount = dialog.getByRole("spinbutton", { name: "Amount" });
  await expect(amountOperator).toBeDisabled();
  await expect(amount).toBeDisabled();
  await amountToggle.check();
  await expect(amountOperator).toBeEnabled();
  await expect(amount).toBeEnabled();
  await amountOperator.selectOption("less_than");
  await amount.fill("5000");

  await dialog.getByRole("checkbox", { name: "Set category" }).check();
  await dialog.locator("[data-cleanup-rule-category]").selectOption(
    "Groceries",
  );
  await dialog.getByRole("button", { name: "Save rule" }).click();

  expect(submittedRule).toEqual({
    matcher: {
      field: "normalized_name",
      mode: "contains",
      value: "Motorsports",
      amount: {
        operator: "less_than",
        amount_minor: 500_000,
      },
    },
    changes: {
      category_primary: "Groceries",
    },
    enabled: true,
  });
  await expect(section).toContainText(
    "Transaction name contains “Motorsports”",
  );
  await expect(section).toContainText(
    "3 matching posted transactions",
  );
});

test("one-time cleanup can hand an edit to a new rule", async ({
  page,
}) => {
  await page.route(
    "**/api/v1/transactions/batch-edit",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated_count: 1 }),
      });
    },
  );

  await page.goto(
    "/format-rules?transaction=txn_whole_foods#transaction-cleanup",
  );
  await page
    .getByRole("button", { name: /Apply to \d+ selected/ })
    .click();

  const saveAsRule = page.getByRole("button", {
    name: "Save as rule",
  });
  await expect(saveAsRule).toBeVisible();
  await saveAsRule.click();

  await expect(page).toHaveURL(
    /\/format-rules\?transaction=txn_whole_foods#transaction-cleanup$/,
  );
  const dialog = page.getByRole("dialog", { name: "New rule" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Match text" }),
  ).toHaveValue("WHOLE FOODS MKT #1024");
  await expect(
    dialog.locator("[data-cleanup-rule-display-name]"),
  ).toHaveValue("Whole Foods Market");
});

test("Re-Run All checks every posted transaction", async ({ page }) => {
  await page.route(
    "**/api/v1/transaction-cleanup-rules/rerun",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rerun: true,
          transaction_count: 42,
          rule_count: 3,
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/transaction-cleanup-rules",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rules: [] }),
      });
    },
  );

  await page.goto("/format-rules");
  await page.getByRole("button", { name: "Re-Run All" }).click();
  await expect(
    page.locator("[data-cleanup-rerun-status]"),
  ).toHaveText(
    "42 posted transactions checked across 3 enabled rules",
  );
});
