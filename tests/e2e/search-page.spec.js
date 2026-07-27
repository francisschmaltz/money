import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const shortcut = process.platform === "darwin" ? "Meta+k" : "Control+k";

test("deep links are server rendered and the search page owns the shortcut", async ({
  page,
}) => {
  let apiSearchRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/search") {
      apiSearchRequests += 1;
    }
  });

  await page.goto("/search?q=Apple&entity_type=transaction");

  await expect(page.getByRole("heading", { level: 1, name: "Search" })).toHaveCount(
    1,
  );
  await expect(page.locator("[data-search-page-input]")).toHaveValue("Apple");
  await expect(page.locator("[data-search-page-entity-type]")).toHaveValue(
    "transaction",
  );
  await expect(page.locator("[data-search-page-result]").first()).toBeVisible();
  expect(apiSearchRequests).toBe(0);
  await expect(page.locator("[data-search-dialog]")).toHaveCount(0);

  await page.keyboard.press(shortcut);
  await expect(page.locator("[data-search-page-input]")).toBeFocused();
});

test("typing, filters, clear, and Back keep URL and results synchronized", async ({
  page,
}) => {
  const searchApiUrls = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/search") searchApiUrls.push(url);
  });
  await page.goto("/search");
  const input = page.locator("[data-search-page-input]");
  const filter = page.locator("[data-search-page-entity-type]");

  await input.fill("Apple");
  await expect(page).toHaveURL(/\/search\?q=Apple$/);
  await expect(page.locator("[data-search-page-result]").first()).toBeVisible();
  expect(
    searchApiUrls.every((url) => url.searchParams.get("limit") === "50"),
  ).toBe(true);

  await filter.selectOption("transaction");
  await expect(page).toHaveURL(
    /\/search\?q=Apple&entity_type=transaction$/,
  );
  await expect(page.locator("[data-search-page-status]")).toContainText(
    /result/i,
  );

  await page.locator("[data-search-page-clear]").click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(input).toHaveValue("");

  await page.goBack();
  await expect(page).toHaveURL(
    /\/search\?q=Apple&entity_type=transaction$/,
  );
  await expect(input).toHaveValue("Apple");
  await expect(filter).toHaveValue("transaction");
  await expect(page.locator("[data-search-page-result]").first()).toBeVisible();
});

test("the quick modal hands its current query and filter to full search", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("a.search-trigger")).toHaveAttribute(
    "href",
    "/search",
  );

  await page.keyboard.press(shortcut);
  await expect(page.locator("[data-search-dialog]")).toBeVisible();
  await page.locator("[data-search-input]").fill("Apple");
  await page.locator("[data-search-entity-type]").selectOption("transaction");

  const fullSearch = page.locator("[data-search-full-link]");
  await expect(fullSearch).toHaveAttribute(
    "href",
    "/search?q=Apple&entity_type=transaction",
  );
  await fullSearch.click();

  await expect(page).toHaveURL(
    /\/search\?q=Apple&entity_type=transaction$/,
  );
  await expect(page.locator("[data-search-page-input]")).toHaveValue("Apple");
  await expect(page.locator("[data-search-dialog]")).toHaveCount(0);
});

test("stale responses cannot replace newer search results", async ({ page }) => {
  await page.route("**/api/search?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "Slow") {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query,
          entity_types: [],
          returned_count: 1,
          group_count: 1,
          groups: [
            {
              label: "Transactions",
              returned_count: 1,
              items: [
                {
                  title: `${query} result`,
                  meta: "Test result",
                  url: "/transactions",
                  icon: "ph-receipt",
                },
              ],
            },
          ],
        }),
      })
      .catch(() => {});
  });

  await page.goto("/search");
  const input = page.locator("[data-search-page-input]");
  await input.fill("Slow");
  await page.waitForTimeout(200);
  await input.fill("Fast");

  await expect(page.locator("[data-search-page-results]")).toContainText(
    "Fast result",
  );
  await expect(page.locator("[data-search-page-results]")).not.toContainText(
    "Slow result",
  );
});

test("an API failure is recoverable and client-rendered links stay on origin", async ({
  page,
}) => {
  let failNext = true;
  await page.route("**/api/search?**", async (route) => {
    if (failNext) {
      failNext = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "search_unavailable" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "Hostile",
        entity_types: [],
        returned_count: 1,
        group_count: 1,
        groups: [
          {
            label: "<img src=x onerror=alert(1)>",
            returned_count: 2,
            items: [
              {
                title: "<script>alert('nope')</script>",
                meta: "Still text",
                url: "/transactions?source=hostile",
                icon: "ph-receipt",
              },
              {
                title: "Unsafe external result",
                meta: "Must not render",
                url: "//evil.example/steal",
                icon: "ph-receipt",
              },
            ],
          },
        ],
      }),
    });
  });

  await page.goto("/search");
  const input = page.locator("[data-search-page-input]");
  await input.fill("Hostile");
  await expect(page.locator("[data-search-page-status]")).toContainText(
    /unavailable|try again/i,
  );

  await page.getByRole("button", { name: "Try again" }).click();
  const result = page.locator("[data-search-page-result]");
  await expect(result).toContainText("<script>alert('nope')</script>");
  await expect(result).toHaveCount(1);
  await expect(
    page.getByText("Unsafe external result", { exact: true }),
  ).toHaveCount(0);
  const remainsOnOrigin = await result.evaluate(
    (link) => new URL(link.href).origin === window.location.origin,
  );
  expect(remainsOnOrigin).toBe(true);
  await expect(page.locator("[data-search-page-results] img")).toHaveCount(0);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 660, height: 580 },
]) {
  test(`search is accessible without overflow at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/search?q=Apple");

    const duplicateIds = await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    });
    expect(duplicateIds).toEqual([]);

    const overflows = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);

    const clippedControls = await page
      .locator(
        "[data-search-page-form] input, [data-search-page-form] select, [data-search-page-form] button, [data-search-page-clear]",
      )
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            const bounds = control.getBoundingClientRect();
            return (
              bounds.left < 0 ||
              bounds.right > window.innerWidth ||
              control.scrollWidth > control.clientWidth + 1
            );
          })
          .map((control) => control.outerHTML),
      );
    expect(clippedControls).toEqual([]);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact),
      ),
    ).toEqual([]);
  });
}
