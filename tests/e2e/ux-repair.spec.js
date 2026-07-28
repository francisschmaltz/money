import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const repairedRoutes = [
  "/",
  "/plan",
  "/insights",
  "/transactions?period=90",
  "/recurring",
  "/portfolio",
  "/credit",
  "/accounts",
  "/search",
  "/settings",
  "/format-rules",
  "/format-rules/categories",
  "/login",
  "/empty",
  "/error?request_id=ux-repair",
  "/plaid/oauth",
];

const targetTransactionWidths = [
  1120,
  1024,
  901,
  900,
  760,
  641,
  640,
  390,
  320,
];

const wcag22Tags = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function gotoSettled(page, path) {
  const response = await page.goto(path);
  const intentionalErrorState =
    new URL(path, "http://money.test").pathname === "/error" &&
    response?.status() === 503;
  expect(
    response?.ok() || intentionalErrorState,
    `${path} should render its expected state`,
  ).toBe(true);
  await settle(page);
}

async function gotoVisual(page, path) {
  await gotoSettled(page, path);
  await page
    .locator("[data-site-header], .settings-nav")
    .evaluateAll((stickyControls) => {
      stickyControls.forEach((control) => control.remove());
    });
  await expect(
    page.locator("[data-site-header], .settings-nav"),
  ).toHaveCount(0);
  await settle(page);
}

async function horizontalLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const widest = [...document.body.querySelectorAll("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          (bounds.right > window.innerWidth + 1 || bounds.left < -1)
        );
      })
      .slice(0, 8)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          selector: [
            element.tagName.toLowerCase(),
            element.id ? `#${element.id}` : "",
            [...element.classList]
              .slice(0, 3)
              .map((name) => `.${name}`)
              .join(""),
          ].join(""),
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width),
        };
      });

    return {
      viewport: root.clientWidth,
      root: root.scrollWidth,
      body: document.body.scrollWidth,
      widest,
    };
  });
}

async function documentOverflow(page, path) {
  await gotoSettled(page, path);
  const layout = await horizontalLayout(page);
  if (
    layout.root <= layout.viewport + 1 &&
    layout.body <= layout.viewport + 1
  ) {
    return null;
  }
  return {
    path,
    viewport: layout.viewport,
    root: layout.root,
    body: layout.body,
    widest: layout.widest,
  };
}

async function expectSelected(locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const pressed = element.getAttribute("aria-pressed");
        const current = element.getAttribute("aria-current");
        return pressed === "true" || current === "true" || current === "page";
      }),
    )
    .toBe(true);
}

function explorerGroup(explorer, name) {
  return explorer
    .locator("[data-spending-group]")
    .filter({ hasText: new RegExp(name, "i") })
    .first();
}

