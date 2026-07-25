# Final Whole-Branch Review Fix Report

Date: 2026-07-25

## Scope and constraints

- Base reviewed: `c04c94ea224190623deaa436e3e9c9a11f5bc9fe` on `feature/tier-model-projection`.
- Preserved the existing installer transaction layer and Task 7-9 receipt, roles-less, and transition ownership semantics.
- No production dependencies, publication, push, tag, plan/spec edit, stash, or `TODOS.md` edit were made.

## RED then GREEN

### 1. Shared marker-safe model token validation

- RED: `node --test test/config/lanes.test.js test/schema/schema-parity.test.js test/policy/projection.test.js test/adapters/claude.test.js test/cli.test.js` initially failed five new assertions: runtime-default injection was accepted for Claude and Codex, projection interpolated it, JSON schema had no grammar, roles-less Claude status was wrong, and CLI preflight wrote too early.
- GREEN: exported `isMarkerSafeModelToken` from `src/schema/index.js`; contract bindings, runtime defaults in `src/config/lanes.js`, and the `src/policy/index.js` interpolation boundary use the same grammar. `contract.schema.json` now mirrors `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
- Coverage: unsafe runtime-default injection is rejected for both targets; projection cannot interpolate an unsafe model; schema parity and ordinary provider-name acceptance are covered.

### 2. Target-local CLI preflight before durable preparation

- RED: the initial CLI regression showed an unresolved Claude kernel could still prepare Claude durability before render validation.
- GREEN: `bin/orbitlane.js` renders each selected adapter as preflight before Claude hook vendoring or snapshot publication. Claude preflight failures remain target-local, so `--target both` still installs a valid Codex target.
- Coverage: CLI tests prove zero Claude report, snapshot, and vendored-hook artifacts for unsafe tokens, invalid contracts, and unresolved Claude kernels; the unresolved case also proves successful Codex installation under `--target both`.

### 3. Roles-less Claude report semantics

- RED: roles-less Claude reports emitted `status: "partial enforcement"` despite no routed roles or hook.
- GREEN: roles-less reports now emit `status: "guidance only"`, retain empty route/artifact objects, report `native_role_configuration: "not-applicable"`, and keep `effective_model: "unproven"`.

### 4. README evidence versus installed-artifact boundary

- RED: both READMEs claimed native Codex agent/model configuration and Claude custom subagent definition installation.
- GREEN: English and Korean README sections now distinguish marker guidance plus generated report evidence from installed runtime artifacts; only the roles-bearing Claude settings hook/guard is described as installed. Release-gate tests assert both-language boundary statements.

## Changed files

- Runtime/security: `src/schema/index.js`, `src/schema/contract.schema.json`, `src/config/lanes.js`, `src/policy/index.js`, `bin/orbitlane.js`, `src/adapters/claude/index.js`.
- Tests: `test/config/lanes.test.js`, `test/schema/schema-parity.test.js`, `test/policy/projection.test.js`, `test/cli.test.js`, `test/adapters/claude.test.js`, `test/release-gate.test.js`.
- Documentation: `README.md`, `README.ko.md`.

## Verification

- Focused security/preflight/adapter/release and Task 7-9 regressions: `node --test test/config/lanes.test.js test/schema/contract.test.js test/schema/schema-parity.test.js test/policy/projection.test.js test/adapters/claude.test.js test/adapters/codex.test.js test/cli.test.js test/cli-roles-less.test.js test/cli-transition.test.js test/cli-uninstall-receipt.test.js test/release-gate.test.js` -> `113 pass, 0 fail, 1 skipped` (Windows-only shell case).
- Full suite: `npm test` -> `233 pass, 0 fail, 1 skipped` (Windows-only shell case).
- Syntax: `git diff --name-only -- '*.js' | xargs -r -n1 node --check` -> PASS.
- JSON: `node -e "JSON.parse(require('node:fs').readFileSync('src/schema/contract.schema.json', 'utf8')); console.log('JSON parse PASS')"` -> PASS.
- Whitespace: `git diff --check` -> PASS.

## Self-review and concerns

- Reviewed the final diff for target isolation, durable-write ordering, marker-boundary defense in depth, receipt/transition preservation, and English/Korean claim parity.
- No unresolved design decision was introduced. The only non-product workspace item is the pre-existing untracked `TODOS.md`, intentionally untouched and excluded from the commit.
