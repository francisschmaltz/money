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

test("category browse, edit, and merge layouts keep their intended columns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/format-rules/categories");

  const section = page.locator("#spending-categories");
  const heading = section.locator(":scope > .settings-card__heading");
  const headingGeometry = await heading.evaluate((element) => {
    const copy = element.firstElementChild.getBoundingClientRect();
    const actions = element.lastElementChild.getBoundingClientRect();
    return {
      copyBottom: copy.bottom,
      actionsTop: actions.top,
    };
  });
  expect(headingGeometry.actionsTop).toBeGreaterThanOrEqual(
    headingGeometry.copyBottom,
  );
  expect(
    headingGeometry.actionsTop - headingGeometry.copyBottom,
  ).toBeLessThanOrEqual(24);

  const firstRow = section.locator("[data-category-row]").first();
  const systemRow = section.locator(
    ".category-manager-row--system",
  );
  const systemPlaceholder = systemRow.locator(
    "[data-category-merge-control]",
  );
  await expect(systemPlaceholder).toBeHidden();
  expect(
    await firstRow.evaluate(
      (row) =>
        getComputedStyle(row)
          .gridTemplateColumns.trim()
          .split(/\s+/)
          .filter(Boolean).length,
    ),
  ).toBe(1);

  await section
    .getByRole("button", { name: "Edit categories" })
    .click();
  const createForm = section.locator("[data-category-create-form]");
  const editForm = firstRow.locator("[data-category-edit-form]");
  await expect(createForm).toBeVisible();
  await expect(editForm).toBeVisible();
  for (const form of [createForm, editForm]) {
    expect(
      await form.evaluate(
        (element) =>
          getComputedStyle(element)
            .gridTemplateColumns.trim()
            .split(/\s+/)
            .filter(Boolean).length,
      ),
    ).toBe(1);
  }
  expect(
    await firstRow.evaluate(
      (row) =>
        getComputedStyle(row)
          .gridTemplateColumns.trim()
          .split(/\s+/)
          .filter(Boolean).length,
    ),
  ).toBe(1);

  await section
    .getByRole("button", { name: "Save changes" })
    .click();
  await section
    .getByRole("button", { name: "Merge categories" })
    .click();
  await expect(systemPlaceholder).toHaveJSProperty("hidden", false);
  expect(
    await systemPlaceholder.evaluate(
      (placeholder) => placeholder.getBoundingClientRect().width,
    ),
  ).toBe(22);
  const mergeColumns = await firstRow.evaluate((row) =>
    getComputedStyle(row)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  expect(mergeColumns).toHaveLength(2);
  expect(mergeColumns[0]).toBe("22px");
});

test("category modes stay readable at every repair breakpoint", async ({
  page,
}) => {
  for (const width of [1120, 989, 800, 641, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/format-rules/categories");

    const section = page.locator("#spending-categories");
    const firstRow = section.locator("[data-category-row]").first();
    const heading = section.locator(":scope > .settings-card__heading");
    const layout = await heading.evaluate((element) => {
      const copy = element.firstElementChild.getBoundingClientRect();
      const actions = element.lastElementChild.getBoundingClientRect();
      const overlapWidth = Math.max(
        0,
        Math.min(copy.right, actions.right) -
          Math.max(copy.left, actions.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(copy.bottom, actions.bottom) -
          Math.max(copy.top, actions.top),
      );
      return {
        overlaps: overlapWidth > 1 && overlapHeight > 1,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(layout.overlaps, `heading at ${width}px`).toBe(false);
    expect(layout.pageWidth).toBeLessThanOrEqual(
      layout.viewportWidth + 1,
    );

    const browseRatio = await firstRow.evaluate((row) => {
      const rowBounds = row.getBoundingClientRect();
      const viewBounds = row
        .querySelector(".category-manager-row__view")
        .getBoundingClientRect();
      return viewBounds.width / rowBounds.width;
    });
    expect(browseRatio, `browse row at ${width}px`).toBeGreaterThan(
      0.75,
    );

    await section
      .getByRole("button", { name: "Edit categories" })
      .click();
    const editRatio = await firstRow.evaluate((row) => {
      const rowBounds = row.getBoundingClientRect();
      const formBounds = row
        .querySelector("[data-category-edit-form]")
        .getBoundingClientRect();
      return formBounds.width / rowBounds.width;
    });
    expect(editRatio, `edit row at ${width}px`).toBeGreaterThan(0.75);

    await section
      .getByRole("button", { name: "Save changes" })
      .click();
    await section
      .getByRole("button", { name: "Merge categories" })
      .click();
    const mergeLayout = await firstRow.evaluate((row) => {
      const columns = getComputedStyle(row)
        .gridTemplateColumns.trim()
        .split(/\s+/)
        .filter(Boolean);
      const rowBounds = row.getBoundingClientRect();
      const viewBounds = row
        .querySelector(".category-manager-row__view")
        .getBoundingClientRect();
      return {
        columns,
        viewRatio: viewBounds.width / rowBounds.width,
      };
    });
    expect(mergeLayout.columns).toHaveLength(2);
    expect(mergeLayout.columns[0]).toBe("22px");
    expect(
      mergeLayout.viewRatio,
      `merge row at ${width}px`,
    ).toBeGreaterThan(0.7);
  }
});

test("long category labels wrap inside the manager at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/format-rules/categories");

  const row = page.locator("[data-category-row]").first();
  const label = row.locator(".category-manager-row__title strong");
  await label.evaluate((element) => {
    element.textContent =
      "A_category_label_that_is_deliberately_long_enough_to_wrap_without_spaces";
  });
  const geometry = await row.evaluate((element) => {
    const rowBounds = element.getBoundingClientRect();
    const labelBounds = element
      .querySelector(".category-manager-row__title strong")
      .getBoundingClientRect();
    return {
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
      labelLeft: labelBounds.left,
      labelRight: labelBounds.right,
      labelHeight: labelBounds.height,
      lineHeight: Number.parseFloat(
        getComputedStyle(
          element.querySelector(".category-manager-row__title strong"),
        ).lineHeight,
      ),
    };
  });
  expect(geometry.labelLeft).toBeGreaterThanOrEqual(
    geometry.rowLeft - 1,
  );
  expect(geometry.labelRight).toBeLessThanOrEqual(
    geometry.rowRight + 1,
  );
  expect(geometry.labelHeight).toBeGreaterThan(
    geometry.lineHeight * 1.5,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth,
    ),
  ).toBeLessThanOrEqual(320);
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
