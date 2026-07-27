import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Plan keeps one Safe to Spend card and a fixed, editable budget", async ({
  page,
}) => {
  await page.goto("/plan");

  const planSafeToSpend = page.getByRole("region", {
    name: "Safe to Spend",
  });
  const safeToSpendText = await planSafeToSpend.evaluate((element) =>
    element.innerText.replace(/\s+/g, " ").trim(),
  );
  await expect(planSafeToSpend.getByRole("link")).toHaveCount(0);

  const budget = page.getByRole("region", { name: "Budget" });
  await expect(budget.getByRole("columnheader")).toHaveText([
    "Category",
    "Planned",
    "Actual",
    "Remaining",
    "Previous month actual",
  ]);
  await expect(budget.locator('input[type="month"]')).toHaveCount(0);
  await expect(budget.getByRole("row").nth(1)).toContainText("Total");
  await expect(
    budget.getByRole("link", { name: "Dining" }),
  ).toHaveAttribute("href", "/transactions?category=Dining");
  await expect(budget.getByRole("row", { name: /^Dining / })).toContainText(
    "over",
  );

  await budget.getByRole("link", { name: /Edit budget/ }).click();
  const diningInput = page.getByRole("textbox", {
    name: "Dining planned amount",
  });
  await diningInput.fill("451.00");
  await page
    .getByRole("row", { name: /^Dining / })
    .getByRole("button", { name: "Save" })
    .click();
  await page.waitForTimeout(450);
  await page.reload();
  await expect(diningInput).toHaveValue("451.00");

  await diningInput.fill("450.00");
  await page
    .getByRole("row", { name: /^Dining / })
    .getByRole("button", { name: "Save" })
    .click();
  await page.waitForTimeout(450);
  await page.reload();
  await expect(diningInput).toHaveValue("450.00");
  await page.getByRole("link", { name: /Done/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Dining planned amount" }),
  ).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact),
    ),
  ).toEqual([]);

  await page.goto("/");
  const dashboardSafeToSpendText = await page
    .getByRole("region", { name: "Safe to Spend" })
    .evaluate((element) => element.innerText.replace(/\s+/g, " ").trim());
  expect(dashboardSafeToSpendText).toBe(safeToSpendText);
});

test("Plan contains wide budget data without widening the mobile page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/plan");

  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    table: document.querySelector(".budget-table")?.scrollWidth ?? 0,
    tableViewport:
      document.querySelector(".budget-table")?.clientWidth ?? 0,
  }));
  expect(widths.page).toBe(widths.viewport);
  expect(widths.table).toBeGreaterThan(widths.tableViewport);
});

