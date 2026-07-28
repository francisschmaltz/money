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
