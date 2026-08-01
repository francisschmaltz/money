import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Settings shows insight state and wires run and clear controls", async ({
  page,
}) => {
  let toggleRequest;
  let runRequest;
  let clearRequest;
  await page.route(
    "**/api/v1/settings/insights/status",
    async (route) => {
      toggleRequest = route.request();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          updated: true,
          enabled: false,
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights/run",
    async (route) => {
      runRequest = route.request();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          queued: true,
          job_id: "job-manual",
          status: "queued",
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights",
    async (route) => {
      clearRequest = route.request();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cleared: true,
          findings_deleted: 10,
          feedback_preserved: true,
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const card = page.locator("[data-insight-admin]");
  await expect(
    card.getByRole("heading", { name: "Insight status" }),
  ).toBeVisible();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await expect(card.getByText("Last run", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Next scheduled run", { exact: true }),
  ).toBeVisible();

  await card.getByRole("button", { name: "Pause insights" }).click();
  await expect(card.getByRole("status")).toContainText(
    "Insights paused.",
  );
  expect(toggleRequest.method()).toBe("PUT");
  expect(toggleRequest.headers()["x-csrf-token"]).toBeTruthy();
  expect(toggleRequest.postDataJSON()).toEqual({ enabled: false });

  await page.reload();

  const refreshedCard = page.locator("[data-insight-admin]");
  const runInsights = refreshedCard.getByRole("button", {
    name: "Run insights now",
  });
  await runInsights.focus();
  await page.keyboard.press("Enter");
  await expect(refreshedCard.getByRole("status")).toContainText(
    "Insight run queued.",
  );
  expect(runRequest.method()).toBe("POST");
  expect(runRequest.headers()["x-csrf-token"]).toBeTruthy();

  await page.goto("/settings#insights");
  const clearOpen = page
    .locator("[data-insight-admin]")
    .getByRole("button", { name: "Clear all insights" });
  const clearDialog = page.locator("[data-insights-clear-dialog]");
  await clearOpen.focus();
  await page.keyboard.press("Enter");
  await expect(clearDialog).toBeVisible();
  await expect(clearDialog).toContainText(
    "Feedback, ignored patterns, and classification corrections remain",
  );
  await page.keyboard.press("Escape");
  await expect(clearDialog).toBeHidden();
  await expect(clearOpen).toBeFocused();

  await page.keyboard.press("Enter");
  await clearDialog
    .getByRole("button", { name: /^Clear \d+ insights?$/ })
    .click();
  await expect(
    clearDialog.locator("[data-insights-clear-dialog-status]"),
  ).toHaveText("Insights cleared.");
  expect(clearRequest.method()).toBe("DELETE");
  expect(clearRequest.headers()["x-csrf-token"]).toBeTruthy();
});

test("failed insight clearing stays visible and actionable in the dialog", async ({
  page,
}) => {
  let releaseRequest;
  await page.route(
    "**/api/v1/settings/insights",
    async (route) => {
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Insights are busy. Try again.",
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const clearOpen = page.getByRole("button", {
    name: "Clear all insights",
  });
  const dialog = page.locator("[data-insights-clear-dialog]");
  const status = dialog.locator(
    "[data-insights-clear-dialog-status]",
  );
  const clear = dialog.getByRole("button", {
    name: /^Clear \d+ insights?$/,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel" });

  await clearOpen.click();
  await clear.click();
  await expect(status).toHaveText("Clearing insights…");
  await expect(clear).toBeDisabled();
  await expect(cancel).toBeDisabled();

  await expect.poll(() => typeof releaseRequest).toBe("function");
  releaseRequest();
  await expect(status).toHaveText("Insights are busy. Try again.");
  await expect(dialog).toBeVisible();
  await expect(clear).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expect(clear).toBeFocused();

  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(clearOpen).toBeFocused();
});

test("Run insights exposes its in-flight state and ignores a second activation", async ({
  page,
}) => {
  let releaseRequest;
  let requestCount = 0;
  await page.route(
    "**/api/v1/settings/insights/run",
    async (route) => {
      requestCount += 1;
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          queued: true,
          job_id: "job-delayed",
          status: "queued",
        }),
      });
    },
  );

  await page.goto("/settings#insights");
  const card = page.locator("[data-insight-admin]");
  const run = card.getByRole("button", { name: "Run insights now" });
  await run.focus();
  await page.keyboard.press("Enter");

  await expect(run).toBeDisabled();
  await expect(card.getByRole("status")).toHaveText(
    "Queueing insight run…",
  );
  await run.evaluate((button) => button.click());
  expect(requestCount).toBe(1);

  await expect.poll(() => typeof releaseRequest).toBe("function");
  releaseRequest();
  await expect(card.getByRole("status")).toHaveText(
    "Insight run queued.",
  );
  expect(requestCount).toBe(1);
});

test("LLM ranking previews, tests, restores, and saves one canonical draft", async ({
  page,
}) => {
  const defaultGuidance =
    "Select the most useful next actions from the supplied deterministic finance findings. Use feedback only to rank or omit.";
  const previewRequests = [];
  let testRequestCount = 0;
  let testRequest;
  let saveRequest;
  let releaseTest;
  const testGate = new Promise((resolve) => {
    releaseTest = resolve;
  });

  const previewResponse = (requestBody) => {
    const isStale = requestBody.family === "investments";
    return {
      family: requestBody.family,
      request_body: {
        model: "demo-finance-ranker",
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 256,
        messages: [
          {
            role: "system",
            content: requestBody.settings.base_guidance,
          },
          {
            role: "user",
            content: JSON.stringify({
              family: requestBody.family,
              findings: [
                {
                  id: "finding_1",
                  action_title: "<img src=x onerror=alert(1)>",
                },
              ],
            }),
          },
        ],
      },
      counts: {
        candidate_count: 1,
        bad_feedback_count: 2,
        archived_feedback_count: 1,
      },
      data_as_of: "2026-07-28T19:00:00.000Z",
      data_stale: isStale,
      stale_reason: isStale
        ? "Investment data is using the last good stored findings."
        : null,
      stale_reasons: isStale
        ? ["Investment data is using the last good stored findings."]
        : [],
      estimated_input_tokens: 701,
      output_token_reserve: 256,
      estimated_total_tokens: 957,
      context_length: requestBody.settings.context_length ?? 8192,
      context_length_source:
        requestBody.settings.context_length == null
          ? "model"
          : "settings",
      utilization: { percent: 11.68, state: "normal" },
      model_state: "loaded",
      model: "demo-finance-ranker",
      destination_host: "demo.local:1234",
      last_actual_usage: {
        prompt_tokens: 680,
        completion_tokens: 41,
        total_tokens: 721,
      },
    };
  };

  await page.route(
    "**/api/v1/settings/insights/llm/preview",
    async (route) => {
      const body = route.request().postDataJSON();
      previewRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(previewResponse(body)),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights/llm/test",
    async (route) => {
      testRequestCount += 1;
      testRequest = route.request();
      const body = testRequest.postDataJSON();
      await testGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...previewResponse(body),
          status: "succeeded",
          selection: {
            leadFindingId: "finding_1",
            findingIds: ["finding_1"],
          },
          telemetry: {
            latency_ms: 184,
            finish_reason: "stop",
          },
          actual_usage: {
            prompt_tokens: 690,
            completion_tokens: 31,
            total_tokens: 721,
          },
          raw_response:
            '<img src=x onerror="document.body.dataset.pwned=1">',
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights/llm",
    async (route) => {
      saveRequest = route.request();
      const body = saveRequest.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          saved: true,
          settings: {
            ...body.settings,
            revision: body.expected_revision + 1,
          },
        }),
      });
    },
  );

  await page.goto("/settings#llm-ranking");
  const card = page.locator("[data-insight-llm-ranking]");
  await expect(
    card.getByRole("heading", { name: "LLM ranking" }),
  ).toBeVisible();
  await expect(card.locator("[data-llm-preview-status]")).toHaveText(
    "Preview updated.",
  );
  await expect(card.locator("[data-llm-request-json]")).toContainText(
    '"temperature": 0',
  );
  await expect(card.locator("[data-llm-request-json]")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(
    card.locator(".llm-ranking__payload img"),
  ).toHaveCount(0);
  await expect(card.locator("[data-llm-last-actual]")).toContainText(
    "721 total",
  );
  const contextLimit = card.getByLabel("Context limit");
  await expect(contextLimit).toHaveValue("");
  await contextLimit.fill("12000");
  await expect
    .poll(() => previewRequests.at(-1)?.settings.context_length)
    .toBe(12000);
  await expect(card.locator("[data-llm-context-length]")).toHaveText(
    "12,000 tokens · Settings override",
  );
  await expect(card.locator("[data-llm-request-json]")).not.toContainText(
    '"context_length"',
  );

  const family = card.getByLabel("Request family");
  await family.selectOption("investments");
  await expect(
    card.locator('[data-llm-family-panel="investments"]'),
  ).toBeVisible();
  await expect(card.locator("[data-llm-stale-notice]")).toContainText(
    "Investment data is using the last good stored findings.",
  );

  const baseGuidance = card.getByLabel("Base ranking guidance");
  await baseGuidance.fill(
    'Rank <img src=x onerror="document.body.dataset.pwned=1">',
  );
  await expect
    .poll(() => previewRequests.at(-1)?.settings.base_guidance)
    .toContain("document.body.dataset.pwned");
  await expect(card.locator("[data-llm-request-json]")).toContainText(
    "document.body.dataset.pwned",
  );
  expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();

  const restore = card.getByRole("button", {
    name: "Restore default",
  });
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(baseGuidance).toHaveValue(defaultGuidance);
  await expect(contextLimit).toHaveValue("");
  await expect(card.locator("[data-llm-action-status]")).toHaveText(
    "Default loaded. Save to activate it.",
  );

  const testDraft = card.getByRole("button", {
    name: "Test draft",
  });
  await testDraft.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-llm-action-status]")).toHaveText(
    "Testing draft…",
  );
  await expect(testDraft).toBeDisabled();
  await expect.poll(() => testRequestCount).toBe(1);
  await testDraft.evaluate((button) => button.click());
  expect(testRequestCount).toBe(1);
  releaseTest();
  await expect(card.locator("[data-llm-action-status]")).toHaveText(
    "Draft tested. Nothing was saved.",
  );
  await expect(card.locator("[data-llm-test-result]")).toBeVisible();
  await expect(card.locator("[data-llm-test-summary]")).toContainText(
    "1 validated ID",
  );
  await expect(card.locator("[data-llm-test-output]")).toContainText(
    "<img src=x",
  );
  await expect(
    card.locator(".llm-ranking__test-result img"),
  ).toHaveCount(0);
  expect(testRequest.headers()["x-csrf-token"]).toBeTruthy();
  expect(testRequest.postDataJSON().settings.context_length).toBeNull();

  await baseGuidance.fill("Prefer urgent, actionable findings.");
  await contextLimit.fill("16384");
  const save = card.getByRole("button", { name: "Save guidance" });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-llm-saved-revision]")).toHaveText(
    "2",
  );
  await expect(card.locator("[data-llm-action-status]")).toContainText(
    "Guidance saved as revision 2.",
  );
  const savedBody = saveRequest.postDataJSON();
  expect(savedBody).toMatchObject({
    expected_revision: 1,
    settings: {
      base_guidance: "Prefer urgent, actionable findings.",
      candidate_limit: 5,
      result_limit: 3,
      feedback_mode: "bad_and_archived",
      feedback_limit: 12,
      context_length: 16384,
    },
  });
  expect(savedBody.settings.family_guidance).toEqual({
    weekly: "",
    investments: "",
    subscriptions: "",
  });
  expect(saveRequest.method()).toBe("PUT");
  expect(saveRequest.headers()["x-csrf-token"]).toBeTruthy();
});