test("goal summaries use compact actions and modal editing", async ({
  page,
}) => {
  await page.goto("/plan");

  const goals = page.getByRole("region", { name: "Goals" });
  await expect(goals.locator(".goal-card form")).toHaveCount(0);
  await expect(goals.locator(".goal-card details")).toHaveCount(0);

  const actionButtons = goals.locator(
    '[data-goal-dialog-open="edit"], [data-goal-dialog-open="allocate"]',
  );
  expect(await actionButtons.count()).toBeGreaterThan(0);
  const actionButtonMetrics = await actionButtons.evaluateAll((buttons) =>
    buttons.map((button) => ({
      height: button.getBoundingClientRect().height,
      classes: [...button.classList],
    })),
  );
  expect(
    actionButtonMetrics.every(
      ({ height, classes }) =>
        height >= 38 &&
        height <= 44 &&
        classes.includes("button") &&
        !classes.includes("button--full"),
    ),
  ).toBe(true);

  const createButton = goals.locator(
    '[data-goal-dialog-open="create"]',
  );
  await expect(createButton).toHaveText("New goal");
  await createButton.click();
  const createDialog = page.locator(
    '[data-goal-dialog="create"][open]',
  );
  await expect(createDialog).toBeVisible();
  await expect(createDialog.locator('input[name="name"]')).toBeFocused();
  const dialogAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    dialogAccessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact),
    ),
  ).toEqual([]);
  await createDialog.getByRole("heading", { name: "New goal" }).click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(createDialog).not.toBeVisible();
  await expect(createButton).toBeFocused();

  await createButton.click();
  await expect(createDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(createDialog).not.toBeVisible();
  await expect(createButton).toBeFocused();

  await createButton.click();
  await expect(createDialog).toBeVisible();
  await createDialog.dispatchEvent("click");
  await expect(createDialog).not.toBeVisible();

  const houseGoal = goals.locator(".goal-card", {
    hasText: "House down payment",
  });
  await expect(
    houseGoal.getByRole("button", {
      name: "Edit House down payment",
    }),
  ).toBeVisible();
  await expect(
    houseGoal.getByRole("button", {
      name: "Move money for House down payment",
    }),
  ).toHaveText("Move money");
  await houseGoal.locator('[data-goal-dialog-open="edit"]').click();
  const editDialog = page.locator('[data-goal-dialog="edit"][open]');
  await expect(editDialog).toBeVisible();
  const editGoalForm = editDialog.locator(
    'form[data-endpoint="/api/v1/plan/goals/goal_down_payment"][data-method="PUT"]',
  );
  await expect(editGoalForm.locator('input[name="name"]')).toHaveValue(
    "House down payment",
  );
  await expect(
    editGoalForm.locator(
      'input[data-money-minor="target_amount_minor"]',
    ),
  ).toHaveValue("100000.00");
  await expect(
    editGoalForm.locator('input[name="expected_version"]'),
  ).toHaveValue("1");
  await expect(
    editGoalForm.locator('select[name="purpose"]'),
  ).toHaveValue("home");
  await expect(editGoalForm).toHaveAttribute(
    "data-endpoint",
    "/api/v1/plan/goals/goal_down_payment",
  );
  await expect(
    editDialog.locator(
      'form[data-endpoint="/api/v1/plan/goals/goal_down_payment/schedule"]',
    ),
  ).toHaveCount(1);
  const finishForm = editDialog.locator(
    'form[data-endpoint="/api/v1/plan/goals/goal_down_payment/finish"][data-method="POST"]',
  );
  await expect(
    finishForm.getByRole("combobox", {
      name: "Outcome for House down payment",
    }),
  ).toHaveValue("completed");
  await expect(
    finishForm.getByRole("button", { name: "Finish goal" }),
  ).toBeVisible();
  await editDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(editDialog).not.toBeVisible();

  await houseGoal
    .locator('[data-goal-dialog-open="allocate"]')
    .click();
  const allocateDialog = page.locator(
    '[data-goal-dialog="allocate"][open]',
  );
  await expect(allocateDialog).toBeVisible();
  await expect(
    allocateDialog.locator('input[name="expected_version"]'),
  ).toHaveValue("1");
  const fundingSummary = allocateDialog.locator(
    ".plan-dialog__funding-summary",
  );
  await expect(fundingSummary).toHaveAttribute(
    "aria-label",
    "Current goal funding",
  );
  await expect(fundingSummary).toContainText("Cash");
  await expect(fundingSummary).toContainText("$5,000.00");
  await expect(fundingSummary).toContainText("Brokerage");
  await expect(fundingSummary).toContainText("$15,000.00");
  await expect(fundingSummary).toContainText("Still needed");
  await expect(fundingSummary).toContainText("$80,000.00");
  await expect(allocateDialog.locator("form")).toHaveAttribute(
    "data-endpoint",
    "/api/v1/plan/goals/goal_down_payment/allocations",
  );
  await allocateDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(allocateDialog).not.toBeVisible();
});

test("finished goals keep over-plan history and learned patterns", async ({
  page,
}) => {
  await page.goto("/plan");

  const finishedGoals = page.locator("details.finished-goals");
  await expect(finishedGoals).toHaveCount(1);
  await expect(finishedGoals).not.toHaveAttribute("open", "");
  await finishedGoals.locator(":scope > summary").click();
  await expect(finishedGoals).toHaveAttribute("open", "");

  const vacation = finishedGoals.locator(".finished-goal-card", {
    hasText: "Summer vacation",
  });
  await expect(vacation).toBeVisible();
  await expect(vacation).toContainText("Vacation");
  await expect(vacation).toContainText("Completed");
  await expect(vacation).toContainText("Planned");
  await expect(vacation).toContainText("$3,000.00");
  await expect(vacation).toContainText("Actual");
  await expect(vacation).toContainText("$3,300.00");
  await expect(
    vacation.locator(".goal-plan-summary__usage--over"),
  ).toContainText("110%");
  await expect(
    vacation.locator(".goal-plan-overage"),
  ).toContainText("$300.00");
  await expect(
    vacation.locator("dl > div", { hasText: "Remaining" }),
  ).toContainText("$0.00");
  await expect(vacation).not.toContainText("-$300.00");
  await expect(vacation.locator("form, button, a")).toHaveCount(0);
  await expect(
    finishedGoals.getByText(
      "You tend to spend 10% more on vacation goals than planned.",
      { exact: true },
    ),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact),
    ),
  ).toEqual([]);
});

test("goal dialogs do not widen the mobile page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/plan");
  await page
    .locator('.goal-card [data-goal-dialog-open="edit"]')
    .first()
    .click();
  await expect(
    page.locator('[data-goal-dialog="edit"][open]'),
  ).toBeVisible();

  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    dialog: document.querySelector('[data-goal-dialog="edit"][open]')
      ?.scrollWidth,
    dialogViewport: document.querySelector(
      '[data-goal-dialog="edit"][open]',
    )?.clientWidth,
  }));
  expect(widths.page).toBe(widths.viewport);
  expect(widths.dialog).toBe(widths.dialogViewport);
});

