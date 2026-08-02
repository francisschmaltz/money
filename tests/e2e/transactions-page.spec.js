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
    const startSelection = page.getByRole("button", {
      name: "Select & edit",
    });
    await startSelection.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(
        '[data-bulk-transaction-row][data-transaction-status="pending"] [data-bulk-transaction-select]',
      ),
    ).toBeEnabled();

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

    await expect(page.locator("[data-transaction-filter]")).toHaveJSProperty(
      "inert",
      true,
    );
    await expect(page.locator("[data-transaction-filter]")).toHaveAttribute(
      "data-selection-frozen",
      "",
    );
    await expect(page.locator(".pagination")).toHaveJSProperty(
      "inert",
      true,
    );

    const firstSelectable = page
      .locator("[data-bulk-transaction-select]:not(:disabled)")
      .first();
    await expect(firstSelectable).toBeFocused();
    await expect(
      page.locator("[data-bulk-transaction-row] .transaction-row").first(),
    ).toHaveJSProperty("inert", true);
    const selectionUrl = page.url();
    await page.keyboard.press("Space");
    await expect(firstSelectable).toBeChecked();
    expect(page.url()).toBe(selectionUrl);

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Select & edit" }),
    ).toBeFocused();
    await expect(firstSelectable).not.toBeChecked();
    await expect(page.locator("[data-transaction-filter]")).toHaveJSProperty(
      "inert",
      false,
    );
    await expect(
      page.locator("[data-bulk-transaction-row] .transaction-row").first(),
    ).toHaveJSProperty("inert", false);

    if (viewport.width === 1024) {
      await startSelection.click();
      const selectableRow = firstSelectable.locator(
        "xpath=ancestor::*[@data-bulk-transaction-row]",
      );
      const pointerUrl = page.url();
      await selectableRow.click({ position: { x: 100, y: 32 } });
      await expect(firstSelectable).toBeChecked();
      expect(page.url()).toBe(pointerUrl);
      await page
        .locator("[data-bulk-selection-bar]")
        .getByRole("button", { name: "Cancel" })
        .click();
      await expect(startSelection).toBeFocused();
      await expect(firstSelectable).not.toBeChecked();
    }
  }
});

test("transaction controls submit compact URL state and restore it through history", async ({
  page,
}) => {
  await page.goto("/transactions");
  const filters = page.locator("[data-transaction-filter]");

  await filters.getByLabel("Search").fill("Whole Foods");
  await filters.getByLabel("Timeline").selectOption("90");
  await filters.getByLabel("Sort").selectOption("merchant");
  const applyFilters = filters.getByRole("button", { name: "Apply" });
  await applyFilters.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/q=Whole(\+|%20)Foods/);
  await expect(page).toHaveURL(/period=90/);
  await expect(page).toHaveURL(/sort=merchant/);
  expect(page.url()).not.toMatch(/category=&|account=&/);
  await expect(page.locator(".transaction-row")).not.toHaveCount(0);

  await filters.getByLabel("Sort").selectOption("category");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/sort=category/);
  await expect(filters.getByLabel("Search")).toHaveValue("Whole Foods");
  await expect(filters.getByLabel("Timeline")).toHaveValue("90");

  await page.goBack();
  await expect(page).toHaveURL(/sort=merchant/);
  await expect(filters.getByLabel("Search")).toHaveValue("Whole Foods");
});

test("transaction filters expose one submitting state and block a second click", async ({
  page,
}) => {
  await page.goto("/transactions");
  await page.evaluate(() => {
    window.__transactionFilterSubmits = 0;
    document
      .querySelector("[data-transaction-filter]")
      .addEventListener("submit", (event) => {
        window.__transactionFilterSubmits += 1;
        event.preventDefault();
      });
  });

  const form = page.locator("[data-transaction-filter]");
  const apply = form.getByRole("button", { name: "Apply" });
  await apply.click();

  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveText("Applying…");
  await apply.evaluate((button) => button.click());
  expect(
    await page.evaluate(() => window.__transactionFilterSubmits),
  ).toBe(1);
});

