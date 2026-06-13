# Input-contract validation for dynamic-workflow conversions

Every conversion creates an **input contract** at its outermost seam — the `args` the
orchestrator (a skill's `SKILL.md`) stages into the workflow runtime. The shipped
conversions (ce-code-review, ce-doc-review) parse that contract with bare `|| default`
fallbacks, which means a structurally-valid-but-incomplete call (missing `document_path`,
empty `personas`) silently produces an empty review tagged `status: "degraded"` — the
*same* status a genuine partial-agent failure produces. The machine callers that consume
the envelope (`ce-plan`, `ce-brainstorm`) cannot then distinguish "I mis-wired the call"
from "the reviewers had trouble," which is exactly the silent-empty-output class
`docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md` exists to
prevent. We adopt one validation pattern for **all** conversions:

1. **Required vs defaultable fields are explicit.** A field is *defaultable* only when its
   default is a genuinely correct value (e.g. doc-review's `origin_path -> "none"` = "no
   origin"). Everything load-bearing is *required*. A field is required-by-construction
   when the workflow runtime cannot synthesize a safe fallback — `run_id` is the canonical
   case: it is interpolated into the `/tmp` artifact path, and the runtime has no
   `Date.now()`/`Math.random()`, so the only possible fallback is a fixed string that
   *collides* across concurrent runs. Such a field must be required, never defaulted.

2. **Three distinct envelope outcomes.** `complete` (valid call, full run), `degraded`
   (valid call, some fan-out/synthesis agents failed — a runtime outcome), and
   `invalid_input` (a required input missing/malformed — the call itself was wrong).
   A contract violation short-circuits before dispatch, logs loudly, and returns
   `invalid_input` — it does not throw (throwing kills the run and is harder for a machine
   caller to handle than a returned status) and does not collapse into `degraded`.

3. **Layered validation.** The **orchestrator is the primary validator**: it alone holds
   the upstream context and filesystem access, so it resolves paths to absolute, confirms
   existence (free — it already read the document to classify it), enum-checks classified
   fields, and confirms the resolved agent list is non-empty — failing fast *before*
   spinning up a workflow for a known-bad call. The **workflow keeps a structural guard**
   (non-empty, `startsWith("/")`, enum membership, `run_id` and persona-`name`
   path-safe charset, per-persona `agentType` presence) as defense-in-depth,
   because the contract is consumed by more than the happy-path orchestrator: JSON-string
   `args` delivery and future non-orchestrator callers. The workflow cannot touch the
   filesystem, so it can only do structural checks — semantic validation must live in the
   orchestrator regardless.

## Considered Options (rejected)

- **Keep bare `|| default` parsing** — the status quo; re-creates the silent-empty-output
  the live-boundary learning was written to stop.
- **Throw on a bad call** — visible, but kills the whole workflow run and is harder for a
  machine caller to branch on than a returned `invalid_input` envelope.
- **Workflow-only validation** — spins up a workflow just to reject a call the orchestrator
  already had everything needed to reject, and can never existence-check the path (no fs in
  the runtime).
- **Orchestrator-only validation** — leanest, but abandons defense for JSON-string delivery
  and future callers, the exact audience the defensive parse exists for.
- **Pass document/diff content instead of a path** (sidestep path resolution entirely) —
  what code-review did for diffs, but for doc-review it contradicts the pass-paths-not-content
  decision and re-passes a large document to every persona.

## Consequences

- Adding `invalid_input` to the envelope is a contract change callers branch on; once
  `ce-plan`/`ce-brainstorm` consume it, removing it is breaking.
- Layered validation is **intentionally redundant** — the orchestrator and workflow both
  check. A reader seeing both should read this ADR before "simplifying" one away: the
  redundancy is the untrusted-boundary defense, not an oversight.
- The pattern is **retroactive**: ce-code-review's shipped contract has the same conflation
  and should be brought to this standard when next touched.
- `document_path` becoming absolute leaks home-directory paths into persona prompts and
  artifact contents — accepted as cosmetic.
