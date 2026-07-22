# OrbitLane Public README Design

## Goal

Introduce OrbitLane as an open-source, cross-platform role-to-model routing policy compiler for coding agents. The README must be useful to humans, searchable by conventional search engines, and easy for answer engines to quote without overstating runtime enforcement.

## Audience

The canonical `README.md` is English-first for global discovery. A complete Korean translation lives in `README.ko.md`. Both documents target developers using Codex/OMX or Claude Code who want one portable routing contract and an installer that can target Codex, Claude, or both.

## Positioning

Use the descriptive title `OrbitLane — Model Routing for Codex, Claude Code, and Coding Agents` and the one-sentence definition: OrbitLane compiles one role-to-model routing contract into runtime-native configuration and audits the result.

Explicitly distinguish OrbitLane from an LLM API gateway: it routes coding-agent roles through generated configuration; it does not proxy model API traffic.

## Claim Boundary

The repository is pre-release. The README may describe the planned `npx orbitlane` UX, but every unshipped command must be labeled as planned. It must not claim that an npm package, Codex adapter, Claude adapter, hard enforcement, or effective-model receipts already exist.

The enforcement vocabulary is:

- Tier 1: configuration generation, semantic policy projection, static audit, and drift detection.
- Tier 2: Tier 1 plus trusted pre-dispatch blocking and trustworthy post-spawn effective-role/model metadata across every supported spawn path.

Unknown or unsupported capabilities remain `unproven`; they are never promoted by user override.

## Information Architecture

The first screen contains the definition, status, platform scope, and planned quick-start command. The rest of the README follows user search intent:

1. Why OrbitLane
2. How it works
3. Enforcement tiers
4. Planned installation UX
5. Portable contract example
6. Runtime support matrix
7. OpenCode comparison
8. Cross-platform and privacy guarantees
9. FAQ phrased as real search questions
10. Roadmap, project status, and source notes

## SEO and GEO Method

- Put `coding agent model routing`, `Codex`, `Claude Code`, `subagents`, and `role-to-model routing` in natural, high-information sentences rather than keyword lists.
- Use one distinctive H1 and compact descriptive headings.
- Answer likely questions directly in the first sentence of each FAQ entry.
- Provide quotable definitions, capability tables, reproducible commands, and links to primary documentation.
- Avoid fake badges, unsupported benchmark numbers, superlatives, and unverified compatibility claims.
- Keep the root README focused; link deeper design and implementation material with descriptive anchor text.
- Recommend GitHub topics separately at publication time rather than stuffing them into prose.

## OpenCode Relationship

The README explains that OpenCode core has first-class named agents with per-agent model configuration, while orchestration layers such as Oh My OpenAgent add semantic task categories, agent/category presets, fallback chains, and runtime model resolution. OrbitLane adopts the portable contract and capability-audit ideas, not project-specific prompts or branding. OpenCode support remains a roadmap item until an adapter is implemented and verified.

## Privacy and Publication

Do not include user-specific home paths, usernames, private project references, local evidence bundles, session identifiers, API keys, provider credentials, installed private model choices, snapshots, or private Git state. Examples use neutral placeholder model identifiers.

## Acceptance Criteria

- Root `README.md` is English canonical and `README.ko.md` is a faithful Korean translation.
- Both identify the project as pre-release and label planned commands honestly.
- Both contain a precise Tier 1/Tier 2 distinction and state that Tier 1 can be useful without claiming effective runtime binding.
- Both explain OpenCode's architectural advantage without claiming OpenCode provides dynamic per-call model tiers that its core does not currently expose.
- All external factual claims link to primary project documentation or source.
- A repository-wide privacy scan finds no user-specific paths, usernames, private project names, secrets, or local evidence identifiers.
