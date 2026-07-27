import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";

function appFor(financeService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "person_1", name: "Alex" };
    next();
  });
  app.use(
    createApiRouter({
      requireAuth: (_req, _res, next) => next(),
      requireCsrf: (req, res, next) => {
        if (req.get("X-CSRF-Token") !== "csrf-test") {
          res.status(403).json({ error: "csrf" });
          return;
        }
        next();
      },
      financeService,
    }),
  );
  return app;
}

test("credit score reads are shared while every mutation requires CSRF", async () => {
  const calls = [];
  const app = appFor({
    getCreditScoreSummary(input) {
      calls.push(["read", input]);
      return { data: { people: [] } };
    },
    createCreditScoreSource(input, actor) {
      calls.push(["create", input, actor]);
      return { created: true, source: { id: "source_1" } };
    },
  });

  await request(app).get("/api/v1/credit-scores?period=1m").expect(200);
  await request(app)
    .post("/api/v1/credit-score-sources")
    .send({ label: "Experian" })
    .expect(403);
  await request(app)
    .post("/api/v1/credit-score-sources")
    .set("X-CSRF-Token", "csrf-test")
    .send({
      label: "Experian",
      bureau: "Experian",
      model: "FICO Score 8",
      user_id: "person_2",
    })
    .expect(201);

  assert.deepEqual(calls[0], [
    "read",
    { period: "1m", current_user_id: "person_1" },
  ]);
  assert.deepEqual(calls[1], [
    "create",
    {
      label: "Experian",
      bureau: "Experian",
      model: "FICO Score 8",
    },
    { id: "person_1", name: "Alex" },
  ]);
});

test("credit score routes reject invalid periods, dates, and score ranges", async () => {
  const app = appFor({
    getCreditScoreSummary() {
      throw new Error("must not be called");
    },
    upsertCreditScoreObservation() {
      throw new Error("must not be called");
    },
  });

  await request(app)
    .get("/api/v1/credit-scores?period=10y")
    .expect(400);
  await request(app)
    .put(
      "/api/v1/credit-score-sources/source_1/observations/2026-02-31",
    )
    .set("X-CSRF-Token", "csrf-test")
    .send({ score: 700 })
    .expect(400);
  await request(app)
    .put(
      "/api/v1/credit-score-sources/source_1/observations/2026-07-20",
    )
    .set("X-CSRF-Token", "csrf-test")
    .send({ score: 851 })
    .expect(400);
  await request(app)
    .post("/api/v1/credit-score-sources")
    .set("X-CSRF-Token", "csrf-test")
    .send({ label: "x".repeat(121) })
    .expect(400);
});