test("a zero-earmark goal can overspend, undo, and finish", async ({
  page,
}) => {
  const goalName = "Unfunded weekend";
  await page.goto("/plan");
  await page
    .locator('[data-goal-dialog-open="create"]')
    .click();
  const createDialog = page.locator(
    '[data-goal-dialog="create"][open]',
  );
  await createDialog.locator('input[name="name"]').fill(goalName);
  await createDialog
    .locator('select[name="purpose"]')
    .selectOption("vacation");
  await createDialog
    .locator('input[data-money-minor="target_amount_minor"]')
    .fill("100.00");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/plan/goals") &&
      response.request().method() === "POST",
  );
  await createDialog
    .getByRole("button", { name: "Create goal" })
    .click();
  expect((await createdResponse).status()).toBe(201);
  await page.waitForTimeout(400);
  await expect(
    page.locator(".goal-card", { hasText: goalName }),
  ).toBeVisible();

  await page.goto(
    "/transactions?transaction=txn_whole_foods",
  );

  const editor = page.locator("details.transaction-goal-editor");
  await editor.getByText("Spend from goal", { exact: true }).click();
  await editor.locator('select[name="goal_id"]').selectOption({
    label: goalName,
  });
  const cashSource = editor.locator(
    'select[name="source"] option[value="cash"]',
  );
  const brokerageSource = editor.locator(
    'select[name="source"] option[value="brokerage"]',
  );
  await expect(cashSource).toHaveText(
    "Cash · $0.00 earmarked · overspend allowed",
  );
  await expect(brokerageSource).toHaveText(
    "Brokerage · $0.00 earmarked · overspend allowed",
  );
  await expect(cashSource).toBeEnabled();
  await expect(brokerageSource).toBeEnabled();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        "/api/v1/transactions/txn_whole_foods/goal-spends",
      ) && response.request().method() === "POST",
  );
  await editor
    .getByRole("button", { name: "Use goal" })
    .click();
  expect((await savedResponse).status()).toBe(201);
  await page.waitForTimeout(400);

  const savedEditor = page.locator(
    "details.transaction-goal-editor",
  );
  await savedEditor
    .getByText("Spend from goal", { exact: true })
    .click();
  await expect(savedEditor).toContainText("Cash · $138.42");
  const reversedResponse = page.waitForResponse(
    (response) =>
      response.url().includes(
        "/api/v1/transactions/txn_whole_foods/goal-spends/",
      ) && response.request().method() === "DELETE",
  );
  await savedEditor.getByRole("button", { name: /^Undo / }).click();
  expect((await reversedResponse).status()).toBe(200);
  await page.waitForTimeout(400);
  const restoredEditor = page.locator(
    "details.transaction-goal-editor",
  );
  await restoredEditor
    .getByText("Spend from goal", { exact: true })
    .click();
  await expect(
    restoredEditor.getByRole("button", { name: "Use goal" }),
  ).toHaveCount(1);
  await restoredEditor.locator('select[name="goal_id"]').selectOption({
    label: goalName,
  });
  const resavedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        "/api/v1/transactions/txn_whole_foods/goal-spends",
      ) && response.request().method() === "POST",
  );
  await restoredEditor
    .getByRole("button", { name: "Use goal" })
    .click();
  expect((await resavedResponse).status()).toBe(201);
  await page.waitForTimeout(400);

  await page.goto("/plan");
  const activeGoal = page.locator(".goal-card", {
    hasText: goalName,
  });
  await expect(
    activeGoal.locator(".goal-plan-summary__usage--over"),
  ).toContainText("138.4%");
  await expect(
    activeGoal.locator(".goal-plan-overage"),
  ).toContainText("$38.42");
  await expect(
    activeGoal.locator(".goal-plan-summary > div", {
      hasText: "Remaining",
    }),
  ).toContainText("$0.00");
  await expect(activeGoal).not.toContainText("-$38.42");
  await activeGoal
    .locator('[data-goal-dialog-open="edit"]')
    .click();
  const editDialog = page.locator('[data-goal-dialog="edit"][open]');
  const finishForm = editDialog.locator(
    'form[data-endpoint$="/finish"]',
  );
  await finishForm
    .locator('select[name="outcome"]')
    .selectOption("completed");
  const finishedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/finish") &&
      response.request().method() === "POST",
  );
  await finishForm
    .getByRole("button", { name: "Finish goal" })
    .click();
  expect((await finishedResponse).status()).toBe(200);
  await page.waitForTimeout(400);
  await expect(
    page.locator(".goal-card", { hasText: goalName }),
  ).toHaveCount(0);
  const finishedGoals = page.locator("details.finished-goals");
  await finishedGoals.locator(":scope > summary").click();
  const finishedGoal = finishedGoals.locator(
    ".finished-goal-card",
    { hasText: goalName },
  );
  await expect(finishedGoal).toContainText("Completed");
  await expect(
    finishedGoal.locator(".goal-plan-summary__usage--over"),
  ).toContainText("138.4%");
  await expect(
    finishedGoal.locator(".goal-plan-overage"),
  ).toContainText("$38.42");
  await expect(
    finishedGoal.locator("dl > div", { hasText: "Remaining" }),
  ).toContainText("$0.00");
  await expect(finishedGoal).not.toContainText("-$38.42");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact),
    ),
  ).toEqual([]);
});
