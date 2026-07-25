# Task 11 — Cross-platform CI repair

## Scope

- Authority: `.superpowers/sdd/task-11-brief.md`.
- Changed only the Task 11-owned files. `TODOS.md`, release state, tags, and
  ignored planning material were not touched.

## TDD evidence

1. Added `a global transition accepts an alias path to its installed report` to
   `test/cli-transition.test.js`. It creates a POSIX directory symlink, or a
   Windows `mklink /J` directory junction, and uses that alias as
   `CLAUDE_CONFIG_DIR` for a global managed-role-to-guidance transition.
2. RED: `node --test test/cli-transition.test.js` failed only the new case with
   `2 !== 0`. The current raw comparison treated the resolver's canonical report
   path as different from the configured alias path.
3. GREEN: `bin/orbitlane.js` now applies `realpath()` to the configured generated
   report path, rejects canonicalization errors and canonical mismatches as
   `RECEIPT_UNVERIFIABLE`, and leaves the later report-byte hash validation
   unchanged.

## Additional platform coverage

- `test/release-gate.test.js` accepts `\r?\n` at both fenced-JSON boundaries.
- `test/upgrade-from-v02.test.js` converts only `path.sep` in relative tree
  entries, preserving literal backslashes in POSIX filenames.

## Verification

- `node --test test/cli-transition.test.js` (RED): 25 passed, 1 failed as
  expected (`2 !== 0`).
- `node --test test/cli-transition.test.js` (GREEN): 26 passed.
- `node --test test/cli-transition.test.js test/release-gate.test.js test/upgrade-from-v02.test.js`:
  36 passed.
- `npm test`: 245 passed, 1 skipped (the existing Windows-only install-path
  expansion case).
- `node --check bin/orbitlane.js` and all three changed tests: passed.
- `git diff --check`: passed.

## Self-review and concerns

- No raw-path fallback, case folding, or string normalization was added.
- The alias test uses a junction on Windows, avoiding ordinary symlink privilege
  requirements.
- No remaining concern identified. Commit: `fix(cli): canonicalize transition report paths`.