test("transaction timelines and sort choices change the ledger", async ({
  page,
}) => {
  await page.goto("/transactions?period=365&sort=merchant");
  await expect(page.getByLabel("Timeline")).toHaveValue("365");
  await expect(page.getByLabel("Sort")).toHaveValue("merchant");

  const merchants = await page
    .locator(".transaction-row__main strong")
    .allTextContents();
  expect(merchants.length).toBeGreaterThan(1);
  expect(merchants).toEqual(
    [...merchants].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
  );

  await page.goto("/transactions?period=this-year&sort=category");
  const categories = (
    await page
      .locator(".transaction-row__category")
      .allTextContents()
  ).map((value) => value.split("·", 1)[0].trim());
  expect(categories).toEqual(
    [...categories].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
  );

  await page.goto("/transactions?period=90&sort=cost");
  await expect(
    page.locator(".transaction-row__main strong").first(),
  ).toHaveText("Wells Fargo Auto");
  await expect(
    page.locator(".transaction-row__main strong").last(),
  ).toHaveText(/Acme Payroll|Seacomm Transfer/);

  await page.goto("/transactions?period=last-year&sort=date");
  await expect(page.getByLabel("Timeline")).toHaveValue("last-year");
  await expect(page.locator(".transaction-row")).toHaveCount(0);
  await expect(
    page.getByText("No transactions match these filters."),
  ).toBeVisible();
  await expect(
    page.locator(".ledger-summary").getByText("$0.00"),
  ).toHaveCount(3);
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

  const form = page.locator("[data-transaction-category-form]");
  await expect(form).toBeVisible();
  await form.getByLabel("Category").selectOption({ label: "Dining" });
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          "/api/v1/transactions/batch-edit",
    ),
    form
      .getByRole("button", { name: "Save category" })
      .click(),
  ]);

  expect(write).toEqual({
    transaction_ids: ["txn_whole_foods"],
    changes: { category_primary: "Dining" },
  });
});

test("a posted transaction can move to an exact adjacent Plan month on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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

  await page.locator("details.transaction-organize > summary").click();
  const form = page.locator("[data-transaction-organize-form]");
  const planMonth = form.getByLabel("Apply to Plan month");
  await expect(planMonth.locator("option")).toHaveText([
    "June 2026 · Previous month",
    "July 2026 · Posted month",
    "August 2026 · Next month",
  ]);
  await planMonth.selectOption("-1");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByRole("status")).toHaveText("Changes saved");

  expect(write).toEqual({
    transaction_ids: ["txn_whole_foods"],
    changes: { budget_month_offset: -1 },
  });
  const geometry = await form.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
  }));
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
});

test("pending charges expose durable edits, roles, recurrence, and splits on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.goto("/transactions?transaction=txn_con_edison");

  const body = page.locator(
    ".entity-detail-dialog__body--transaction",
  );
  await expect(
    body.getByRole("heading", { name: "Transaction allocation" }),
  ).toBeVisible();
  await expect(body.locator(".transaction-split-editor")).toContainText(
    "final amount may change",
  );
  await expect(
    body.locator("details.transaction-recurring-pattern"),
  ).toContainText("re-anchor to the final amount");

  await body.locator("details.transaction-organize > summary").click();
  const organizer = body.locator("details.transaction-organize");
  const form = organizer.locator("[data-transaction-organize-form]");
  await expect(organizer).toContainText(
    "Pending details may change. Your edits will carry over when the charge posts.",
  );
  await form.getByLabel("Cash-flow role").selectOption("obligation");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByRole("status")).toHaveText("Changes saved");

  expect(write).toEqual({
    transaction_ids: ["txn_con_edison"],
    changes: { cash_flow_role: "obligation" },
  });
  const geometry = await body.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(1);
});

test("bulk Plan month changes stay relative to each selected posted month", async ({
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
        body: JSON.stringify({ updated_count: 2 }),
      });
    },
  );
  await page.goto("/transactions");
  await page.getByRole("button", { name: "Select & edit" }).click();
  const posted = page.locator(
    "[data-bulk-transaction-select]:not(:disabled)",
  );
  await posted.nth(0).check();
  await posted.nth(1).check();
  await page.getByRole("button", { name: "Edit 2 selected" }).click();

  const dialog = page.locator("[data-bulk-edit-dialog]");
  await dialog
    .locator('[data-bulk-change="budget_month_offset"]')
    .check();
  await dialog.locator("[data-bulk-budget-month]").selectOption("1");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "2 transactions updated",
  );

  expect(write.transaction_ids).toHaveLength(2);
  expect(write.changes).toEqual({ budget_month_offset: 1 });
});

