import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1024, height: 900 },
  { width: 480, height: 900 },
]) {
  test(`portfolio cash stays consolidated at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/portfolio?period=1m&scope=all");
    await expect(
      page.getByRole("heading", { name: "Holdings" }),
    ).toBeVisible();

    const header = page.locator(".holdings-row--header");
    await expect(header).not.toContainText("Selected period");
    const cashRow = page
      .locator(".holdings-row:not(.holdings-row--header)")
      .filter({ hasText: "Cash" });
    await expect(cashRow).toHaveCount(1);

    const layout = await header.evaluate((row) => ({
      visibleCells: [...row.children].filter(
        (cell) => getComputedStyle(cell).display !== "none",
      ).length,
      rowRight: row.getBoundingClientRect().right,
      viewportRight: document.documentElement.clientWidth,
      rootWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.visibleCells).toBe(
      viewport.width > 900 ? 3 : 2,
    );
    expect(layout.rowRight).toBeLessThanOrEqual(
      layout.viewportRight + 1,
    );
    expect(layout.rootWidth).toBeLessThanOrEqual(
      layout.viewportRight + 1,
    );

    if (viewport.width === 1024) {
      await page.goto("/portfolio?period=1m&scope=trading");
      await expect(cashRow).toHaveCount(1);
      await page.goto("/portfolio?period=1m&scope=retirement");
      await expect(cashRow).toHaveCount(0);
      await page.goto("/portfolio?period=1m&scope=all");
    }

    await cashRow.click();
    await expect(page).toHaveURL(/holding=cash(?:%3A|:)USD/);
    const dialog = page.locator("[data-detail-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("By investment account");
    await expect(dialog).not.toContainText("Holding ID");
    await expect(dialog).not.toContainText("Cost basis");
  });
}
