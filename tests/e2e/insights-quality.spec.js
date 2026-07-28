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
  await card.locator(".insight-card__menu > summary").click();
  await card.getByRole("button", { name: "Not a subscription" }).click();

  await expect.poll(() => requestBody).toEqual({
    reason_code: "not_subscription",
  });
});
