# OrbitLane — Model Routing for Codex, Claude Code, and Coding Agents

[한국어](README.ko.md)

> **Current release: v0.4.0.** Install and run it with `npx orbitlane`. This is an early release: Tier 1 delivers configuration, audit, local measurement, and a scoped Claude routing guard; it is not a claim of universal runtime enforcement (the Tier 2 roadmap).
>
> **Upgrading from v0.3.0: reinstall only for new Claude telemetry.** A package upgrade exposes the estimator but does not rewrite an installed scope, and existing guards keep routing correctly. Reinstall each roles-bearing Claude scope that should collect structured routing-decision and usage evidence. Codex estimation reads local rollout records without a Codex hook. See [CHANGELOG.md](CHANGELOG.md).

OrbitLane is an open-source **routing contract compiler** that compiles one routing contract into runtime-native guidance for Codex/OMX and Claude Code, then audits what can actually be enforced. v1 delivers contract compilation, a merge-preserving installer, static drift auditing, and an opt-in Claude Code-scoped spawn guard for contracts that declare roles. A general-purpose runtime model router is the Tier 2 roadmap.

Two properties separate it from adjacent tooling. It is **cross-runtime**: one contract targets Codex/OMX and Claude Code, rather than being a hook for a single vendor. And it routes on **declared role identity**, matched verbatim against the runtime's own agent identifier, rather than on an inferred prompt-complexity score — an explicitly named skill or an explicitly chosen model is a decision the router yields to and records as a divergence.

OrbitLane does not proxy LLM API traffic. It routes **agent roles and task classes**—such as architecture, implementation, verification, and repository lookup—to user-selected model lanes.

## Why OrbitLane?

Coding-agent workflows often encode routing in several places: an instruction file, agent definitions, model settings, hooks, environment variables, and workflow-specific prompts. Those copies drift. A new runtime release can also expose different dispatch or metadata capabilities.

OrbitLane makes the routing policy explicit and portable:

- Define judgment, implementation, and bounded-retrieval lanes (`sol` / `terra` / `luna`) once.
- Map named roles and task shapes to those lanes.
- Install only the adapter you need: Codex, Claude Code, or both.
- Preserve user-owned content through marker-bounded merges.
- Declared roles are checked; runtime roles not declared in the contract pass through as unmanaged.
- Audit configuration separately from runtime enforcement.
- Report unsupported capabilities as `false` or `unproven`, never as implied success.

## How OrbitLane compares to rulesync, claude-model-router-hook, and LLM routers

Three families of tool sit next to OrbitLane and are easy to confuse with it. They differ in
what they take as input, what they change, and whether they are in the request path at all.

