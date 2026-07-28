import { expect, test } from "@playwright/test";

const uploadType = "application/vnd.money.apple-card-import";
const csv = [
  [
    "Transaction Date",
    "Clearing Date",
    "Description",
    "Merchant",
    "Category",
    "Type",
    "Amount (USD)",
    "Purchased By",
  ].join(","),
  [
    "07/01/2026",
    "07/03/2026",
    "Synthetic market purchase",
    "Example Market",
    "Grocery",
    "Purchase",
    "10.10",
    "Sample Cardholder",
  ].join(","),
].join("\n");

test("Apple Card preview and confirm send the same bounded structured upload", async ({
  page,
}) => {
  const uploads = [];
  await page.route(
    /\/api\/v1\/apple-card\/imports(?:\/preview)?$/,
    async (route) => {
      const request = route.request();
      const payload = JSON.parse(request.postData());
      uploads.push({
        path: new URL(request.url()).pathname,
        contentType: request.headers()["content-type"],
        payload,
      });
      if (request.url().endsWith("/preview")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            preview_digest: "a".repeat(64),
            posted_start_on: "2026-07-03",
            posted_end_on: "2026-07-03",
            charge_total_minor: 1_010,
            credit_total_minor: 0,
            accepted_row_count: 1,
            new_row_count: 1,
            existing_row_count: 0,
            rejected_row_count: 0,
            warning_count: 0,
            rejected: [],
            warnings: [],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          new_row_count: 1,
          existing_row_count: 0,
        }),
      });
    },
  );

  await page.goto("/settings");
  await page
    .getByRole("button", { name: "Import Apple Card CSV" })
    .click();
  const form = page.locator("[data-apple-card-import-form]");
  await form.locator('input[name="file"]').setInputFiles({
    name: "apple-card.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await form.locator('input[name="balance"]').fill("12.34");
  await form.locator('input[name="credit_limit"]').fill("1000.00");
  await form.locator('input[name="balance_as_of"]').fill("2026-07-28");
  await form.getByRole("button", { name: "Preview import" }).click();
  const confirm = form.getByRole("button", { name: "Confirm import" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(form.getByRole("status")).toContainText(
    "Imported 1 new transaction",
  );

  expect(uploads).toHaveLength(2);
  expect(uploads.map(({ path }) => path)).toEqual([
    "/api/v1/apple-card/imports/preview",
    "/api/v1/apple-card/imports",
  ]);
  expect(uploads.map(({ contentType }) => contentType)).toEqual([
    uploadType,
    uploadType,
  ]);
  expect(uploads[0].payload.file_base64).toBe(
    Buffer.from(csv).toString("base64"),
  );
  expect(uploads[1].payload.file_base64).toBe(
    uploads[0].payload.file_base64,
  );
  expect(uploads[1].payload.preview_digest).toBe("a".repeat(64));
  expect(Object.keys(uploads[1].payload).sort()).toEqual([
    "balance",
    "balance_as_of",
    "credit_limit",
    "file_base64",
    "last_four",
    "preview_digest",
  ]);
});
