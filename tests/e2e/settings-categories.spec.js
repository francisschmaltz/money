import { expect, test } from "@playwright/test";

async function captureCategoryWrite(page) {
  let write;
  await page.route("**/api/v1/categories**", async (route) => {
    const request = route.request();
    write = {
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
    };
    await route.fulfill({
      status: request.method() === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return () => write;
}

test("spending categories use explicit hierarchy and classification controls", async ({
  page,
}) => {
  const capturedWrite = await captureCategoryWrite(page);
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  await expect(
    section.getByRole("heading", { name: "Spending categories" }),
  ).toBeVisible();
  await expect(section.getByText("Fixed categories stay visible")).toBeVisible();
  await section
    .getByRole("button", { name: "Edit categories" })
    .click();

  const form = section.locator("[data-category-create-form]");
  await form.getByLabel("Name").fill("Car");
  await form.getByLabel("Classification").selectOption("fixed");
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v1/categories",
    ),
    form.getByRole("button", { name: "Create category" }).click(),
  ]);

  expect(capturedWrite()).toEqual({
    method: "POST",
    path: "/api/v1/categories",
    body: {
      name: "Car",
      classification: "fixed",
      parent_category_id: null,
    },
  });
});

test("a category can be renamed and reclassified with its exact version", async ({
  page,
}) => {
  const capturedWrite = await captureCategoryWrite(page);
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  await section
    .getByRole("button", { name: "Edit categories" })
    .click();
  const form = page
    .locator("#spending-categories [data-category-edit-form]")
    .first();
  await expect(form).toBeVisible();
  await form.getByLabel("Category name").fill("Home");
  await form
    .getByLabel("Spending classification")
    .selectOption("flexible");
  await Promise.all([
    page.waitForRequest((request) => request.method() === "PATCH"),
    section
      .getByRole("button", { name: "Save changes" })
      .click(),
  ]);

  expect(capturedWrite()).toMatchObject({
    method: "PATCH",
    body: {
      name: "Home",
      classification: "flexible",
      parent_category_id: null,
      expected_version: 1,
    },
  });
});

test("a category can be deleted into Other", async ({ page }) => {
  const capturedWrite = await captureCategoryWrite(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  await section
    .getByRole("button", { name: "Edit categories" })
    .click();
  const row = section.locator("[data-category-row]").first();
  const categoryId = await row.getAttribute("data-category-id");
  await Promise.all([
    page.waitForRequest(
      (request) => request.method() === "DELETE",
    ),
    row.getByRole("button", { name: "Delete" }).click(),
  ]);

  expect(capturedWrite()).toEqual({
    method: "DELETE",
    path: `/api/v1/categories/${categoryId}`,
    body: { expected_version: 1 },
  });
});

test("merge preview counts affected records and submits a new destination", async ({
  page,
}) => {
  const capturedWrite = await captureCategoryWrite(page);
  await page.goto("/format-rules/categories");

  const categoryRows = page.locator(
    "#spending-categories [data-category-row]",
  );
  const firstId = await categoryRows
    .nth(0)
    .getAttribute("data-category-id");
  const secondId = await categoryRows
    .nth(1)
    .getAttribute("data-category-id");
  await categoryRows.nth(0).locator("[data-category-select]").check();
  await categoryRows.nth(1).locator("[data-category-select]").check();

  const form = page.locator(
    "#spending-categories [data-category-merge-form]",
  );
  await expect(form.getByRole("status")).toContainText(
    "2 selected · 0 transactions · 0 budget lines",
  );
  await form.getByLabel("New name").fill("Car");
  await form.getByLabel("Classification").selectOption("flexible");
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          "/api/v1/categories/merge",
    ),
    form.getByRole("button", { name: "Merge selected" }).click(),
  ]);

  expect(capturedWrite()).toMatchObject({
    method: "POST",
    path: "/api/v1/categories/merge",
    body: {
      source_category_ids: [firstId, secondId],
      destination: {
        name: "Car",
        classification: "flexible",
        parent_category_id: null,
      },
      expected_versions: {
        [firstId]: 1,
        [secondId]: 1,
      },
    },
  });
});

test("Other is last, protected, and has no category icon", async ({
  page,
}) => {
  await page.goto("/format-rules/categories");
  const section = page.locator("#spending-categories");
  const rows = section.locator("[data-category-row]");
  const other = rows.last();

  await expect(other).toContainText("Other");
  await expect(other).toContainText("Fallback");
  await expect(other.locator("[data-category-select]")).toHaveCount(0);
  await expect(section.locator(".list-icon")).toHaveCount(0);

  await section
    .getByRole("button", { name: "Edit categories" })
    .click();
  await expect(other.locator("[data-category-edit-form]")).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Delete" })).toHaveCount(0);
});