| Category | Representative projects | What they do | How OrbitLane differs |
| --- | --- | --- | --- |
| Instruction and config sync | [rulesync](https://github.com/dyoshikawa/rulesync), [ruler](https://github.com/intellectronica/ruler) | Compile one rule source into 30–40 agents' native instruction, MCP, ignore, and (rulesync) subagent files | Same compile-once shape, different payload. OrbitLane's contract carries a role → lane → model routing policy and a static drift audit, not instruction prose. Model choice is the subject, not a side effect |
| Claude Code routing hooks | [claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook) | Classify each prompt's complexity, rewrite generic spawns to routed agent variants, and optionally write a recommended model into `settings.json` | Cross-runtime rather than Claude-only. Routes declared role names verbatim instead of a heuristic complexity classifier, never rewrites the main-session model or the user's model choice, and fills in only spawns that named no model |
| Request-path routers and gateways | [claude-code-router](https://github.com/musistudio/claude-code-router), [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [RouteLLM](https://github.com/lm-sys/RouteLLM), [semantic-router](https://github.com/vllm-project/semantic-router) | Sit between the agent and providers as a local gateway or serving-layer router, deciding per request | OrbitLane is a configuration-time compiler. No proxy, no endpoint, no provider credentials, no traffic. It never sees a prompt |

Checked 2026-07-31. As of that date we found no project that compiles one vendor-neutral
routing contract into both a non-Anthropic runtime and Claude Code and then statically audits
the result. If you know one, please open an issue — a corrected comparison is more useful than
an uncontested one.

### Why this slot may have stayed empty

An empty slot is not automatically an opportunity. The competing explanation is that per-runtime
model designation differs enough that a contract abstraction breaks once it gets thin. Our own
measurements say that is partly true, and the design is shaped around it rather than against it.

The abstraction **holds at the guidance layer**. Both runtimes merge global and project
instruction files, so one contract renders the same four-line kernel for either target, and both
resolve models through the same lane table.

It **thins at the injection layer**, where a rewrite has to match one runtime's exact call shape.
`CLAUDE_CODE_SUBAGENT_MODEL` outranks the per-call `model`. `inherit` means "same as unset" from
Claude Code v2.1.196 and "force the main model" before it, and no version reaches the hook. Codex
surfaces disagree with each other: native delegation spawns without a model, while skill fan-out
was observed passing `model` on every `spawn_agent` call on `codex-cli 0.145.0`. No single call
shape describes one runtime, let alone two.

So OrbitLane does not pretend the abstraction is uniform. It ships two mechanisms with different
reach — guidance everywhere, injection only where a call shape is known — and an enforcement tier
vocabulary that states which is which. `effective_model` stays `unproven` because rewriting a
request does not observe what ran. That separation is the product, not a limitation of it.

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

## Offline confidence estimator

Create a local, baseline-relative cost estimate without a network call:

```bash
orbitlane estimate --runtime <auto|claude|codex> [--session <latest|thread-id|path>] [--baseline-model <model>] [--prices <catalog.json>] --output <report.json>
```

Claude reads project evidence from `.orbitlane/evidence/project` for `latest` and can read an explicit evidence file or directory. Codex reads `CODEX_HOME/sessions`; `latest` selects the newest matching user rollout for the current project and includes linked child rollouts, while an explicit Codex thread ID or rollout path selects only that runtime's evidence. `--runtime auto` accepts only the omitted or `latest` session selection. The bundled catalog is labelled `heuristic`; use `--prices` to supply a local custom catalog.

High, Medium, Low, and Insufficient confidence use score bands of 80+, 55–79, 35–54, and below 35. Codex estimates are capped at 65. A positive difference means the selected baseline costs more than the routed-model estimate, zero means equal, and a negative difference means the routed-model estimate costs more. Insufficient data is shown as `데이터 부족` with null money values.

This is a heuristic estimate, not a billing statement or proven net savings.

Evidence and reports stay local. On Windows, Node cannot enforce POSIX mode `0600`; events declare `file-mode-unenforced`, and file access follows the containing directory's Windows ACLs.

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

A roles-less guidance-only Claude report installed in a project shadows a roles-bearing global report. Routed spawns are therefore treated as unmanaged and pass through rather than being checked by the global guard. This is a bounded scope-precedence consequence, not universal runtime enforcement.

### What install writes

Every target receives a four-line instruction block as **guidance**. It carries
that target's tier-to-model binding, but it is not enforcement. Codex installs
guidance only: it has no guard and reports `effective_model` as `unproven`.

**Opt-in enforcement** requires a contract that declares `roles`. Only then does
the Claude target copy the guard and observer runtime next to the report it reads,
under `<config root>/.orbitlane/hook/`, and add scoped `PreToolUse` routing and
`PostToolUse` usage-observer hooks to `settings.json`.
The guard fills in the routed model when a spawn leaves the model unspecified, and
otherwise steps aside: an explicitly named model, a concrete
`CLAUDE_CODE_SUBAGENT_MODEL`, or a role the contract does not route all pass
through unchanged and are recorded. It does not block spawns over model choice —
a denied spawn costs a failed turn and a retry, which is the opposite of the point.
Rewriting the request is still not a guarantee of the executing model;
`effective_model` remains `unproven`. A contract without `roles` installs
guidance only: no `settings.json` hook and no vendored guard runtime. The
installed Claude guard keeps deciding after the package that installed it is
gone, which is the normal end state for `npx` and `dlx`. `npx orbitlane install`
is supported for every target and both layers. The observer records only sanitized
foreground completion usage and does not participate in routing decisions.

For a roles-bearing Claude install, uninstalling reclaims the owned hook tuples,
vendored runtime, and snapshots. The telemetry HMAC key and local routing-decision
and usage evidence are retained.

## How coding-agent model routing works

```text
User routing intent
        │
        ▼
Portable OrbitLane contract
        │
        ├──► Codex / OMX adapter ──► AGENTS.md guidance and generated report evidence
        │
        └──► Claude adapter ───────► CLAUDE.md, generated report, and optional scoped settings hook

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
  },
  "targets": {
    "codex": {
      "lanes": {
        "sol":   { "model": "gpt-5.6-sol",   "provenance": "user-approved" },
        "terra": { "model": "gpt-5.6-terra", "provenance": "user-approved" },
        "luna":  { "model": "gpt-5.6-luna",  "provenance": "user-approved" }
      }
    },
    "claude": {
      "lanes": {
        "sol":   { "model": "opus",   "provenance": "user-approved" },
        "terra": { "model": "sonnet", "provenance": "user-approved" },
        "luna":  { "model": "haiku",  "provenance": "user-approved" }
      }
    }
  }
}
```

Lanes carry a canonical id (`sol` / `terra` / `luna`) and a `class` (judgment / implementation / bounded-retrieval). To install the four-line kernel, all three lanes (`sol`, `terra`, and `luna`) for the selected target must resolve through that target's bindings or the runtime's official defaults; ambiguous resolution fails rather than guessing. `roles` is optional. If present, each routed role needs provenance; an omitted `roles` object deliberately selects guidance-only installation.

### Role names must be the runtime's own agent identifiers

The guard matches a role name against the identifier the runtime puts on the spawn,
verbatim and case-sensitively. The names above (`architect`, `executor`, `explore`)
describe a team shape; they route nothing until agents by those exact names exist,
because OrbitLane does not install agent definition files. To route the agents a
stock Claude Code session already spawns, name them:

```json
"roles": {
  "Explore":         { "lane": "luna",  "provenance": "user-approved" },
  "general-purpose": { "lane": "terra", "provenance": "user-approved" },
  "Plan":            { "lane": "sol",   "provenance": "user-approved" }
}
```

`fixtures/contracts/claude-native-agent-roles.json` is this contract in full. Note
that it is not "route everything to the cheapest lane": bounded lookup is where the
saving is, multi-step work drops one tier rather than two, and judgment stays on the
expensive lane deliberately. Anything the contract does not name — and any spawn that
already names a model — is left alone.

For a Claude target bound to `sonnet`, `haiku`, and `opus`, the installed kernel
is exactly these four English lines:

```text
- Prefer direct work; delegate to a subagent when the delegation boundary is clear and the benefit is concrete.
- Delegates settle reversible implementation choices inside assigned scope. Return only decisions that change the approved scope or a public contract, affect data or safety, require new authority, or trigger irreversible/external actions.
- When delegating, use: execution -> sonnet, bounded lookup -> haiku, delegated verification and analysis -> opus.
- Record ROUTE_CONFLICT when parallel delegates hold overlapping write scope on the same file.
```

## Enforcement tiers

OrbitLane separates useful routing from claims that require runtime proof.

| Capability | Tier 1: configuration routing | Tier 2: runtime-enforced routing |
| --- | --- | --- |
| Generate native agent/model configuration | Generated evidence only | Yes |
| Project semantic policy | Yes | Yes |
| Validate every declared role | Yes | Yes |
| Detect configuration drift | Yes | Yes |
| Require typed role/model dispatch | Not required | Required |
| Block every unsupported spawn before dispatch | No | Required |
| Prove effective role, model, and reasoning after spawn | No | Required |

Tier 1 is a normal, useful operating mode. It writes marker-bounded guidance and generated audit evidence; it does not install native Codex agent/model configuration or Claude custom subagent definition files. It does not claim that every runtime path used the requested model.

When a contract declares roles, the v1 Claude Code adapter additionally applies a **scoped** routing pass on the Agent tool: a spawn that names no model has the routed model written into it, and every other spawn is recorded and passed through. This is reported inside Tier 1 as a bounded capability (`claude_agent_pre_dispatch`), not a separate tier, not a guarantee of the executing model, and not a claim over every spawn path.

Routing fills in a model only from a narrow allowlist — `sonnet`, `opus`, and `haiku`. This is OrbitLane's own restriction, not a runtime limit: Claude Code also accepts `fable` and full model IDs such as `claude-opus-5` for a subagent. The allowlist is deliberately smaller because injection changes what actually runs. `fable` needs a minimum Claude Code version the guard cannot observe and is never the cheaper choice, and a pinned identifier is never rewritten to an alias, because the alias resolves to whichever model it currently points at. A lane bound to anything outside the allowlist is still projected as guidance and is simply left unrouted; the generated report marks each route with `injectable` so this is visible at install time.

Tier 2 is selected only when the target runtime proves all three capabilities:

1. Typed role or model input at dispatch.
2. Trusted pre-dispatch interception covering every supported spawn path.
3. Trustworthy post-spawn metadata for the effective role, model, and reasoning level.

A receipt can always record a requested route. It may record an effective route only when the runtime supplies trustworthy evidence.

## Runtime support

| Runtime | Planned adapter status | Initial enforcement target |
| --- | --- | --- |
| Codex with OMX | v1 | Tier 1 guidance and generated audit evidence; no native agent/model configuration is installed |
| Claude Code | v1 | Tier 1 guidance and generated audit evidence; declared roles opt into a scoped request-consistency hook, not custom subagent-definition installation |
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

The Codex/OMX adapter projects:

- The four-line marker-bounded guidance block in `AGENTS.md`.
- A generated guidance-only report with static audit evidence. It installs no Codex native agent/model configuration; `effective_model` remains `unproven`.

The Claude Code adapter projects:

- The same four-line marker-bounded guidance block in `CLAUDE.md`.
- A generated report. Its subagent-shaped entries are requested-route evidence, not installed Claude custom subagent definition files.
- When `roles` is declared, merge-preserving settings, a scoped guard that routes model-unspecified spawns to the lane model, and a local foreground usage observer; none of these prove the executing model.

Claude Code officially supports model selection in custom subagent definitions and documents its resolution order in [Create custom subagents](https://code.claude.com/docs/en/sub-agents). OrbitLane does not install those files. Its [hooks reference](https://code.claude.com/docs/en/hooks) also distinguishes blockable events from lifecycle events that can only observe or inject context; OrbitLane's scoped hooks stay within that boundary.

## Cross-platform design

OrbitLane is a Node.js CLI built with platform-neutral filesystem APIs and tested
on all three major operating-system families.

- Linux
- macOS
- Windows
- WSL, as a supported Linux environment rather than a dependency

The installer discovers user configuration directories through runtime conventions and explicit flags. It does not embed a developer username, home directory, shell profile, or project-specific path.

## Privacy and safe installation

OrbitLane is designed for local configuration control.

- Preview changes with a dry run.
- Back up files before modification.
- Merge only marker-owned instruction blocks.
- Keep unrelated user instructions byte-for-byte unchanged when possible.
- Never collect prompts, credentials, transcripts, or source code for routing.
- Never publish local evidence bundles as repository content.
- Never label requested-model receipts as effective-model proof.

OrbitLane records only local routing-decision and usage evidence for the offline estimator. It does not transmit telemetry or collect prompts, responses, transcripts, credentials, or source code.

## Frequently asked questions

### What is coding-agent model routing?

Coding-agent model routing maps a task role or task shape to a model capability lane. For example, architecture can use the judgment lane (`sol`), implementation the implementation lane (`terra`), and bounded repository lookup the bounded-retrieval lane (`luna`).

### Can user instructions activate the routing contract without Superpowers?

Yes. The contract is workflow-independent. A user instruction, native agent definition, OMX workflow, Superpowers skill, or another adapter can select a declared role or task shape. Every contract projects guidance; declaring `roles` additionally opts the Claude target into its scoped request-consistency check.

### Does OrbitLane work without Tier 2?

Yes. Tier 1 provides deterministic configuration generation, semantic policy auditing, role classification checks, and drift detection. What it cannot provide is universal proof that every spawn used the requested effective model.

### Does OrbitLane guarantee which model actually ran?

Only in a future Tier 2 adapter where the runtime provides trusted dispatch interception and effective-model metadata for every supported spawn path. Otherwise OrbitLane reports the effective model as `unproven`.

### How is OrbitLane different from rulesync or ruler?

They distribute one instruction source to many agents; OrbitLane distributes one routing policy to two runtimes. The compile-once shape is shared, the payload is not: rulesync and ruler synchronise rules, MCP servers, and ignore files, while OrbitLane's contract is about which model lane runs which role, and it audits the installed result for drift. Running both together is reasonable — they own different blocks of the same instruction files.

### How is OrbitLane different from claude-model-router-hook?

Both can rewrite a Claude Code subagent spawn, and there the resemblance ends. claude-model-router-hook classifies each prompt's complexity with a heuristics-first classifier and can also write a recommended model into `settings.json` for new sessions. OrbitLane runs no classifier: it matches the runtime's own agent identifier against roles you declared, touches only spawns that named no model, never changes the main-session model, and compiles the same contract for Codex/OMX as well. Choose the classifier if you want per-prompt adaptation on Claude Code; choose OrbitLane if you want one explicit, auditable policy across two runtimes.

### Is OrbitLane an LLM gateway or API proxy?

No. OrbitLane configures coding-agent roles and runtime adapters. It does not route network requests between model providers. Tools such as claude-code-router, CLIProxyAPI, RouteLLM, and semantic-router operate in the request path and need provider credentials; OrbitLane runs at configuration time, holds no credentials, and never sees a prompt.

### Is OrbitLane tied to WSL?

No. WSL is one supported environment. The CLI is tested on native Windows, macOS, and Linux.

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

OrbitLane v0.4.0 is available from npm with contract compilation, a merge-preserving installer, target-specific four-line guidance for Codex/OMX and Claude Code, an opt-in Claude Code-scoped routing guard for model-unspecified spawns, structured local usage evidence, and an offline confidence estimator. The guard and telemetry do not prove the executing model; `effective_model` remains `unproven`. Universal runtime enforcement remains the Tier 2 roadmap.

## Discoverability notes

Recommended GitHub topics for the first public release:

`ai-agents`, `coding-agents`, `model-routing`, `llm-routing`, `subagents`, `codex`, `claude-code`, `claude-code-hooks`, `agents-md`, `opencode`, `developer-tools`, `nodejs`, `cli`

The README follows GitHub's guidance to explain what a project does, why it is useful, and how users get started. See [About repository READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) and [Repository topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).
