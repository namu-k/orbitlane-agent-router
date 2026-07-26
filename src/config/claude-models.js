// Which resolved lane models the guard may write into a Claude Agent tool call.
//
// The guard's only token-saving move is filling in a model the caller left
// unspecified. That move is worth making only when the value is one the Agent tool
// actually accepts: an unaccepted value turns a working spawn into a failed one,
// which costs more than not routing at all.
//
// Deliberately no alias normalization. Mapping `claude-opus-4-1` onto `opus` would
// silently resolve a pinned model to whichever model the alias currently points at
// — a different model, at a different price, without the contract saying so. A
// contract that pins a full identifier gets no injection rather than a substitution.
//
// `fable` is excluded even though the runtime accepts it. It needs Claude Code
// v2.1.170 or later and the guard cannot see the running version, and it is the most
// expensive model on offer — injecting it could never be the cheaper choice this
// router exists to make. A contract may still bind a lane to it; that lane is
// reported `injectable: false` and left to the guidance kernel.
const INJECTABLE_MODELS = Object.freeze(["haiku", "opus", "sonnet"]);

export function injectableClaudeModels() {
  return [...INJECTABLE_MODELS];
}

export function isInjectableClaudeModel(model) {
  return typeof model === "string" && INJECTABLE_MODELS.includes(model);
}
