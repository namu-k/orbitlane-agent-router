# OrbitLane Public README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an independent OrbitLane repository with an honest, SEO/GEO-oriented English README and Korean translation.

**Architecture:** Keep the root documentation user-focused and place the detailed design under `docs/superpowers/specs`. The README describes a portable contract compiled by runtime adapters, with capability-aware Tier 1 and Tier 2 claims.

**Tech Stack:** Git, Markdown, Node.js CLI examples, JSON contract examples

## Global Constraints

- Work only inside the independent OrbitLane repository root.
- Do not modify external workspaces, user-level agent configuration, or existing user files.
- Do not publish, push, register npm names, or create external resources.
- Do not claim unimplemented commands or adapters are available.
- Do not include personal paths, credentials, local model choices, session identifiers, or private evidence.

---

### Task 1: Bootstrap the independent documentation repository

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `README.ko.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-21-orbitlane-public-readme-design.md`
- Produces: a root English README and linked Korean translation

- [ ] **Step 1: Initialize an independent Git repository**

Run: `git init -b main .`

Expected: Git reports an initialized repository whose top level is the current OrbitLane directory.

- [ ] **Step 2: Add a minimal public `.gitignore`**

Create a file containing Node dependency, build, coverage, environment, log, and OS-editor exclusions without machine-specific paths.

- [ ] **Step 3: Write the English canonical README**

Write the exact sections required by the design: definition, pre-release status, planned quick start, architecture, tier semantics, planned installer, neutral contract example, runtime matrix, OpenCode comparison, cross-platform/privacy statements, FAQ, roadmap, and primary sources.

- [ ] **Step 4: Write the Korean translation**

Translate every material claim and preserve the same status, capability, and privacy boundaries.

- [ ] **Step 5: Validate structure and links**

Run:

```bash
rg -n '^#|^##|^###|https?://' README.md README.ko.md
```

Expected: one H1 per document, matching section coverage, and only intended primary-source links.

### Task 2: Verify public-safety and claim accuracy

**Files:**
- Verify: `README.md`
- Verify: `README.ko.md`
- Verify: `.gitignore`

**Interfaces:**
- Consumes: Task 1 documentation
- Produces: a privacy-safe, internally consistent initial repository state

- [ ] **Step 1: Scan for prohibited private content**

Run:

```bash
rg -n -i 'user-specific-path|private-project-name|session[_ -]?id|api[_ -]?key|evidence/[0-9]|private-provider-model' README.md README.ko.md .gitignore
```

Expected: no matches.

- [ ] **Step 2: Scan for overstated availability**

Run:

```bash
rg -n 'production-ready|hard enforcement|guarantees the effective model|npm install -g orbitlane' README.md README.ko.md
```

Expected: no matches.

- [ ] **Step 3: Confirm planned commands are labeled**

Run:

```bash
rg -n -B3 -A3 'npx orbitlane' README.md README.ko.md
```

Expected: each command appears under an explicit pre-release or planned-installation label.

- [ ] **Step 4: Confirm repository isolation**

Run:

```bash
git rev-parse --show-toplevel
git status --short
```

Expected: top level is the current independent OrbitLane repository; only new public repository files are listed.
