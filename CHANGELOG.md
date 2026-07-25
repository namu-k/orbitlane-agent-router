# Changelog

This project is pre-1.0, so breaking changes raise the minor version.

## 0.3.0

### Migration from 0.2.0 — recommended, not required

Reinstall each scope to pick up the new instruction block:

    npm install -g orbitlane@0.3.0
    orbitlane install --global --target both --contract <path>

Unlike 0.2.0, this is not urgent. Guard enforcement semantics are unchanged, so an
existing install keeps working correctly; only the projected `CLAUDE.md` /
`AGENTS.md` text is stale until you reinstall. A 0.3.0 CLI can uninstall a guard
that 0.2.0 installed.

### Changed

- The projected policy block is now four lines carrying this target's tier-to-model
  binding, replacing the sixteen policy lines, eleven delegation fixtures, and the
  `Contract routes:` role table. Vanilla and OMX users receive identical guidance.
- `roles` is optional. A contract without roles installs guidance only: no
  `settings.json` hook and no vendored guard runtime.
- Codex reports a guidance-only status instead of `partial enforcement`; it has no
  guard and never had one. The Claude guard is a request-consistency check, not a
  guarantee of the executing model, and `effective_model` stays `unproven`.

### Fixed

- A model string containing a newline and a marker delimiter could close the
  `ORBITLANE` block early and inject text into `CLAUDE.md` / `AGENTS.md`. Model
  strings are now validated as marker-safe single-line tokens before any write.
- Lane-to-model resolution is shared by the projection and the guard, so the model
  the kernel advertises and the model the guard expects in the request cannot
  diverge. Codex now
  requires an official release before trusting a runtime default, matching Claude.
- A corrupt report no longer reads as "no hook installed" during a reinstall, which
  could orphan a hook entry while reporting success.

## 0.2.0

### Migration from 0.1.0 — required

Upgrading the package does not rewrite anything already installed. The report
schema and the guard argument contract both changed, so every scope must be
reinstalled:

```bash
npm install -g orbitlane@0.2.0
orbitlane install --global --target both --contract <path>
# then, in each project that had OrbitLane installed:
orbitlane install --target both --contract <path>
```

Until a scope is reinstalled its guard denies every Agent spawn. The error names
the code, the selected scope, the report path and the layer to reinstall. That is
deliberate: a v0.1 report carries no snapshot pointer, and the guard fails closed
rather than deciding from a contract it cannot verify.

### Added

- `--global` installs into each runtime's config home (`~/.codex`, `~/.claude`),
  honouring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Project and global layers
  compose: the nearest project report wins, the global report is the fallback.
- Contracts and runtime-defaults persist as immutable content-addressed
  snapshots. The report carries `schema_version: 2` and the snapshot pointers,
  so every installed guard resolves one shared contract at run time instead of
  the contract frozen into it at install time.
- `uninstall` no longer requires `--contract`. Ownership is proven from the
  installed receipt, and an unverifiable receipt fails that target without
  touching settings.
- The heartbeat records which contract decided: `selected_scope`,
  `contract_sha256`, `report_path`, `resolver_policy_version`.
- Install copies the guard runtime to `<config root>/.orbitlane/hook/`, so the
  installed guard keeps working after the package that installed it is gone.
  `npx orbitlane install` is supported for every target and both layers.
- Uninstall reclaims the snapshot store and the vendored runtime. The heartbeat
  log is evidence and is kept.

### Fixed

- A heartbeat write failure no longer turns a deny into an allow. Evaluation and
  evidence are separate steps and the verdict survives a failed write.
- The hook checks for an Agent call before resolving any contract, and an
  unresolvable contract denies instead of failing open.
- An unreadable project report (`EACCES`, `EIO`, `EMFILE`, `EISDIR`) denies at
  project scope instead of silently falling back to the global contract. Only
  `ENOENT` and `ENOTDIR` mean "no report lives here".
- A present-but-malformed snapshot pointer denies with
  `REPORT_POINTER_MALFORMED` instead of being treated as absent.
- The contract is read once. It was read twice, so a replacement between the two
  reads could make the report describe one contract while the snapshot pointer
  named another.
- A blank `CODEX_HOME` or `CLAUDE_CONFIG_DIR` no longer resolves to the current
  directory, and a relative one is refused with `GLOBAL_HOME_NOT_ABSOLUTE`.
- Snapshots publish by rename, so an interrupted or out-of-space write cannot
  leave a truncated file at an immutable digest path.
- The guard reports the installing layer separately from the selected scope, so
  a project install whose report is missing is no longer told to reinstall the
  global layer.

### Removed

- `EPHEMERAL_PACKAGE_ROOT` and its cache-segment heuristic. The installed hook no
  longer references the package path, so there is nothing to guess about.

## 0.1.0

First published release. Tier 1 configuration and audit for Codex/OMX and
Claude Code, with a scoped Claude Agent spawn guard.
