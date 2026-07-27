import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";

function appWith(service, events) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "admin-1", isAdmin: true };
    next();
  });
  app.use(
    createApiRouter({
      appleCardImportService: service,
      requireAdmin(request, response, next) {
        events.push(["admin", request.path]);
        if (request.get("x-test-admin") !== "yes") {
          response.status(403).json({ error: "forbidden" });
          return;
        }
        next();
      },
      requireCsrf(request, response, next) {
        events.push(["csrf", request.path]);
        if (request.get("x-csrf-token") !== "test") {
          response.status(403).json({ error: "csrf" });
          return;
        }
        next();
      },
    }),
  );
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode || 500).json({
      message: error.expose ? error.message : "failed",
    });
  });
  return app;
}

const headers = {
  "x-test-admin": "yes",
  "x-csrf-token": "test",
};

test("Apple Card endpoints are admin-only, CSRF-protected, and pass no filename", async () => {
  const events = [];
  const service = {
    async preview(input) {
      events.push(["preview", input]);
      return { preview_digest: "a".repeat(64), new_row_count: 1 };
    },
    async import(input, actor) {
      events.push(["import", input, actor]);
      return { new_row_count: 1, existing_row_count: 0 };
    },
    async updateAccount(input, actor) {
      events.push(["update", input, actor]);
      return { updated: true };
    },
    async remove(input) {
      events.push(["remove", input]);
      return true;
    },
  };
  const app = appWith(service, events);
  const file = Buffer.from("synthetic csv");

  await request(app)
    .post("/api/v1/apple-card/imports/preview")
    .set(headers)
    .attach("file", file, "synthetic.csv")
    .expect(200);
  await request(app)
    .post("/api/v1/apple-card/imports")
    .set(headers)
    .field("preview_digest", "a".repeat(64))
    .field("balance", "12.34")
    .field("credit_limit", "1000.00")
    .field("balance_as_of", "2026-07-27")
    .attach("file", file, "synthetic.csv")
    .expect(201);
  await request(app)
    .patch("/api/v1/apple-card/account")
    .set(headers)
    .send({
      balance: "-1.00",
      credit_limit: "1000.00",
      balance_as_of: "2026-07-27",
    })
    .expect(200);
  await request(app)
    .delete("/api/v1/apple-card/connection")
    .set(headers)
    .send({ retain_history: true })
    .expect(204);

  assert.equal(
    events.filter(([event]) => event === "admin").length,
    4,
  );
  assert.equal(
    events.filter(([event]) => event === "csrf").length,
    4,
  );
  const previewInput = events.find(([event]) => event === "preview")[1];
  assert.ok(Buffer.isBuffer(previewInput.fileBuffer));
  assert.deepEqual(Object.keys(previewInput), ["fileBuffer", "fields"]);
  const importInput = events.find(([event]) => event === "import")[1];
  assert.equal(importInput.previewDigest, "a".repeat(64));
  assert.equal(importInput.balance, "12.34");
  assert.equal(importInput.creditLimit, "1000.00");
  assert.equal(importInput.balanceAsOf, "2026-07-27");
});

test("Apple Card multipart routes reject missing admin, CSRF, extra files, and oversized bytes", async () => {
  const events = [];
  const app = appWith(
    {
      async preview() {
        assert.fail("invalid uploads must not reach the service");
      },
    },
    events,
  );

  await request(app)
    .post("/api/v1/apple-card/imports/preview")
    .set("x-csrf-token", "test")
    .attach("file", Buffer.from("x"), "synthetic.csv")
    .expect(403);
  await request(app)
    .post("/api/v1/apple-card/imports/preview")
    .set("x-test-admin", "yes")
    .attach("file", Buffer.from("x"), "synthetic.csv")
    .expect(403);
  await request(app)
    .post("/api/v1/apple-card/imports/preview")
    .set(headers)
    .attach("file", Buffer.from("x"), "one.csv")
    .attach("file", Buffer.from("y"), "two.csv")
    .expect(400);
  await request(app)
    .post("/api/v1/apple-card/imports/preview")
    .set(headers)
    .attach("file", Buffer.alloc(2 * 1024 * 1024 + 1), "large.csv")
    .expect(413);
});
