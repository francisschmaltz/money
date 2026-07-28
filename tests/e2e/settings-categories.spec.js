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
  let confirmation;
  page.on("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  const categoryRows = page.locator(
    "#spending-categories [data-category-row]",
  );
  const firstId = await categoryRows
    .nth(0)
    .getAttribute("data-category-id");
  const secondId = await categoryRows
    .nth(1)
    .getAttribute("data-category-id");
  const form = page.locator(
    "#spending-categories [data-category-merge-form]",
  );
  await expect(form).toBeHidden();
  await section
    .getByRole("button", { name: "Merge categories" })
    .click();
  await categoryRows.nth(0).locator("[data-category-select]").check();
  await categoryRows.nth(1).locator("[data-category-select]").check();

  await expect(form.locator("[data-category-merge-summary]")).toContainText(
    "2 selected",
  );
  await form
    .getByLabel("Destination")
    .selectOption("__new__");
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
  expect(confirmation).toContain("into new category “Car”");
});

test("merge mode gates invalid choices and cancel restores focus", async ({
  page,
}) => {
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  const start = section.getByRole("button", {
    name: "Merge categories",
  });
  const rows = section.locator("[data-category-row]");
  const firstInput = rows.nth(0).locator("[data-category-select]");
  const secondInput = rows.nth(1).locator("[data-category-select]");
  const secondId = await rows.nth(1).getAttribute("data-category-id");
  const form = section.locator("[data-category-merge-form]");
  const submit = form.getByRole("button", { name: "Merge selected" });

  await expect(firstInput).toBeHidden();
  await start.click();
  await expect(firstInput).toBeFocused();
  await expect(submit).toBeDisabled();

  await rows.nth(0).locator(".category-manager-row__view").click();
  await expect(firstInput).toBeChecked();
  await form.getByLabel("Destination").selectOption(secondId);
  await expect(submit).toBeEnabled();

  await secondInput.check();
  await expect(
    form
      .getByLabel("Destination")
      .locator(`option[value="${secondId}"]`),
  ).toHaveAttribute("disabled", "");
  await expect(form.getByLabel("Destination")).toHaveValue("");
  await expect(submit).toBeDisabled();
  await expect(form.locator("[data-category-merge-summary]")).toContainText(
    "Destination: Choose a destination",
  );

  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toBeHidden();
  await expect(start).toBeFocused();
  await expect(firstInput).not.toBeChecked();
  await expect(secondInput).not.toBeChecked();
  await expect(firstInput).toBeHidden();
});

test("merge validation errors preserve the selection and return focus", async ({
  page,
}) => {
  await page.route("**/api/v1/categories/merge", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ message: "Category changed; review it again." }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  await section
    .getByRole("button", { name: "Merge categories" })
    .click();
  const rows = section.locator("[data-category-row]");
  const source = rows.nth(0).locator("[data-category-select]");
  const destinationId = await rows.nth(1).getAttribute(
    "data-category-id",
  );
  await source.check();

  const form = section.locator("[data-category-merge-form]");
  await form.getByLabel("Destination").selectOption(destinationId);
  const submit = form.getByRole("button", { name: "Merge selected" });
  await submit.click();

  await expect(form.getByRole("status")).toHaveText(
    "Category changed; review it again.",
  );
  await expect(source).toBeChecked();
  await expect(form.getByLabel("Destination")).toHaveValue(
    destinationId,
  );
  await expect(submit).toBeFocused();
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

test("a valid demo category merge persists after the real endpoint reload", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  const sourceRow = section.locator(
    '[data-category-row][data-category-path="Dining"]',
  );
  const destinationRow = section.locator(
    '[data-category-row][data-category-path="Travel"]',
  );
  const sourceId = await sourceRow.getAttribute("data-category-id");
  const destinationId = await destinationRow.getAttribute(
    "data-category-id",
  );

  await section
    .getByRole("button", { name: "Merge categories" })
    .click();
  await sourceRow.locator("[data-category-select]").check();
  const form = section.locator("[data-category-merge-form]");
  await form
    .getByLabel("Destination")
    .selectOption(destinationId);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/api/v1/categories/merge",
  );
  await form.getByRole("button", { name: "Merge selected" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);

  const mergedRow = page.locator(
    `[data-category-merged-row][data-category-id="${sourceId}"]`,
  );
  await expect(mergedRow).toBeVisible();
  await expect(mergedRow).toContainText("Dining");
  await expect(mergedRow).toContainText("Merged into Travel");
  await expect(
    section.locator(
      `[data-category-row][data-category-id="${destinationId}"]`,
    ),
  ).toContainText("Travel");

  const splitResponsePromise = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname ===
        `/api/v1/categories/${sourceId}/split`,
  );
  await mergedRow.getByRole("button", { name: "Split out" }).click();
  const splitResponse = await splitResponsePromise;
  expect(splitResponse.ok()).toBe(true);
  await expect(
    page.locator(
      `[data-category-row][data-category-id="${sourceId}"]`,
    ),
  ).toContainText("Dining");
});
