const CANONICAL_LANES = Object.freeze({
  sol: Object.freeze({ class: "judgment", reasoning: "high" }),
  terra: Object.freeze({ class: "implementation", reasoning: "medium" }),
  luna: Object.freeze({ class: "bounded-retrieval", reasoning: "low" }),
});

const CLAUDE_REASONING_CAPABILITY = Object.freeze({
  reasoning: Object.freeze({
    effort: "supported",
    thinking: "session-inherited",
    effective: "unproven",
  }),
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
// A model string is interpolated directly into the marker-bounded policy block, so it
// must stay on one line and must not carry comment delimiters that could close the
// block early. Conservative on purpose: provider model names are plain tokens.
export const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isMarkerSafeModelToken(model) {
  return typeof model === "string" && MODEL_TOKEN.test(model);
}

const addUnexpectedKeys = (value, allowedKeys, path, errors) => {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
};

export function validateContract(contract) {
  return validateContractScope(contract);
}

// Adapters must validate the common contract surface, but a selected target cannot
// be held hostage by malformed bindings for an independent target. Standalone
// validation intentionally remains whole-contract via validateContract above.
export function validateContractForTarget(contract, target) {
  return validateContractScope(contract, target);
}

function validateContractScope(contract, target) {
  const errors = [];

  if (!isRecord(contract)) {
    return { valid: false, errors: ["contract must be an object"] };
  }

  addUnexpectedKeys(contract, ["contract_version", "lanes", "roles", "targets"], "contract", errors);

  if (contract.contract_version !== "1.0.0") {
    errors.push("contract_version must be 1.0.0");
  }

  validateLanes(contract.lanes, errors);
  validateRoles(contract.roles, errors);
  validateTargets(contract.targets, errors, target);

  return { valid: errors.length === 0, errors };
}

function validateLanes(lanes, errors) {
  if (!isRecord(lanes)) {
    errors.push("lanes must be an object");
    return;
  }

  addUnexpectedKeys(lanes, Object.keys(CANONICAL_LANES), "lanes", errors);

  for (const [laneId, expected] of Object.entries(CANONICAL_LANES)) {
    const lane = lanes[laneId];
    const path = `lanes.${laneId}`;

    if (!isRecord(lane)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    addUnexpectedKeys(lane, ["class", "reasoning"], path, errors);
    if (lane.class !== expected.class) {
      errors.push(`${path}.class must be ${expected.class}`);
    }
    if (lane.reasoning !== expected.reasoning) {
      errors.push(`${path}.reasoning must be ${expected.reasoning}`);
    }
  }
}

function validateRoles(roles, errors) {
  // Roles are optional: a contract can carry projection only. An empty object is a
  // mistake rather than an intent, so absent and empty are deliberately different.
  if (roles === undefined) return;
  if (!isRecord(roles) || Object.keys(roles).length === 0) {
    errors.push("roles must contain at least one role when present");
    return;
  }

  for (const [roleName, role] of Object.entries(roles)) {
    const path = `roles.${roleName}`;
    if (!ROLE_NAME.test(roleName)) errors.push(`${path} must match ${ROLE_NAME}`);
    if (!isRecord(role)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    addUnexpectedKeys(role, ["lane", "provenance"], path, errors);
    if (!Object.hasOwn(CANONICAL_LANES, role.lane)) {
      errors.push(`${path}.lane must be a canonical lane`);
    }
    if (typeof role.provenance !== "string" || role.provenance.length === 0) {
      errors.push(`${path}.provenance must be a non-empty string`);
    }
  }
}

function validateTargets(targets, errors, selectedTarget) {
  if (targets === undefined) {
    return;
  }
  if (!isRecord(targets)) {
    errors.push("targets must be an object");
    return;
  }

  const selected = selectedTarget === undefined
    ? Object.entries(targets)
    : Object.hasOwn(targets, selectedTarget) ? [[selectedTarget, targets[selectedTarget]]] : [];
  for (const [adapter, target] of selected) {
    const targetPath = `targets.${adapter}`;
    if (!isRecord(target)) {
      errors.push(`${targetPath} must be an object`);
      continue;
    }
    addUnexpectedKeys(target, ["lanes"], targetPath, errors);
    if (!isRecord(target.lanes)) {
      errors.push(`${targetPath}.lanes must be an object`);
      continue;
    }
    addUnexpectedKeys(target.lanes, Object.keys(CANONICAL_LANES), `${targetPath}.lanes`, errors);

    for (const [laneId, binding] of Object.entries(target.lanes)) {
      const bindingPath = `${targetPath}.lanes.${laneId}`;
      if (!isRecord(binding)) {
        errors.push(`${bindingPath} must be an object`);
        continue;
      }
      addUnexpectedKeys(binding, ["model", "provenance"], bindingPath, errors);
      if (typeof binding.model !== "string" || binding.model.length === 0) {
        errors.push(`${bindingPath}.model must be a non-empty string`);
      } else if (!isMarkerSafeModelToken(binding.model)) {
        errors.push(`${bindingPath}.model must be a marker-safe single-line token (UNSAFE_MODEL_TOKEN)`);
      }
      if (typeof binding.provenance !== "string" || binding.provenance.length === 0) {
        errors.push(`${bindingPath}.provenance must be a non-empty string`);
      }
    }
  }
}

export function auditInstalledRoles(contract, installedRoles, { strict = false } = {}) {
  const roleNames = new Set(Object.keys(contract.roles ?? {}));
  const managed = [];
  const unmanaged = [];

  for (const installedRole of installedRoles) {
    (roleNames.has(installedRole) ? managed : unmanaged).push(installedRole);
  }

  return {
    managed,
    unmanaged,
    errors: strict ? unmanaged.map((role) => `UNCLASSIFIED_ROLE: ${role}`) : [],
  };
}

export function canonicalLanes() {
  return structuredClone(CANONICAL_LANES);
}

export function claudeCapabilityMatrix() {
  return structuredClone(CLAUDE_REASONING_CAPABILITY);
}

export function validateCapabilityMatrix(capability) {
  const expected = claudeCapabilityMatrix();
  const errors = [];

  if (!isRecord(capability)) {
    return { valid: false, errors: ["capability matrix must be an object"] };
  }
  addUnexpectedKeys(capability, ["adapter", "reasoning"], "capability", errors);
  if (capability.adapter !== "claude") {
    errors.push("capability.adapter must be claude");
  }
  if (!isRecord(capability.reasoning)) {
    errors.push("capability.reasoning must be an object");
  } else {
    addUnexpectedKeys(capability.reasoning, ["effort", "thinking", "effective"], "capability.reasoning", errors);
    for (const [field, value] of Object.entries(expected.reasoning)) {
      if (capability.reasoning[field] !== value) {
        errors.push(`capability.reasoning.${field} must be ${value}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
