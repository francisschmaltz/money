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

test("one-time cleanup hands Save as rule to the Rules page", async ({
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
    "/settings?transaction=txn_whole_foods#transaction-cleanup",
  );
  await page
    .getByRole("button", { name: /Apply to \d+ selected/ })
    .click();

  const saveAsRule = page.getByRole("button", {
    name: "Save as rule",
  });
  await expect(saveAsRule).toBeVisible();
  await saveAsRule.click();

  await expect(page).toHaveURL(/\/format-rules\?new_rule=1$/);
  const dialog = page.getByRole("dialog", { name: "New rule" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Match text" }),
  ).toHaveValue("WHOLE FOODS MKT #1024");
  await expect(
    dialog.locator("[data-cleanup-rule-display-name]"),
  ).toHaveValue("Whole Foods Market");
});
