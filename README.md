# OrbitLane — Model Routing for Codex, Claude Code, and Coding Agents

[한국어](README.ko.md)

> **Status: v0.1.0 is published to npm.** Install and run it with `npx orbitlane`. This is an early release: Tier 1 delivers configuration and audit and is not a claim of universal runtime enforcement (the Tier 2 roadmap).

OrbitLane is an open-source **routing contract compiler** that compiles one role-to-model routing contract into runtime-native configuration for Codex/OMX and Claude Code, then audits what can actually be enforced. v1 delivers contract compilation, a merge-preserving installer, static drift auditing, and a Claude Code-scoped spawn guard. A general-purpose runtime model router is the Tier 2 roadmap.

OrbitLane does not proxy LLM API traffic. It routes **agent roles and task classes**—such as architecture, implementation, verification, and repository lookup—to user-selected model lanes.

## Why OrbitLane?

Coding-agent workflows often encode routing in several places: an instruction file, agent definitions, model settings, hooks, environment variables, and workflow-specific prompts. Those copies drift. A new runtime release can also expose different dispatch or metadata capabilities.

OrbitLane makes the routing policy explicit and portable:

- Define judgment, implementation, and bounded-retrieval lanes (`sol` / `terra` / `luna`) once.
- Map named roles and task shapes to those lanes.
- Install only the adapter you need: Codex, Claude Code, or both.
- Preserve user-owned content through marker-bounded merges.
- Reject unclassified roles instead of silently assigning a model.
- Audit configuration separately from runtime enforcement.
- Report unsupported capabilities as `false` or `unproven`, never as implied success.

## Quick start

The package exposes its CLI with one command:

```bash
npx orbitlane --help
```

An interactive selector is not included yet; a contract path is required for installation:

```text
? Where should OrbitLane install routing configuration?
  Codex / OMX
  Claude Code
  Both
```

Non-interactive forms for CI and dotfile automation:

```bash
npx orbitlane install --target codex --contract <path>
npx orbitlane install --target claude --contract <path>
npx orbitlane install --target both --contract <path>
```

No global package installation or WSL-specific setup is required.

## Two-layer installation

OrbitLane installs in two layers. Both runtimes merge their global and project
instruction files, so the layers compose rather than compete.

| Layer | Command | Claude Code | Codex |
| --- | --- | --- | --- |
| Global baseline | `orbitlane install --global --target both --contract <path>` | `~/.claude/CLAUDE.md`, `~/.claude/settings.json` | `~/.codex/AGENTS.md` |
| Project authoritative | `orbitlane install --target both --contract <path>` | `CLAUDE.md`, `.claude/settings.json` | `AGENTS.md` |

`CODEX_HOME` and `CLAUDE_CONFIG_DIR` are honoured when set.

Every installed Claude guard resolves the same effective contract at run time:
the nearest project report wins, and the global report is used only when no
project report exists. A project therefore overrides the global baseline
without the two guards disagreeing.

### Support boundary

The global Claude guard requires a persistent package installation:

```bash
npm install -g orbitlane
orbitlane install --global --target claude --contract ./contract.json
```

Running it through `npx` or `dlx` is refused with `EPHEMERAL_PACKAGE_ROOT`,
because the installed hook stores an absolute path into a cache that can be
evicted. Every other command, including `--global --target codex`, works fine
under `npx`.

## How coding-agent model routing works

```text
User routing intent
        │
        ▼
Portable OrbitLane contract
        │
        ├──► Codex / OMX adapter ──► native agent and model configuration
        │
        └──► Claude adapter ───────► CLAUDE.md, settings, and subagent definitions

        ▼
Capability probe ──► tier decision ──► static audit
```

The contract is independent of any single skill system. Superpowers, OMX workflows, custom user instructions, and future adapters can all consume the same role and task-shape vocabulary. Skills describe **how work should run**; the contract describes **which capability lane should run it**.

## Portable routing contract

OrbitLane uses semantic lanes rather than hard-coding a vendor's current model names into workflow prose.