test.describe("@ux-stress Money UX repair", () => {
  test.skip(
    process.env.DEMO_SCENARIO !== "ux-stress",
    "The hostile-data regressions run in the dedicated ux-stress pass.",
  );

  test.use({
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "America/Los_Angeles",
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    test(`all repaired routes avoid horizontal overflow at ${viewport.width}px`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);

      const errors = [];
      let activePath = "";
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        const expectedErrorResponse =
          activePath.startsWith("/error") &&
          /Failed to load resource.*503/i.test(message.text());
        if (message.type() === "error" && !expectedErrorResponse) {
          errors.push(message.text());
        }
      });

      const overflows = [];
      for (const path of repairedRoutes) {
        activePath = path;
        const overflow = await documentOverflow(page, path);
        if (overflow) overflows.push(overflow);
      }

      expect(overflows, "Repaired routes must not widen the document").toEqual(
        [],
      );
      expect(errors, "Repaired routes should not raise page or console errors").toEqual(
        [],
      );
    });
  }

  test("transaction filters stay labeled and contained at every target breakpoint", async ({
    page,
  }) => {
    test.setTimeout(75_000);

    for (const width of targetTransactionWidths) {
      await page.setViewportSize({ width, height: 900 });
      await gotoSettled(page, "/transactions?period=90");

      const form = page.locator("[data-transaction-filter]");
      const fields = form.locator(".transaction-filter__fields");
      await expect(form).toBeVisible();
      await expect(form.getByText("Search", { exact: true })).toBeVisible();
      for (const [name, selector] of Object.entries({
        Timeline: 'select[name="period"]',
        Category: 'select[name="category"]',
        Account: 'select[name="account"]',
        Sort: 'select[name="sort"]',
      })) {
        const control = form.locator(selector);
        await expect(control).toBeVisible();
        await expect(
          control
            .locator("xpath=ancestor::label[1]")
            .locator(".filter-field-label"),
        ).toHaveText(name);
      }

      const metrics = await form.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const actions = element.querySelector(
          ".transaction-filter__actions",
        );
        const searchControl = element.querySelector(
          ".transaction-filter__search-control",
        );
        const apply = actions?.querySelector(
          "[data-transaction-filter-submit]",
        );
        const controls = [
          ...element.querySelectorAll(
            'input:not([type="hidden"]), select, button, a.button',
          ),
        ];
        const fieldsElement = element.querySelector(
          ".transaction-filter__fields",
        );
        const columns = getComputedStyle(fieldsElement)
          .gridTemplateColumns.trim()
          .split(/\s+/)
          .filter(Boolean).length;
        const fieldsBounds = fieldsElement.getBoundingClientRect();
        const searchBounds = searchControl.getBoundingClientRect();
        const applyBounds = apply.getBoundingClientRect();
        const tabOrder = [
          ...element.querySelectorAll(
            'select, input:not([type="hidden"]), button[type="submit"]',
          ),
        ].map(
          (control) =>
            control.getAttribute("name") ||
            control.textContent.trim(),
        );
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: document.documentElement.clientWidth,
          actionChildren: actions?.children.length ?? 0,
          columns,
          fieldsBottom: fieldsBounds.bottom,
          searchTop: searchBounds.top,
          searchBottom: searchBounds.bottom,
          searchRight: searchBounds.right,
          applyBottom: applyBounds.bottom,
          applyLeft: applyBounds.left,
          tabOrder,
          controls: controls.map((control) => {
            const controlBounds = control.getBoundingClientRect();
            return {
              name:
                control.getAttribute("name") ||
                control.textContent.trim() ||
                control.tagName,
              left: controlBounds.left,
              right: controlBounds.right,
              height: controlBounds.height,
            };
          }),
        };
      });

      expect(metrics.left).toBeGreaterThanOrEqual(-1);
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport + 1);
      expect(metrics.actionChildren).toBe(1);
      expect(metrics.tabOrder).toEqual([
        "period",
        "category",
        "account",
        "sort",
        "q",
        "Apply",
      ]);
      expect(metrics.searchTop).toBeGreaterThan(metrics.fieldsBottom);
      expect(
        Math.abs(metrics.searchBottom - metrics.applyBottom),
      ).toBeLessThanOrEqual(1);
      expect(metrics.searchRight).toBeLessThanOrEqual(metrics.applyLeft);
      for (const control of metrics.controls) {
        expect(
          control.left,
          `${control.name} escaped the filter at ${width}px`,
        ).toBeGreaterThanOrEqual(metrics.left - 1);
        expect(
          control.right,
          `${control.name} escaped the filter at ${width}px`,
        ).toBeLessThanOrEqual(metrics.right + 1);
        expect(
          control.height,
          `${control.name} is too small at ${width}px`,
        ).toBeGreaterThanOrEqual(43);
      }

      if (width >= 641) {
        expect(metrics.columns).toBe(4);
      } else if (width <= 640) {
        expect(metrics.columns).toBe(1);
      }

      const layout = await horizontalLayout(page);
      expect(layout.root).toBeLessThanOrEqual(layout.viewport + 1);
    }
  });

  test("header search keeps its shortcut on desktop and becomes a 44px mobile target", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await gotoSettled(page, "/");

    const search = page.locator(".search-trigger");
    const geometry = () => search.evaluate((control) => {
      const bounds = control.getBoundingClientRect();
      const shortcut = control.querySelector(".keyboard-hint");
      const visibleChildren = [...control.children].filter(
        (child) => getComputedStyle(child).display !== "none",
      );
      return {
        width: bounds.width,
        height: bounds.height,
        shortcutDisplay: getComputedStyle(shortcut).display,
        childrenContained: visibleChildren.every((child) => {
          const childBounds = child.getBoundingClientRect();
          return (
            childBounds.left >= bounds.left - 1 &&
            childBounds.right <= bounds.right + 1 &&
            childBounds.top >= bounds.top - 1 &&
            childBounds.bottom <= bounds.bottom + 1
          );
        }),
      };
    });
    const desktopGeometry = await geometry();
    expect(desktopGeometry.width).toBeGreaterThan(44);
    expect(desktopGeometry.height).toBe(44);
    expect(desktopGeometry.shortcutDisplay).not.toBe("none");
    expect(desktopGeometry.childrenContained).toBe(true);
    await search.hover();
    expect((await geometry()).childrenContained).toBe(true);
    await search.focus();
    expect((await geometry()).childrenContained).toBe(true);

    await page.setViewportSize({ width: 390, height: 800 });
    const mobileGeometry = await geometry();
    expect(mobileGeometry.width).toBe(44);
    expect(mobileGeometry.height).toBe(44);
    expect(mobileGeometry.shortcutDisplay).toBe("none");
    expect(mobileGeometry.childrenContained).toBe(true);
  });

  test("budget total row stays square in view and edit modes", async ({
    page,
  }) => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/plan", "/plan?edit_budget=1"]) {
        await gotoSettled(page, path);
        await expect(page.locator(".budget-row--total")).toHaveCSS(
          "border-radius",
          "0px",
        );
      }
    }
  });

  test("spending explorer preserves the ledger and restores state through Back and Forward", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await gotoSettled(page, "/transactions?period=90");

    const explorer = page.locator("[data-spending-explorer]");
    await expect(explorer).toBeVisible();
    const ledgerCount = await page.locator(".transaction-row").count();
    expect(ledgerCount).toBeGreaterThan(0);

    const categoryGroup = explorerGroup(explorer, "Category");
    const merchantGroup = explorerGroup(explorer, "Merchant");
    await expect(categoryGroup).toBeVisible();
    await expect(merchantGroup).toBeVisible();
    for (const control of [categoryGroup, merchantGroup]) {
      expect(
        await control.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBeGreaterThanOrEqual(43);
    }

    await merchantGroup.click();
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expectSelected(merchantGroup);

    const segment = explorer
      .locator("[data-spending-segment]")
      .filter({ hasNotText: /^Other$/i })
      .nth(1);
    await expect(segment).toBeVisible();
    const beforeChart = await explorer
      .locator("[data-spending-line-chart]")
      .evaluate((canvas) => ({
        aria: canvas.getAttribute("aria-label"),
        values: canvas.dataset.values,
      }));

    await segment.press("Enter");
    await expect(page).toHaveURL(/analytics_segment=[^&]+/);
    await expectSelected(segment);
    await expect(page.locator(".transaction-row")).toHaveCount(ledgerCount);

    const afterChart = await explorer
      .locator("[data-spending-line-chart]")
      .evaluate((canvas) => ({
        aria: canvas.getAttribute("aria-label"),
        values: canvas.dataset.values,
      }));
    expect(afterChart).not.toEqual(beforeChart);

    const selectedSegmentControl = explorer
      .locator("[data-spending-segment-item].is-selected")
      .locator("[data-spending-segment]");
    expect(
      await selectedSegmentControl.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(55);
    await expect(
      explorer.locator(".spending-detail-category__filter"),
    ).toHaveCount(0);
    await expect(
      explorer.getByText("Show matching transactions", { exact: true }),
    ).toHaveCount(0);
    await expect(
      explorer.getByText("Remaining groups combined", { exact: true }),
    ).toHaveCount(0);
    const resetControl = explorer.locator(
      "[data-spending-segment-reset]",
    );
    await expect(resetControl).toBeVisible();
    expect(
      await resetControl.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(43);
    expect(new URL(page.url()).searchParams.has("q")).toBe(false);

    await page.goBack();
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expect(page).not.toHaveURL(/analytics_segment=/);
    await expect(page.locator(".transaction-row")).toHaveCount(ledgerCount);

    await page.goBack();
    await expect(page).not.toHaveURL(/analytics_group=merchant/);
    await expectSelected(categoryGroup);

    await page.goForward();
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expect(page).not.toHaveURL(/analytics_segment=/);
    await expectSelected(merchantGroup);

    await page.goForward();
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expect(page).toHaveURL(/analytics_segment=[^&]+/);
    await expectSelected(segment);
    await expect(page.locator(".transaction-row")).toHaveCount(ledgerCount);

    await page.locator(".transaction-row").first().click();
    await expect(page).toHaveURL(/transaction=/);
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expect(page).toHaveURL(/analytics_segment=[^&]+/);
    await page
      .getByRole("button", { name: "Close transaction details" })
      .click();
    await expect(page).not.toHaveURL(/transaction=/);
    await expect(page).toHaveURL(/analytics_group=merchant/);
    await expect(page).toHaveURL(/analytics_segment=[^&]+/);
  });

  test("clicking a spending chart segment mirrors the accessible segment controls", async ({
    page,
  }) => {
    await gotoSettled(page, "/transactions?period=90");

    const explorer = page.locator("[data-spending-explorer]");
    const canvas = explorer.locator("[data-spending-breakdown-chart]");
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    await canvas.scrollIntoViewIfNeeded();
    const ledgerCount = await page.locator(".transaction-row").count();
    const point = await canvas.evaluate((element) => {
      const chart = element.moneyChart;
      const arc = chart?.getDatasetMeta(0)?.data?.[0];
      if (!arc) return null;
      const center = arc.getCenterPoint();
      return {
        x: center.x,
        y: center.y,
        label: chart.data.labels[0],
      };
    });
    expect(point).not.toBeNull();
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();

    await page.mouse.click(
      bounds.x + point.x,
      bounds.y + point.y,
    );

    await expect(page).toHaveURL(/analytics_segment=[^&]+/);
    await expect(
      explorer.locator("[data-spending-selection-status]"),
    ).toContainText(point.label);
    await expect(
      explorer.locator("[data-spending-segment][aria-current='true']"),
    ).toContainText(point.label);
    await expect(page.locator(".transaction-row")).toHaveCount(ledgerCount);
  });

  test("income-only results explain the spending exclusion instead of drawing a fake zero chart", async ({
    page,
  }) => {
    await gotoSettled(
      page,
      "/transactions?period=90&q=Acme%20Payroll",
    );

    await expect(
      page.locator(".transaction-row").filter({ hasText: "Acme Payroll" }),
    ).toBeVisible();
    const spendingCard = page.locator(".spending-detail-card");
    const emptyState = spendingCard.locator("[data-spending-empty]");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText(
      /income|transfer|pending|excluded|not included in spending/i,
    );
    await expect(spendingCard.locator(".card-total")).toHaveCount(0);
    await expect(spendingCard.locator("canvas")).toHaveCount(0);
  });

  test("missing Chart.js keeps numeric summaries and renders an explicit fallback on every chart surface", async ({
    page,
  }) => {
    await page.route("**/vendor/chart/chart.umd.js", (route) => route.abort());
    for (const { path, summary } of [
      {
        path: "/transactions?period=90",
        summary: ".spending-detail-card .card-total strong",
      },
      { path: "/", summary: ".summary-card .display-money" },
      { path: "/portfolio", summary: ".portfolio-hero .display-money" },
      { path: "/credit", summary: "#credit-utilization-heading" },
    ]) {
      await gotoSettled(page, path);
      await expect(page.locator(summary).first()).not.toBeEmpty();
      const canvases = page.locator("canvas[data-chart]");
      const canvasCount = await canvases.count();
      expect(canvasCount, `${path} should render a chart`).toBeGreaterThan(0);
      await expect(
        page.getByText(
          "Chart unavailable. The numeric summary is still current.",
          { exact: true },
        ),
      ).toHaveCount(canvasCount);
      for (let index = 0; index < canvasCount; index += 1) {
        await expect(canvases.nth(index)).toBeHidden();
      }
    }
  });

  test("portfolio timeframe is compact on desktop and scrollable with 44px targets on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await gotoSettled(page, "/portfolio?period=all");

    const desktopTimeframe = page.getByRole("navigation", {
      name: "Portfolio timeframe",
    });
    const desktopGeometry = await desktopTimeframe.evaluate((control) => {
      const heading = control.closest(".card-heading");
      const controlBounds = control.getBoundingClientRect();
      const optionBounds = control
        .querySelector("a")
        .getBoundingClientRect();
      return {
        headingTop: heading.getBoundingClientRect().top,
        controlTop: controlBounds.top,
        optionHeight: optionBounds.height,
      };
    });
    expect(
      Math.abs(desktopGeometry.controlTop - desktopGeometry.headingTop),
    ).toBeLessThanOrEqual(1);
    expect(desktopGeometry.optionHeight).toBeLessThan(44);

    await page.setViewportSize({ width: 320, height: 700 });
    await gotoSettled(page, "/portfolio?period=all");

    const timeframe = page.getByRole("navigation", {
      name: "Portfolio timeframe",
    });
    const active = timeframe.locator('[aria-current="true"]');
    await expect(timeframe).toBeVisible();
    await expect(active).toHaveText("All");

    const geometry = await timeframe.evaluate((control) => {
      const activeOption = control.querySelector('[aria-current="true"]');
      const controlBounds = control.getBoundingClientRect();
      const activeBounds = activeOption.getBoundingClientRect();
      return {
        overflowX: getComputedStyle(control).overflowX,
        optionHeights: [...control.querySelectorAll("a")].map(
          (option) => option.getBoundingClientRect().height,
        ),
        activeVisible:
          activeBounds.left >= controlBounds.left - 1 &&
          activeBounds.right <= controlBounds.right + 1,
      };
    });
    expect(["auto", "scroll"]).toContain(geometry.overflowX);
    expect(geometry.optionHeights.every((height) => height >= 44)).toBe(true);
    expect(geometry.activeVisible).toBe(true);

    await timeframe.getByRole("link", { name: "1M" }).click();
    await expect(page).toHaveURL(/period=1m/);
    await expect(
      page
        .getByRole("navigation", { name: "Portfolio timeframe" })
        .getByRole("link", { name: "1M" }),
    ).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(page).toHaveURL(/period=all/);
  });

  test("long account names reflow into two readable mobile rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await gotoSettled(page, "/accounts");

    const row = page.locator('[data-account-id="account_stress_long"]');
    await expect(row).toContainText(
      "Joint household expenses and reimbursements checking",
    );
    const geometry = await row.evaluate((element) => {
      const rowBounds = element.getBoundingClientRect();
      const identity = element
        .querySelector(".account-row__identity")
        .getBoundingClientRect();
      const balance = element
        .querySelector(".account-row__balance")
        .getBoundingClientRect();
      const actions = element
        .querySelector(".account-row__actions")
        .getBoundingClientRect();
      return {
        row: {
          left: rowBounds.left,
          right: rowBounds.right,
        },
        children: [identity, balance, actions].map((bounds) => ({
          left: bounds.left,
          right: bounds.right,
        })),
        balanceStartsBelowIdentity: balance.top >= identity.bottom - 2,
      };
    });

    expect(geometry.balanceStartsBelowIdentity).toBe(true);
    for (const child of geometry.children) {
      expect(child.left).toBeGreaterThanOrEqual(geometry.row.left - 1);
      expect(child.right).toBeLessThanOrEqual(geometry.row.right + 1);
    }
    const layout = await horizontalLayout(page);
    expect(layout.root).toBeLessThanOrEqual(layout.viewport + 1);
  });

  test("connected account actions use one contained disclosure and keep alias focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await gotoSettled(page, "/accounts");

    const menus = page.locator("[data-account-actions]");
    const first = menus.nth(0);
    const second = menus.nth(1);
    const firstTrigger = first.locator(
      "[data-account-actions-trigger]",
    );
    const secondTrigger = second.locator(
      "[data-account-actions-trigger]",
    );

    await expect(firstTrigger).toHaveAttribute(
      "aria-label",
      "Actions for Everyday checking",
    );
    await firstTrigger.click();
    await expect(first).toHaveAttribute("open", "");
    const panelGeometry = await first
      .locator(".account-row__actions-panel")
      .evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: document.documentElement.clientWidth,
        };
      });
    expect(panelGeometry.left).toBeGreaterThanOrEqual(0);
    expect(panelGeometry.right).toBeLessThanOrEqual(
      panelGeometry.viewport,
    );
    await expect(
      first.getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/settings#account-account_checking");

    await secondTrigger.click();
    await expect(first).not.toHaveAttribute("open", "");
    await expect(second).toHaveAttribute("open", "");
    await page.locator(".institution-heading h2").first().click();
    await expect(second).not.toHaveAttribute("open", "");

    await secondTrigger.click();
    await page.keyboard.press("Escape");
    await expect(second).not.toHaveAttribute("open", "");
    await expect(secondTrigger).toBeFocused();

    await firstTrigger.click();
    await first.getByRole("button", { name: /Rename Everyday checking/ }).click();
    const dialog = page.locator("[data-account-alias-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Display name").fill("Shared spending");
    await dialog.getByRole("button", { name: "Save name" }).click();

    await expect(firstTrigger).toHaveAttribute(
      "aria-label",
      "Actions for Shared spending",
    );
    await expect(firstTrigger).toBeFocused();
    await expect(
      page.locator(
        '[data-account-display-name="account_checking"]',
      ),
    ).toHaveText("Shared spending");
  });

  test("seven-digit transaction values remain intact at narrow widths", async ({
    page,
  }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await gotoSettled(page, "/transactions?period=90");
      const amount = page.getByText("-$1,234,567.89", {
        exact: true,
      });
      await expect(amount).toBeVisible();
      const geometry = await amount.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          whiteSpace: getComputedStyle(element).whiteSpace,
          viewport: document.documentElement.clientWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(
        geometry.viewport + 1,
      );
      expect(geometry.whiteSpace).toBe("nowrap");
    }
  });

  test("dashboard mobile previews keep the primary cards and cap secondary lists", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoSettled(page, "/");

    await expect(
      page.getByRole("region", { name: "Safe to Spend" }),
    ).toBeVisible();
    await expect(page.locator("[data-dashboard-balance]")).toBeVisible();
    await expect(
      page.locator("[data-dashboard-balance] .chart-frame"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Goals", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View all goals" }),
    ).toHaveAttribute("href", "/plan#goals");
    expect(
      await page
        .locator(".dashboard-preview--goals .dashboard-goal-preview:visible")
        .count(),
    ).toBeLessThanOrEqual(3);

    expect(
      await page
        .locator(".dashboard-preview--insights .insight-card:visible")
        .count(),
    ).toBeLessThanOrEqual(3);
    expect(
      await page
        .locator(".dashboard-preview--categories .category-row:visible")
        .count(),
    ).toBeLessThanOrEqual(3);
    expect(
      await page
        .locator(".dashboard-preview--transactions .transaction-row:visible")
        .count(),
    ).toBeLessThanOrEqual(3);

    await expect(
      page.getByRole("link", { name: /View all categories/i }),
    ).toHaveAttribute("href", "/transactions?period=month");
    await expect(
      page.locator(
        '.card.list-card .quiet-link[href="/transactions"]',
      ),
    ).toHaveAttribute("href", "/transactions");
  });

  for (const audit of [
    { path: "/", width: 390 },
    { path: "/transactions?period=90", width: 1024 },
    { path: "/plan", width: 390 },
    { path: "/insights", width: 1024 },
    { path: "/credit", width: 390 },
    { path: "/portfolio", width: 320 },
    { path: "/accounts", width: 320 },
    { path: "/settings#insights", width: 1024 },
    { path: "/format-rules/categories", width: 390 },
  ]) {
    test(`${audit.path} has no automated WCAG 2.2 AA violations`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: audit.width, height: 900 });
      await gotoSettled(page, audit.path);
      const results = await new AxeBuilder({ page })
        .withTags(wcag22Tags)
        .analyze();
      expect(
        results.violations,
        results.violations
          .map(
            (violation) =>
              `${violation.id}: ${violation.nodes
                .map((node) => node.target.join(" "))
                .join(", ")}`,
          )
          .join("\n"),
      ).toEqual([]);
    });
  }

  test("mobile repaired surfaces match stable visual baselines", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await gotoVisual(page, "/transactions?period=90");
    await expect(page.locator("[data-transaction-filter]")).toHaveScreenshot(
      "transactions-filter-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );
    await expect(page.locator("[data-spending-explorer]")).toHaveScreenshot(
      "transactions-explorer-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/plan");
    await expect(page.locator("#budget")).toHaveScreenshot(
      "budget-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );
    await expect(page.locator(".goal-grid")).toHaveScreenshot(
      "goals-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/settings#insights");
    await expect(page.locator("[data-insight-admin]")).toHaveScreenshot(
      "settings-insights-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/credit");
    await expect(page.locator(".credit-hero")).toHaveScreenshot(
      "credit-utilization-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/portfolio?period=1m");
    await expect(page.locator(".portfolio-hero")).toHaveScreenshot(
      "portfolio-hero-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/accounts");
    await expect(
      page.locator('[data-account-id="account_stress_long"]').locator(".."),
    ).toHaveScreenshot("long-account-mobile.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    });

    await gotoVisual(page, "/");
    await expect(page.locator(".summary-grid")).toHaveScreenshot(
      "dashboard-primary-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoSettled(page, "/");
    await page.locator("[data-mobile-menu]").click();
    await expect(page.locator("[data-site-header]")).toHaveScreenshot(
      "mobile-navigation-open.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/insights");
    await expect(page.locator(".insight-grid").first()).toHaveScreenshot(
      "insight-cards-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );

    await gotoVisual(page, "/format-rules/categories");
    await page.locator("[data-category-merge-start]").click();
    await expect(page.locator("[data-category-manager]")).toHaveScreenshot(
      "category-merge-mobile.png",
      { animations: "disabled", maxDiffPixelRatio: 0.01 },
    );
  });
});
