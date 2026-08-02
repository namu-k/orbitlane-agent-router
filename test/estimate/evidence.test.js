import assert from "node:assert/strict";
import test from "node:test";

import { reduceModelEvidence } from "../../src/estimate/evidence.js";

test("mixed observed and inferred model buckets retain the weaker evidence", () => {
  assert.equal(reduceModelEvidence([
    { model_source: "observed" },
    { model_source: "inferred" },
  ]), "inferred");
});

test("all resolved model buckets retain resolved evidence", () => {
  assert.equal(reduceModelEvidence([
    { model_source: "resolved" },
    { model_source: "resolved" },
  ]), "resolved");
});
