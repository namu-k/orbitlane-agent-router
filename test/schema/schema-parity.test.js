import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalLanes, claudeCapabilityMatrix } from "../../src/schema/index.js";

// The published JSON Schemas (with `$id` URLs) are consumed by external adapters,
// while index.js is the enforced/tested path. These parity tests fail if either
// source drifts from the other on the canonical facts.

const schema = async (name) => JSON.parse(
  await readFile(new URL(`../../src/schema/${name}`, import.meta.url), "utf8"),
);

const LANE_TO_DEF = { sol: "solLane", terra: "terraLane", luna: "lunaLane" };

test("contract.schema.json lane consts match the enforced canonical lanes", async () => {
  const contractSchema = await schema("contract.schema.json");
  const lanes = canonicalLanes();

  assert.deepEqual(
    contractSchema.properties.lanes.required,
    Object.keys(lanes),
    "schema required lanes must equal the canonical lane ids",
  );

  for (const [laneId, expected] of Object.entries(lanes)) {
    const def = contractSchema.$defs[LANE_TO_DEF[laneId]];
    assert.equal(def.properties.class.const, expected.class, `${laneId}.class const`);
    assert.equal(def.properties.reasoning.const, expected.reasoning, `${laneId}.reasoning const`);
  }
});

test("capability-matrix.schema.json reasoning consts match the enforced capability", async () => {
  const capabilitySchema = await schema("capability-matrix.schema.json");
  const { reasoning } = claudeCapabilityMatrix();

  for (const [field, value] of Object.entries(reasoning)) {
    assert.equal(
      capabilitySchema.properties.reasoning.properties[field].const,
      value,
      `reasoning.${field} const`,
    );
  }
});
