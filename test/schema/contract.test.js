import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditInstalledRoles,
  claudeCapabilityMatrix,
  validateContract,
  validateCapabilityMatrix,
} from "../../src/schema/index.js";

const fixture = async (name) => JSON.parse(
  await readFile(new URL(`../../fixtures/contracts/${name}`, import.meta.url), "utf8"),
);

test("accepts the canonical sol, terra, and luna lane classes", async () => {
  const result = validateContract(await fixture("valid-canonical.json"));

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("accepts a per-target model binding only when it has provenance", async () => {
  const result = validateContract(await fixture("valid-target-binding.json"));

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects a binding without provenance", async () => {
  const result = validateContract(await fixture("invalid-binding-without-provenance.json"));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /targets\.claude\.lanes\.sol\.provenance/);
});

test("rejects lanes outside the canonical id and class pair", async () => {
  const result = validateContract(await fixture("invalid-noncanonical-lane.json"));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /lanes\.sol\.class/);
});

test("reports installed roles outside the contract as unmanaged without blocking normal mode", async () => {
  const contract = await fixture("valid-canonical.json");
  const result = auditInstalledRoles(contract, ["executor", "third-party-reviewer"]);

  assert.deepEqual(result, {
    managed: ["executor"],
    unmanaged: ["third-party-reviewer"],
    errors: [],
  });
});

test("fails strict mode when an installed role is unmanaged", async () => {
  const contract = await fixture("valid-canonical.json");
  const result = auditInstalledRoles(contract, ["third-party-reviewer"], { strict: true });

  assert.deepEqual(result.errors, ["UNCLASSIFIED_ROLE: third-party-reviewer"]);
});

test("records Claude reasoning as effort supported, thinking session-inherited, and effective unproven", () => {
  assert.deepEqual(claudeCapabilityMatrix(), {
    reasoning: {
      effort: "supported",
      thinking: "session-inherited",
      effective: "unproven",
    },
  });
});

test("accepts the Claude capability fixture with the documented reasoning boundary", async () => {
  const capability = JSON.parse(
    await readFile(new URL("../../fixtures/capabilities/claude.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(validateCapabilityMatrix(capability), { valid: true, errors: [] });
});
