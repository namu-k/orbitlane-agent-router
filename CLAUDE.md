@AGENTS.md

## Claude Code

Everything above is shared with Codex/OMX via `AGENTS.md`. Only Claude Code-specific
instructions belong below this line.

### Skill routing

An explicit slash-skill request invokes that skill. Natural-language similarity may be suggested after direct work starts, but does not invoke a skill or interrupt execution.

Explicit routing examples:
- Product ideas/brainstorming → `/office-hours`
- Strategy/scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Design system/plan review → `/design-consultation` or `/plan-design-review`
- Full review pipeline → `/autoplan`
- Bugs/errors → `/investigate`
- QA/testing site behavior → `/qa` or `/qa-only`
- Code review/diff check → `/review`
- Visual polish → `/design-review`
- Ship/deploy/PR → `/ship` or `/land-and-deploy`
- Save progress → `/context-save`
- Resume context → `/context-restore`
- Author a backlog-ready spec/issue → `/spec`
