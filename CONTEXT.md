# Dynamic Workflows Conversion Program

The vocabulary for moving compound-engineering's fan-out-heavy skill steps off hand-orchestrated prose and onto Claude Code dynamic workflows. This glossary exists to keep the program's load-bearing terms unambiguous — several were overloaded and hid a real contradiction.

## Language

**Conversion**:
Moving one fan-out skill step from prose orchestration to a dynamic-workflow script (fan out → collect → synthesize in background, return only the final answer).
_Avoid_: migration, port (those imply mechanical 1:1; a conversion carves a non-interactive sub-step out of an interactive skill).

**Candidacy gate** (R1):
The _per-candidate_ test: the step must be a non-interactive batch, or be splittable so only its non-interactive sub-step converts.
_Avoid_: "the hard gate" used alone — ambiguous against **Signal gate**.

**Signal gate**:
A _per-metric_ discipline: a metric-track's conversions must produce that metric's signal before the track is committed. It governs **one STRATEGY metric's candidates**, not the whole program — a drift-rate reading authorizes only the **Rework/churn**-justified conversions, never a Learnings-reuse one. On failure (signal below threshold): **halt that track and reallocate** to the others; do not touch already-landed conversions. Distinct from the Candidacy gate — that tests a candidate; this tests one track's right to keep going.
_Avoid_: "the gate" used alone; treating it as program-wide.

**Timing trigger**:
A _relevance_ gate: convert a candidate only once it becomes worth doing, regardless of evidence quality. Distinct from the Candidacy gate (is it eligible?) and the Signal gate (is the thesis supported?). The retrieve (R9) candidate's store-size threshold is a timing trigger — recall does not bite until the corpus is large. Made real (not theater) by wiring the `docs/solutions/` file count into `ce-compound-refresh`'s existing corpus walk, so something actually reads it.
_Avoid_: "threshold gate" used alone — name which of the three it is.

**Probe**:
A conversion done primarily to _produce the missing rework/churn signal_, not for its own payoff. The Signal gate is satisfied by a probe.

**The compounding loop** (the spine):
Capture → Retrieve → Maintain → Understand — the memory mechanism. In the map it is the **loop-position axis**: it *classifies* candidates (and defines "loop-internal" for R14) and maps consume/produce dependencies. It does **not** prioritize — that is the **Track** axis. The two are **orthogonal** (loop-position × metric) and cross-cut. An organizing principle, never a runtime dependency.
_Avoid_: "the memory loop" and "the spine" as different things (same loop); claiming the spine *prioritizes* (it classifies — the highest-leverage *domain* is not the same as what converts first).

**Loop-internal vs consumer** (conversion kinds, for R14):
A conversion is **loop-internal** if it occupies a core spine position (Capture / Retrieve / Maintain / Understand) — operating on the store *is* its job. It is a **consumer** if it only reads/writes through the seams (the Review branch + net-new). R14's reject-test has a separate profile for each (§7).

**Marginal-over-baseline**:
A candidate's value is the increment over its _existing headless/agent mode_, not over its interactive mode. The denominator is what today's headless path already stages to disk.

**Drift rate**:
The **Signal gate**'s reading: the fraction of a plan's *attempted* tasks (`done + drifted`) that *drifted* (claimed done but the repo diverged, or claimed done but not actually done). The denominator is the attempted-and-verifiable set, **not** total tasks — never-started (`remaining`) and not-statically-settleable (`unverifiable`) tasks are excluded, so the rate measures rework rather than plan-completion stage (`ce-verify-work` ships this operational definition). **Derived at read-time** by aggregating drift learnings captured via `ce-compound` + session history — never stored as a number (that would reopen the out-of-scope task-ledger). The proxy for **rework/churn**.
_Avoid_: conflating with "done-vs-remaining" (that is progress; drift is the redo-shaped subset).

**Track**:
A per-metric grouping of conversion candidates that share one gate and one STRATEGY metric (Rework/churn, Learnings reuse, or Loop adoption). The **prioritization + gating axis** — orthogonal to the loop-position spine, which it cross-cuts (one track can span several spine phases; one spine phase can fragment across tracks). Candidates within a track are ordered; candidates across tracks do not compete. Replaces the single linear §6 queue.
_Avoid_: "the queue" as a single ranked list — that flat shape hid the gate and caused the march; conflating a track with a spine phase.

**Phase 0 (pattern-proving)**:
The bootstrapping conversions (ce-code-review, ce-doc-review) justified by *de-risking and proving the workflow pattern*, **not** by any STRATEGY metric. Complete. Sits outside the three metric-**Track**s.
_Avoid_: tagging these with a metric (Rework/churn etc.) — that is the post-hoc rationalization ADR 0001 retags away.

**Input contract** (per conversion):
The data a conversion's orchestrator stages into the workflow runtime — the seam the conversion creates. The term is overloaded across three nested boundaries; **unqualified it means the outermost**: orchestrator → workflow (the `args`). The inner two are the **persona input** (workflow → each fan-out agent) and the **synthesis input** (merged findings → the synthesis agent). Name the boundary whenever it is not the outermost.
_Avoid_: "the input" alone when more than one boundary is in play.

**Caller-contract violation vs runtime degradation** (envelope outcome classes):
A converted workflow's return envelope keeps three outcomes distinct: **complete** (valid call, full run), **degraded** (valid call, but some fan-out/synthesis agents failed — a *runtime* outcome), and **invalid_input** (a required input was missing or malformed — the *call itself* was wrong). Collapsing the third into the second blinds the machine callers that consume the envelope — they cannot tell "I mis-wired the call" from "the agents had trouble." Required-input validation is **layered**: the orchestrator validates fully before invoking (it alone holds the upstream context and can touch the filesystem), and the workflow re-checks structurally as defense for non-orchestrator callers.
_Avoid_: one "failed" status standing for both a bad call and a bad run. (Pattern governed by ADR 0002.)

## Relationships

- A **Conversion** must pass the **Candidacy gate** to be eligible; on a gated **Track**, its probe must satisfy that track's **Signal gate** before the rest of the track is authorized.
- A **Probe** is a **Conversion** whose purpose is to feed a **Signal gate**.
- The **compounding loop** (spine) and the **Track** are **orthogonal axes** — loop-position classifies, track prioritizes; they cross-cut. Neither couples to the candidates at runtime.

## Flagged ambiguities

- "gate" absorbed **three** distinct ideas — **resolved** into **Candidacy gate** (is the step eligible? R1 non-interactive), **Signal gate** (is the metric's thesis supported by evidence? per-metric, drift for Rework/churn), and **Timing trigger** (is it relevant yet? retrieve's store-size). The overload let the program march rank 0 → 1 → 2 while believing it was still gated, and let an unread placeholder ("a set size") pose as a real gate.
- "input contract" absorbed **three** nested boundaries — **resolved** into **Input contract** (orchestrator → workflow `args`, the default reading), **persona input** (workflow → fan-out agent), and **synthesis input** (merged findings → synthesis agent). The overload hid which seam a decision governed; unqualified "input contract" now means the outermost.
