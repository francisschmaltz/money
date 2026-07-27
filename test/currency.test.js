import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMinorMoney,
  majorUnits,
} from "../app/currency.js";

test("money formatting honors ISO zero- and three-decimal minor units", () => {
  assert.equal(majorUnits(1_234, "JPY"), 1_234);
  assert.equal(majorUnits(1_234, "BHD"), 1.234);
  assert.equal(
    formatMinorMoney({ amount_minor: 1_234, currency: "JPY" }),
    "¥1,234",
  );
  assert.match(
    formatMinorMoney({ amount_minor: 1_234, currency: "BHD" }),
    /1\.234/,
  );
});
