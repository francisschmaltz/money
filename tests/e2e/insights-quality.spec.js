import { expect, test } from "@playwright/test";
import { DEMO_IDS } from "../../app/demo/fixtureIds.js";

function insightCard(page, title) {
  return page.locator("[data-insight-card]").filter({ hasText: title });
}

test("insight review links open the exact transaction, holding, and recurring dialogs", async ({
  page,
}) => {
  await page.goto("/insights");

  const transactionInsight = insightCard(
    page,
    "Review the Delta Air Lines charge",
  );
  await transactionInsight.locator(".insight-card__solve").click();
  await expect(page).toHaveURL(
    new RegExp(
      `/transactions\\?transaction=${DEMO_IDS.transactions.delta}$`,
    ),
  );
  const transactionDialog = page.locator(
    "dialog[open][data-detail-dialog]",
  );
  await expect(
    transactionDialog.getByRole("heading", {
      name: "Delta Air Lines",
    }),
  ).toBeVisible();

  await page.goto("/insights");
  const holdingInsight = insightCard(
    page,
    "Review VTI concentration",
  );
  await holdingInsight.locator(".insight-card__solve").click();
  await expect(page).toHaveURL(/\/portfolio\?holding=VTI$/);
  const holdingDialog = page.locator("dialog[open][data-detail-dialog]");
  await expect(
    holdingDialog.getByRole("heading", { name: "VTI" }),
  ).toBeVisible();

  await page.goto("/insights");
  const recurringInsight = insightCard(
    page,
    "Decide whether Google Workspace is worth it",
  );
  await recurringInsight.locator(".insight-card__solve").click();
  await expect(page).toHaveURL(
    new RegExp(
      `/recurring\\?item=${DEMO_IDS.recurring.googleWorkspace}$`,
    ),
  );
  const recurringDialog = page.locator("dialog[open][data-detail-dialog]");
  await expect(
    recurringDialog.getByRole("heading", {
      name: "Google Workspace",
    }),
  ).toBeVisible();
  await expect(recurringDialog).toContainText("Known subscription service");
  await expect(
    recurringDialog.getByRole("heading", {
      name: "Supporting transactions",
    }),
  ).toBeVisible();

  await page.goto(
    `/recurring?stream=${DEMO_IDS.recurring.googleWorkspace}`,
  );
  await expect(
    page
      .locator("dialog[open][data-detail-dialog]")
      .getByRole("heading", {
        name: "Google Workspace",
      }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Frequent spending" }),
  ).toBeVisible();
  await expect(page.getByText("Shell Oil", { exact: true })).toBeVisible();
});

test("multi-object review stays on insight detail with linked evidence", async ({
  page,
}) => {
  await page.goto("/insights");
  const duplicate = insightCard(
    page,
    "Check whether you need both Apple subscriptions",
  );
  await duplicate.locator(".insight-card__solve").click();

  await expect(page).toHaveURL(
    new RegExp(
      `/insights\\?finding=${DEMO_IDS.insights.subscriptionDuplicate}$`,
    ),
  );
  const detail = page.locator(".selected-detail--insight");
  await expect(
    detail.getByRole("heading", {
      name: "Check whether you need both Apple subscriptions",
    }),
  ).toBeVisible();
  await expect(
    detail.getByRole("link", { name: /Apple Services/ }),
  ).toHaveAttribute(
    "href",
    `/recurring?item=${DEMO_IDS.recurring.appleServices}`,
  );
  await expect(
    detail.getByRole("link", { name: /iCloud\+/ }),
  ).toHaveAttribute(
    "href",
    `/recurring?item=${DEMO_IDS.recurring.iCloud}`,
  );
});

test("incorrect feedback sends a structured reason code", async ({
  page,
}) => {
  let requestBody;
  await page.route(
    `**/api/v1/insights/${DEMO_IDS.insights.subscriptionExpensive}/actions/report_incorrect`,
    async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated: true, state: "bad" }),
      });
    },
  );
  await page.goto("/insights");
  const card = insightCard(
    page,
    "Decide whether Google Workspace is worth it",
  );
  await card
    .getByLabel(
      "Actions for Decide whether Google Workspace is worth it",
    )
    .click();
  await card.getByRole("button", { name: "Not a subscription" }).click();

  await expect.poll(() => requestBody).toEqual({
    reason_code: "not_subscription",
  });
});

