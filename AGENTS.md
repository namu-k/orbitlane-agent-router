# OrbitLane Agent Router

Canonical routing contract compiler for coding-agent runtimes (Codex/OMX, Claude Code).

## What this is for

**OrbitLane exists to save tokens, not to own routing.** Evaluate changes against that,
not against how much of the runtime the contract controls.

- Explicit intent wins. A named skill or an explicitly chosen model is a decision;
  the router yields to it and records the divergence.
- The router acts only where nobody chose — a spawn that names no model.
- Blocking is not saving. A denied spawn costs a failed turn plus a retry, so the
  guard denies only an unroutable call or an unresolvable contract.

## Two mechanisms, repeatedly confused

|                | Four-line guidance kernel                | Claude spawn guard          |
| -------------- | ---------------------------------------- | --------------------------- |
| Reads          | `lanes` + `targets[t].lanes`, **not** `roles` | `roles` → lane → model |
| Installed      | always                                   | only when `roles` is declared |
| Targets        | Codex and Claude                         | Claude only                 |
| Nature         | advice the agent may ignore              | rewrites the actual call    |

Both resolve models through `src/config/lanes.js`, so guidance and injection can never
name different models. Most of the saving in practice comes from the guidance kernel.

The guard is Claude-only for a structural reason, not an unfinished one: Codex decides
the model in the agent definition file (`~/.codex/agents/*.toml`), and its
`spawn_agent(task_name, message, fork_turns)` carries no model argument to rewrite.

## Constraints that are easy to get wrong

- A role name is matched against the runtime's own agent identifier **verbatim and
  case-sensitively**. `Explore` is not `explore`. A role naming no real agent routes
  nothing — see `fixtures/contracts/claude-native-agent-roles.json` for names that work.
- Injection only fills in models the target runtime accepts. A pinned full identifier
  is never mapped onto an alias; the alias resolves to whichever model it currently
  points at, which is a different model at a different price.
- `effective_model` is always `unproven`. Rewriting a request does not observe what
  ran. Never report an unproven capability as success.
- Skill- and plugin-driven work is where routing pays off most; it is not a boundary
  to stay behind. Superpowers and gstack workflows fan out through the same Agent
  tool, usually as `general-purpose` or `Explore` and usually without naming a model
  — exactly the shape the guard routes. Naming those types is how a multi-agent skill
  run gets cheaper. It also means a contract changes spawns the user did not
  personally initiate, so name them deliberately. Plugin-namespaced agents
  (`plugin:agent`) stay out of reach: `ROLE_NAME` admits no colon.

## Design record

Decision records — purpose, considered alternatives, open questions — live in
`docs/superpowers/specs/`. That directory is local only and deliberately untracked.
Read the newest record before changing routing behavior, and add one when you change it.
