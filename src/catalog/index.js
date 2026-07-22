const CORE_ROLE_CATALOG = Object.freeze({
  architect: Object.freeze({ access: "read-only", lane: "sol", responsibility: "architecture and consequential judgment" }),
  critic: Object.freeze({ access: "read-only", lane: "sol", responsibility: "adversarial review of plans and judgments" }),
  executor: Object.freeze({ access: "write-and-test", lane: "terra", responsibility: "implementation, fixes, and bounded refactors" }),
  "team-executor": Object.freeze({ access: "write-and-test", lane: "terra", responsibility: "approved team execution" }),
  verifier: Object.freeze({ access: "read-and-test", lane: "terra", responsibility: "independent verification and evidence" }),
  "test-engineer": Object.freeze({ access: "write-and-test", lane: "terra", responsibility: "test design, fixtures, and regression verification" }),
  explore: Object.freeze({ access: "read-only", lane: "luna", responsibility: "bounded repository lookup" }),
});

export function stableRoleCatalog() {
  return structuredClone(CORE_ROLE_CATALOG);
}

export function assertCatalogCompatible(contract) {
  for (const [role, expected] of Object.entries(CORE_ROLE_CATALOG)) {
    const configured = contract?.roles?.[role];
    if (configured === undefined) continue;
    if (configured.lane !== expected.lane) {
      throw new TypeError(`STABLE_ROLE_CATALOG_MISMATCH: ${role} must use ${expected.lane}`);
    }
    if (configured.provenance !== "user-approved") {
      throw new TypeError(`STABLE_ROLE_CATALOG_MISMATCH: ${role} must use user-approved provenance`);
    }
  }
}