test("bulk insight selection applies one action to the exact checked findings", async ({
  page,
}) => {
  let requestBody;
  await page.route("**/api/v1/insights/batch-action", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updated: true, updated_count: 2 }),
    });
  });

  await page.goto("/insights");
  await page.getByRole("button", { name: "Select multiple" }).click();

  const dining = page.getByRole("checkbox", {
    name: "Select Spend less on Dining",
  });
  const subscription = page.getByRole("checkbox", {
    name: "Select Decide whether Google Workspace is worth it",
  });
  await expect(dining).toBeVisible();
  await expect(subscription).toBeVisible();
  await dining.check();
  await subscription.check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(page.locator("[data-insight-select-all]")).toHaveJSProperty(
    "indeterminate",
    true,
  );

  const action = page.locator("[data-insight-bulk-action]");
  const reason = page.locator("[data-insight-bulk-reason]");
  const apply = page.locator("[data-insight-bulk-apply]");
  await action.selectOption("report_incorrect");
  await expect(reason).toBeVisible();
  await expect(apply).toBeDisabled();
  const notSubscription = reason.locator(
    'option[value="not_subscription"]',
  );
  await expect(notSubscription).toHaveAttribute("disabled", "");
  await expect(notSubscription).toHaveAttribute("hidden", "");
  await reason.selectOption("wrong_interpretation");
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect.poll(() => requestBody).toEqual({
    finding_ids: [
      DEMO_IDS.insights.weeklyDining,
      DEMO_IDS.insights.subscriptionExpensive,
    ],
    action: "report_incorrect",
    reason_code: "wrong_interpretation",
  });
});

test("bulk selection keeps checkboxes in the card corner and resets cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 860 });
  await page.goto("/insights");
  const start = page.getByRole("button", { name: "Select multiple" });
  await start.click();

  const card = insightCard(page, "Spend less on Dining");
  const checkbox = card.getByRole("checkbox", {
    name: "Select Spend less on Dining",
  });
  const [cardBox, checkboxBox] = await Promise.all([
    card.boundingBox(),
    checkbox.boundingBox(),
  ]);
  expect(cardBox).not.toBeNull();
  expect(checkboxBox).not.toBeNull();
  expect(checkboxBox.y - cardBox.y).toBeLessThanOrEqual(24);
  expect(
    cardBox.x + cardBox.width - (checkboxBox.x + checkboxBox.width),
  ).toBeLessThanOrEqual(24);

  await checkbox.check();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(checkbox).toBeHidden();
  await expect(start).toBeFocused();
  await expect(
    card.getByLabel("Actions for Spend less on Dining"),
  ).toBeVisible();
  await expect(page.locator("main[data-bulk-insights]")).not.toHaveAttribute(
    "data-insight-selection-mode",
    "",
  );
});

test("archived insights can be restored together without losing the archive view", async ({
  page,
}) => {
  let requestBody;
  await page.route("**/api/v1/insights/batch-action", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updated: true, updated_count: 2 }),
    });
  });

  await page.goto("/insights?view=archive");
  await page.getByRole("button", { name: "Select multiple" }).click();
  await page
    .getByRole("checkbox", { name: "Select Spend less on Dining" })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Select Check whether you need both Apple subscriptions",
    })
    .check();

  const action = page.locator("[data-insight-bulk-action]");
  await expect(action.locator('option[value="archive"]')).toHaveCount(0);
  await expect(action.locator('option[value="ignore"]')).toHaveCount(0);
  await action.selectOption("restore");
  await page.locator("[data-insight-bulk-apply]").click();

  await expect.poll(() => requestBody).toEqual({
    finding_ids: [
      "ins_week_archive_001",
      "ins_sub_archive_001",
    ],
    action: "restore",
  });
  await expect(page).toHaveURL(/\/insights\?view=archive$/);
});
