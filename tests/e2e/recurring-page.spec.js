import { expect, test } from "@playwright/test";

test("recurring lists show current categories and omit inactive history", async ({
  page,
}) => {
  await page.goto("/recurring");

  await expect(
    page
      .getByRole("heading", { name: "Frequent spending" })
      .locator("xpath=ancestor::section")
      .getByText("Transportation"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Bills" })
      .locator("xpath=ancestor::section")
      .getByText("Utilities")
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Inactive recurring payments" }),
  ).toHaveCount(0);
});

test("admins can create and remove a bill pattern from transaction details", async ({
  page,
}) => {
  const transactionUrl =
    "/transactions?period=365&transaction=txn_whole_foods";
  await page.goto(transactionUrl);
  const recurring = page.locator("details.transaction-recurring-pattern");
  await recurring.locator("summary").click();
  const form = page.locator("[data-transaction-recurring-form]");
  await expect(form).toBeVisible();
  await form.getByLabel("Type").selectOption("bill");
  await form.getByLabel("Frequency").selectOption("monthly");
  await form.getByRole("button", { name: "Mark recurring" }).click();
  await expect(
    page.locator('[data-transaction-recurring-form][data-manual="true"]'),
  ).toHaveCount(1);
  await page
    .locator("details.transaction-recurring-pattern > summary")
    .click();
  await expect(
    page.getByRole("button", { name: "Remove manual pattern" }),
  ).toBeVisible();

  await page.goto("/recurring");
  const bills = page
    .locator("[data-recurring-section]")
    .filter({ has: page.getByRole("heading", { name: "Bills" }) });
  await expect(bills).toContainText("Whole Foods");

  await page.goto(transactionUrl);
  await page
    .locator("details.transaction-recurring-pattern > summary")
    .click();
  await page
    .getByRole("button", { name: "Remove manual pattern" })
    .click();
  await expect(
    page.locator('[data-transaction-recurring-form][data-manual="false"]'),
  ).toHaveCount(1);

  await page.goto("/recurring");
  await expect(
    page
      .locator("[data-recurring-section]")
      .filter({ hasText: "Whole Foods" }),
  ).toHaveCount(0);
});