test("transaction notes save and the detail body uses the full modal width", async ({
  page,
}) => {
  let write;
  await page.route(
    "**/api/v1/transactions/txn_whole_foods/note",
    async (route) => {
      write = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transaction_id: "txn_whole_foods",
          note: "Dinner with Sam",
          note_version: 2,
        }),
      });
    },
  );
  await page.goto("/transactions?transaction=txn_whole_foods");

  const dialog = page.locator(".entity-detail-dialog--transaction");
  const body = dialog.locator(".entity-detail-dialog__body--transaction");
  const widths = await Promise.all([
    dialog.locator(".entity-detail-dialog__panel").evaluate(
      (element) => element.getBoundingClientRect().width,
    ),
    body.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);

  const noteDetails = dialog.locator("details.transaction-note-editor");
  await noteDetails.locator(":scope > summary").click();
  const form = dialog.locator("[data-transaction-note-form]");
  await form.getByLabel("Transaction note").fill("Dinner with Sam");
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByRole("status")).toHaveText("Note saved");
  await noteDetails.locator(":scope > summary").click();
  await expect(
    noteDetails.locator(".transaction-disclosure__preview"),
  ).toHaveText("Dinner with Sam");
  expect(write).toEqual({
    note: "Dinner with Sam",
    expected_note_version: 1,
  });
});

test("transaction details keep custom controls compact and ahead of provider data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/transactions?transaction=txn_whole_foods");
  const desktopSizing = await page
    .locator(".entity-detail-dialog__body--transaction")
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      categoryButtonWidth: element
        .querySelector("[data-transaction-category-form] button")
        ?.getBoundingClientRect().width,
      mapHeight: getComputedStyle(
        element.querySelector("[data-mapkit-map]"),
      ).height,
    }));
  expect(desktopSizing.categoryButtonWidth).toBeLessThan(
    desktopSizing.width * 0.6,
  );
  expect(desktopSizing.mapHeight).toBe("160px");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/transactions?transaction=txn_whole_foods");

  const body = page.locator(".entity-detail-dialog__body--transaction");
  const note = body.locator("details.transaction-note-editor");
  const organize = body.locator("details.transaction-organize");
  const recurring = body.locator("details.transaction-recurring-pattern");
  const provider = body.locator(".transaction-provider-details");

  await expect(
    body.getByRole("heading", { name: "Transaction allocation" }),
  ).toBeVisible();
  await expect(note).not.toHaveAttribute("open", "");
  await expect(organize).not.toHaveAttribute("open", "");
  await expect(recurring).not.toHaveAttribute("open", "");
  await expect(provider).toBeVisible();
  await expect(body.locator("[data-transaction-location]")).toBeVisible();

  const ordered = await body.evaluate((element) => {
    const selectors = [
      ".transaction-allocation",
      ".transaction-note-editor",
      ".transaction-organize",
      ".transaction-recurring-pattern",
      ".transaction-location",
      ".transaction-provider-details",
    ];
    return selectors.map((selector) =>
      element.querySelector(selector)?.getBoundingClientRect().top,
    );
  });
  expect(ordered.every((position) => Number.isFinite(position))).toBe(true);
  expect(ordered).toEqual([...ordered].sort((left, right) => left - right));

  await note.locator("summary").click();
  await organize.locator("summary").click();
  const sizing = await body.evaluate((element) => {
    const width = element.getBoundingClientRect().width;
    const buttonWidths = [
      element.querySelector("[data-transaction-category-form] button"),
      element.querySelector("[data-transaction-note-form] button"),
      element.querySelector("[data-transaction-organize-form] button"),
    ].map((button) => button?.getBoundingClientRect().width);
    return {
      width,
      buttonWidths,
      overflow: element.scrollWidth - element.clientWidth,
      mapHeight: getComputedStyle(
        element.querySelector("[data-mapkit-map]"),
      ).height,
    };
  });
  expect(sizing.overflow).toBeLessThanOrEqual(1);
  expect(sizing.buttonWidths.every((width) => width < sizing.width * 0.6)).toBe(
    true,
  );
  expect(sizing.mapHeight).toBe("140px");
});