```json
{
  "contract_version": "1.0.0",
  "lanes": {
    "sol":   { "class": "judgment",         "reasoning": "high" },
    "terra": { "class": "implementation",    "reasoning": "medium" },
    "luna":  { "class": "bounded-retrieval", "reasoning": "low" }
  },
  "roles": {
    "architect": { "lane": "sol",   "provenance": "user-approved" },
    "executor":  { "lane": "terra", "provenance": "user-approved" },
    "explore":   { "lane": "luna",  "provenance": "user-approved" }
  }
}
```

Lanes carry a canonical id (`sol` / `terra` / `luna`) and a `class` (judgment / implementation / bounded-retrieval); public examples do not hard-code provider model names. Adapters resolve each lane to a supported model using the contract's optional per-target binding, else the runtime's official default for that lane class, recording the source; ambiguous resolution fails rather than guessing. A role the contract routes fails validation until classified with provenance (or under `--strict`); installed roles the contract does not route are reported as `unmanaged` and left untouched.

Target policy projections do not expose canonical lane IDs as though they were model names. They record the resolved target model for each role; for example, a Claude projection can show `architect="opus"`, `executor="sonnet"`, and `explore="haiku"`. These are requested configuration routes, not proof of the model that ultimately executed.

## Enforcement tiers

OrbitLane separates useful routing from claims that require runtime proof.

| Capability | Tier 1: configuration routing | Tier 2: runtime-enforced routing |
| --- | --- | --- |
| Generate native configuration | Yes | Yes |
| Project semantic policy | Yes | Yes |
| Validate every declared role | Yes | Yes |
| Detect configuration drift | Yes | Yes |
| Require typed role/model dispatch | Not required | Required |
| Block every unsupported spawn before dispatch | No | Required |
| Prove effective role, model, and reasoning after spawn | No | Required |

Tier 1 is a normal, useful operating mode. It makes supported native configuration deterministic and auditable. It does **not** claim that every runtime path used the requested model.

The v1 Claude Code adapter additionally enforces a **scoped** pre-dispatch check on the Agent tool (deny on mismatch). This is reported inside Tier 1 as a bounded capability (`claude_agent_pre_dispatch`), not a separate tier and not a claim over every spawn path.

Tier 2 is selected only when the target runtime proves all three capabilities:

1. Typed role or model input at dispatch.
2. Trusted pre-dispatch interception covering every supported spawn path.
3. Trustworthy post-spawn metadata for the effective role, model, and reasoning level.

A receipt can always record a requested route. It may record an effective route only when the runtime supplies trustworthy evidence.

## Runtime support

| Runtime | Planned adapter status | Initial enforcement target |
| --- | --- | --- |
| Codex with OMX | v1 | Tier 1 configuration and audit |
| Claude Code | v1 | Tier 1 configuration and audit; stronger enforcement only when capability probes pass |
| OpenCode | Research roadmap | Contract mapping informed by native agents and category-based orchestration |

The support matrix reports verified adapter behavior, not general compatibility assumptions.

## Why OpenCode model routing feels strong

OpenCode's advantage is not merely that subagents already exist. Its agent system treats a named agent as a first-class configuration object with its own model, mode, prompt, tools, and permissions. Dispatch selects a named subagent, so role identity and model configuration meet at a structured runtime boundary. See the official [OpenCode agents documentation](https://opencode.ai/docs/agents/).

Orchestration layers can build a higher-level semantic router on top. For example, Oh My OpenAgent separates agents from task categories: an orchestrator delegates to categories such as `quick`, `deep`, or `visual-engineering`; each category resolves to configured models and fallback chains. Its documentation describes both the [orchestration model](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/orchestration.md) and the [agent/model resolution pipeline](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md).

That combination explains the experience:

1. Stable named agents provide durable behavioral roles.
2. Semantic categories hide volatile provider model IDs from task prompts.
3. Explicit configuration binds agents or categories to models.
4. Fallback chains adapt to available providers.
5. The orchestrator chooses a task meaning, not a raw model name.

OrbitLane takes a complementary approach: preserve a vendor-neutral routing contract and compile it into each runtime's strongest native surface. It is not an OpenCode replacement.

## Codex and Claude adapter design

The Codex/OMX adapter is expected to project:

- Role-to-model and role-to-reasoning mappings.
- A small marker-bounded policy block in `AGENTS.md`.
- Generated model tables and native configuration where supported.
- Capability and tier decision evidence.
- Static verification without claiming effective runtime binding.

