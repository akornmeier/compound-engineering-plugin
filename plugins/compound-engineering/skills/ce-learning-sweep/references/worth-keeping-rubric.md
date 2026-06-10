# Worth-keeping rubric

Score every deduped candidate learning with a discrete confidence anchor. Use **exactly one** of `0`, `25`, `50`, `75`, `100` — never a float and never an in-between value. The model cannot meaningfully calibrate at finer granularity, and discrete anchors prevent false-precision gaming. Each anchor below carries a behavioral criterion to self-apply honestly.

The scale is adapted from the plugin's established confidence anchors (`ce-code-review`'s findings schema) to the learning-sweep domain: a candidate is "real and worth keeping" when not knowing it would concretely cost future work.

## The five anchors

**`0` — Not a learning.** A false positive that does not survive light scrutiny: routine code restated as a "learning", a description of what the PR did, a fact already obvious from reading the code, or a pure style preference. Counted only.

**`25` — Speculative.** Might be a transferable learning, but the candidate cannot be grounded from the mined diff, commits, and threads alone — it depends on context the sweep does not have. Could equally be a false positive. Counted only.

**`50` — Real but minor.** The candidate is a genuine, verifiable learning, but it is nitpick-grade: a small convenience, a narrow edge case, or guidance whose absence costs little. There is no concrete downstream consequence a future engineer would hit — only mild friction. Rendered as a one-line near-miss discard, so the tuning data stays visible without burying signal.

**`75` — Keeper.** The candidate names a **concrete downstream consequence** of not knowing it: specific future work that breaks, is redone, or is done wrong without this knowledge — a wrong approach taken, a re-discovered gotcha, a contract that gets violated, a debugging session that repeats. The learning is transferable beyond this PR and actionable. This is the keep bar.

**`100` — Keeper, self-evident.** Everything at `75`, and the downstream consequence is verifiable from the mined evidence itself rather than inferred — the diff, a commit body, or a review thread explicitly states the trap, the cost, or the rule. No interpretation required to see why the next engineer needs it.

## The keep test (the `75` boundary)

A candidate clears `75` only if it answers, concretely: **"What future work breaks, is redone, or is done wrong if no one knows this?"**

- A grounded answer ("the next person to touch the squash-merge path will re-derive that `gh pr view --json commits` survives squash, costing a live verification round") -> `75` or higher.
- No answer beyond strength-of-opinion ("this code could be cleaner", "this pattern seems good") -> `50` at most. Opinion about quality is not a downstream consequence.

When the consequence claim is the candidate's own framing rather than something a competent engineer would concretely encounter, the candidate is observational, not a keeper — land it at `50`.

## Anchor-to-rendering map

| Anchor | Rendering |
|--------|-----------|
| `75`, `100` | **Keeper** — full report entry: anchor, verdict, evidence pointers, capture fuel, verdict-conditional routing |
| `50` | **Near-miss** — one line in the near-miss section (statement + anchor), no capture fuel |
| `0`, `25` | **Counted only** — contributes to the discard count line, never listed individually |

The bias is precision: the experiment's pre-committed bar tolerates roughly one discarded candidate per keeper, so the gate exists to keep the report readable as signal, not as a triage list. When genuinely uncertain between two adjacent anchors, choose the **lower** one — a false keeper costs the reader more than a missed near-miss, because keepers carry routing affordances that invite a capture the corpus may not need.

## False-positive catalog (sweep domain)

These recur as candidates and almost always score below `75`. Recognize and down-score them:

- **Routine code changes restated as learnings.** "This PR added a null check" is what the PR did, not a transferable learning. Unless the *reason* the null check was needed is a non-obvious gotcha, it is `0`.
- **Documentation of what the PR accomplished.** A summary of the change set is PR-description material, not a `docs/solutions/` learning. `0`.
- **Style preferences.** "Prefer early returns", "this name could be clearer" — subjective quality opinions with no concrete downstream cost. `50` at most, usually `0`.
- **Facts obvious from the code.** Anything a competent engineer reads directly off the diff in seconds is not worth a documented learning. `0`.
- **Strength-of-argument framing.** "This approach seems fragile" without naming what concretely breaks is an observation, not a keeper. `50`.
- **Re-statements of an existing rule.** A candidate that merely repeats guidance already documented or already in the project's instruction files adds nothing — score the *learning* low even if the corpus verdict is `already-documented` (the two judgments are independent; a real learning can be `already-documented`, and a non-learning can be `new`).
