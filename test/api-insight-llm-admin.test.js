import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";

function appWith({
  financeService,
  requireAdmin = (_request, _response, next) => next(),
  requireCsrf = (_request, _response, next) => next(),
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "admin-1", is_admin: true };
    next();
  });
  app.use(
    createApiRouter({
      financeService,
      requireAdmin,
      requireCsrf,
    }),
  );
  return app;
}

test("LLM preview, test, and save routes require admin plus CSRF", async () => {
  const calls = [];
  const middleware = [];
  const app = appWith({
    requireAdmin(request, _response, next) {
      middleware.push(`admin:${request.method}`);
      next();
    },
    requireCsrf(request, _response, next) {
      middleware.push(`csrf:${request.method}`);
      next();
    },
    financeService: {
      previewInsightLlm(input) {
        calls.push(["preview", input]);
        return { family: input.family, request_body: { model: "qwen" } };
      },
      testInsightLlmDraft(input) {
        calls.push(["test", input]);
        return { family: input.family, status: "succeeded" };
      },
      saveInsightLlmSettings(input, actor) {
        calls.push(["save", input, actor]);
        return {
          saved: true,
          settings: { revision: input.expected_revision + 1 },
        };
      },
    },
  });
  const settings = {
    base_guidance: "Rank useful findings.",
    family_guidance: {
      weekly: "",
      investments: "",
      subscriptions: "",
    },
    candidate_limit: 5,
    result_limit: 3,
    feedback_mode: "bad_and_archived",
    feedback_limit: 12,
    context_length: null,
  };

  const preview = await request(app)
    .post("/api/v1/settings/insights/llm/preview")
    .send({ family: "weekly", settings })
    .expect(200);
  const tested = await request(app)
    .post("/api/v1/settings/insights/llm/test")
    .send({ family: "weekly", settings })
    .expect(200);
  const saved = await request(app)
    .put("/api/v1/settings/insights/llm")
    .send({ expected_revision: 3, settings })
    .expect(200);

  for (const response of [preview, tested, saved]) {
    assert.match(response.headers["cache-control"], /no-store/);
  }
  assert.deepEqual(middleware, [
    "admin:POST",
    "csrf:POST",
    "admin:POST",
    "csrf:POST",
    "admin:PUT",
    "csrf:PUT",
  ]);
  assert.deepEqual(calls, [
    ["preview", { family: "weekly", settings }],
    ["test", { family: "weekly", settings }],
    [
      "save",
      { expected_revision: 3, settings },
      { id: "admin-1", is_admin: true },
    ],
  ]);
});

test("revision conflicts return the current settings with a stable code", async () => {
  const app = appWith({
    financeService: {
      saveInsightLlmSettings() {
        const error = new Error(
          "The LLM ranking settings changed. Refresh and try again.",
        );
        error.code = "INSIGHT_LLM_REVISION_CONFLICT";
        error.currentSettings = {
          revision: 5,
          base_guidance: "Current guidance",
        };
        throw error;
      },
    },
  });

  await request(app)
    .put("/api/v1/settings/insights/llm")
    .send({ expected_revision: 4, settings: {} })
    .expect(409, {
      error: "insight_llm_revision_conflict",
      message:
        "The LLM ranking settings changed. Refresh and try again.",
      current_settings: {
        revision: 5,
        base_guidance: "Current guidance",
      },
    });
});

test("denied LLM settings requests are still explicitly no-store", async () => {
  const app = appWith({
    financeService: {},
    requireAdmin(_request, response) {
      response.status(403).json({ error: "forbidden" });
    },
  });

  const response = await request(app)
    .post("/api/v1/settings/insights/llm/preview")
    .send({})
    .expect(403);

  assert.match(response.headers["cache-control"], /no-store/);
});