The Claude Code adapter is expected to project:

- A small marker-bounded policy block in `CLAUDE.md`.
- Custom subagent definitions with native `model` and effort settings.
- Merge-preserving settings and supported hooks.
- Capability probes that distinguish configurable models from proven runtime enforcement.

Claude Code officially supports model selection in custom subagent definitions and documents its resolution order in [Create custom subagents](https://code.claude.com/docs/en/sub-agents). Its [hooks reference](https://code.claude.com/docs/en/hooks) also distinguishes blockable events from lifecycle events that can only observe or inject context. OrbitLane will use those native guarantees without widening them through marketing language.

## Cross-platform design

OrbitLane is planned as a Node.js CLI using platform-neutral filesystem APIs.

- Linux
- macOS
- Windows
- WSL, as a supported Linux environment rather than a dependency

The installer will discover user configuration directories through runtime conventions and explicit flags. It will not embed a developer username, home directory, shell profile, or project-specific path.

## Privacy and safe installation

OrbitLane is designed for local configuration control.

- Preview changes with a dry run.
- Back up files before modification.
- Merge only marker-owned instruction blocks.
- Keep unrelated user instructions byte-for-byte unchanged when possible.
- Never collect prompts, credentials, transcripts, or source code for routing.
- Never publish local evidence bundles as repository content.
- Never label requested-model receipts as effective-model proof.

Telemetry is not planned for v1.

## Frequently asked questions

### What is coding-agent model routing?

Coding-agent model routing maps a task role or task shape to a model capability lane. For example, architecture can use the judgment lane (`sol`), implementation the implementation lane (`terra`), and bounded repository lookup the bounded-retrieval lane (`luna`).

### Can user instructions activate the routing contract without Superpowers?

Yes. The contract is workflow-independent. A user instruction, native agent definition, OMX workflow, Superpowers skill, or another adapter can select a declared role or task shape. The runtime adapter then projects that selection into the strongest configuration surface the runtime supports.

### Does OrbitLane work without Tier 2?

Yes. Tier 1 provides deterministic configuration generation, semantic policy auditing, role classification checks, and drift detection. What it cannot provide is universal proof that every spawn used the requested effective model.

### Does OrbitLane guarantee which model actually ran?

Only in a future Tier 2 adapter where the runtime provides trusted dispatch interception and effective-model metadata for every supported spawn path. Otherwise OrbitLane reports the effective model as `unproven`.

### Is OrbitLane an LLM gateway or API proxy?

No. OrbitLane configures coding-agent roles and runtime adapters. It does not route network requests between model providers.

### Is OrbitLane tied to WSL?

No. WSL is one supported environment. The planned CLI is cross-platform and must also work on native Windows, macOS, and Linux.

### Will OrbitLane overwrite AGENTS.md or CLAUDE.md?

No. The installer is designed to own only a clearly marked routing block and preserve surrounding user content. A dry-run diff and backup precede any write.

## Roadmap

- [x] Define the public positioning and enforcement vocabulary.
- [x] Publish the canonical contract schema and fixtures.
- [x] Build the merge-preserving installer.
- [x] Implement and verify the Codex/OMX Tier 1 adapter.
- [x] Implement and verify the Claude Code adapter.
- [x] Add cross-platform integration tests.
- [x] Publish the npm package (`orbitlane`).
- [ ] Sign release artifacts.
- [ ] Evaluate an OpenCode adapter against its native agent and plugin APIs.
- [ ] Promote an adapter to Tier 2 only after all capability gates pass.

## Project status

OrbitLane v0.1.0 is published to npm as a Tier 1 CLI: contract compilation, a merge-preserving installer, Codex/OMX and Claude Code adapters, and a Claude Code-scoped spawn guard. Review should focus on the contract, claim boundaries, adapter interfaces, and cross-platform installation behavior. Universal runtime enforcement remains the Tier 2 roadmap.

## Discoverability notes

Recommended GitHub topics for the first public release:

`ai-agents`, `coding-agents`, `model-routing`, `subagents`, `codex`, `claude-code`, `opencode`, `developer-tools`, `nodejs`, `cli`

The README follows GitHub's guidance to explain what a project does, why it is useful, and how users get started. See [About repository READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) and [Repository topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).