test("LLM draft failures and revision conflicts stay explicit", async ({
  page,
}) => {
  await page.route(
    "**/api/v1/settings/insights/llm/preview",
    async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          family: body.family,
          request_body: { messages: [] },
          counts: {
            candidate_count: 1,
            bad_feedback_count: 0,
            archived_feedback_count: 0,
          },
          data_as_of: "2026-07-28T19:00:00.000Z",
          data_stale: false,
          estimated_input_tokens: 9000,
          output_token_reserve: 256,
          estimated_total_tokens: 9256,
          context_length: 8192,
          utilization: { percent: 113, state: "over" },
          last_actual_usage: null,
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights/llm/test",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "context_error",
          selection: null,
          telemetry: {
            finish_reason: null,
            latency_ms: 75,
          },
          actual_usage: null,
          raw_response: "context length exceeded",
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/settings/insights/llm",
    async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "insight_llm_revision_conflict",
          message:
            "The LLM ranking settings changed. Refresh and try again.",
          current_settings: { revision: 2 },
        }),
      });
    },
  );

  await page.goto("/settings#llm-ranking");
  const card = page.locator("[data-insight-llm-ranking]");
  await expect(card.locator("[data-llm-utilization]")).toContainText(
    "Likely over context",
  );
  await expect(card.locator("[data-llm-last-actual]")).toHaveText(
    "Unavailable",
  );

  await card.getByRole("button", { name: "Test draft" }).click();
  await expect(card.locator("[data-llm-action-status]")).toHaveText(
    "Draft test failed: the request exceeded the model context. Nothing was saved.",
  );
  await expect(card.locator("[data-llm-test-output]")).toHaveText(
    "context length exceeded",
  );

  await card.getByRole("button", { name: "Save guidance" }).click();
  await expect(card.locator("[data-llm-action-status]")).toHaveText(
    "These settings changed elsewhere. Refresh before saving.",
  );
  await expect(card.locator("[data-llm-saved-revision]")).toHaveText(
    "1",
  );
});

for (const width of [390, 1024]) {
  test(`LLM ranking is accessible and contained at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings#llm-ranking");
    const card = page.locator("[data-insight-llm-ranking]");
    await expect(card).toBeVisible();
    await expect(card.getByLabel("Base ranking guidance")).toBeVisible();
    await expect(card.getByLabel("Context limit")).toBeVisible();
    await expect(
      card.getByLabel("Locked LLM response contract"),
    ).toBeVisible();

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(layout.root).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.body).toBeLessThanOrEqual(layout.viewport + 1);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
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
