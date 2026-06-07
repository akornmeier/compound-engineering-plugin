// ce-verify-work classify-and-rollup fan-out — Claude Code dynamic workflow.
//
// Classifies each Implementation Unit of one plan against the ACTUAL repo state
// (git history + file/behavior state — never plan checkboxes) and rolls the
// per-unit verdicts up into a per-plan drift rate. Runs as a background workflow
// so the orchestrator's context receives only the final envelope, never the
// per-unit classification reasoning.
//
// SELF-CONTAINED ASSEMBLY: the Workflow runtime cannot import sibling files and
// requires `export const meta` to be the first statement. The deterministic
// parser + roll-up therefore live in the canonical, unit-tested module
// `workflows/drift-rollup.js`. At BUILD TIME, scripts/build-work-vs-plan-workflow.ts
// inlines that module (minus its trailing `export`) at the merge-module marker
// below and writes the committed, runnable `work-vs-plan-fanout.generated.js`.
// The SKILL.md guard reads that generated artifact and hands it to the Workflow
// tool — there is no runtime assembly. As authored here this file is a TEMPLATE,
// not independently runnable (parsePlanUnits/rollupVerdicts are undefined until
// assembly); regenerate after editing it. A freshness test asserts the committed
// generated file matches its sources and keeps meta first.
//
// The Workflow runtime has NO filesystem access, so it cannot read the plan
// itself — the orchestrator passes the plan TEXT in args (it already read the
// file in Phase 1). The dispatched classifier agents DO have file tools and
// inspect git/file state via plan_path.
//
// Inputs (args), produced by the orchestrator. Validated per ADR 0002: the
// orchestrator validates fully (with fs) before invoking; validateArgs re-checks
// structurally and returns invalid_input on a malformed call.
//   run_id     string   REQUIRED, path-safe [A-Za-z0-9_-]+ (interpolated into the
//                       /tmp artifact path; no safe runtime fallback)
//   plan_path  string   REQUIRED, ABSOLUTE (agents Read it for full context)
//   plan_text  string   REQUIRED, the plan file contents (the runtime has no fs)
//   batch_size number   optional, units per classifier agent (default 6)
//   agentType  string   optional; when set, MUST be plugin-namespaced
//                       (compound-engineering:ce-...) — bare ce-* does not
//                       resolve in agent(). The default omits it: a schema-only
//                       general-purpose analysis agent, the proven dispatch path.

export const meta = {
  name: "ce-verify-work-fanout",
  description:
    "Classify a plan's Implementation Units against repo state and roll up a drift rate for ce-verify-work",
  phases: [
    { title: "Classify", detail: "parallel batched unit classifiers, schema'd verdicts" },
    { title: "Roll-up", detail: "deterministic drift rate over attempted units" },
  ],
};

/* __MERGE_MODULE__ */
// Assembly inserts drift-rollup.js here, exposing parsePlanUnits(planText) and
// rollupVerdicts(verdicts).

// ---- args ------------------------------------------------------------------
// The Workflow runtime may deliver `args` as an object OR a JSON string. Parse
// defensively — a naive `args || {}` keeps the raw string, so every A.field is
// undefined and the workflow silently runs empty. A parse failure falls through
// to the input-contract guard below, which rejects it as invalid_input.
let A = args;
if (typeof A === "string") {
  try {
    A = JSON.parse(A);
  } catch (e) {
    log("args was a non-JSON string; treating as empty — the input-contract guard will reject it as invalid_input: " + (e && e.message ? e.message : String(e)));
    A = {};
  }
}
A = A || {};

// Input-contract guard (ADR 0002): a malformed CALL short-circuits with
// status:"invalid_input" BEFORE any agent dispatch — distinct from a degraded
// RUN, so a machine caller can tell "I mis-wired the call" from "the classifier
// had trouble." Structural defense-in-depth; the orchestrator validates fully
// (with fs) before ever invoking the workflow.
function validateArgs(a) {
  if (!a || typeof a !== "object") return { ok: false, error: "args missing or not an object" };
  if (typeof a.run_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(a.run_id)) {
    return { ok: false, error: "run_id missing or not a path-safe [A-Za-z0-9_-]+ token" };
  }
  if (typeof a.plan_path !== "string" || !a.plan_path.startsWith("/")) {
    return { ok: false, error: "plan_path missing or not an absolute path" };
  }
  if (typeof a.plan_text !== "string" || a.plan_text.length === 0) {
    return { ok: false, error: "plan_text missing (the runtime has no fs; the orchestrator must pass the plan contents)" };
  }
  let batch_size = 6;
  if (a.batch_size != null) {
    const n = Number(a.batch_size);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "batch_size must be a positive integer" };
    batch_size = n;
  }
  let agent_type;
  if (a.agentType != null) {
    if (typeof a.agentType !== "string" || a.agentType.indexOf(":") === -1) {
      return { ok: false, error: "agentType, when set, must be plugin-namespaced (e.g. compound-engineering:ce-...)" };
    }
    agent_type = a.agentType;
  }
  return { ok: true, normalized: { run_id: a.run_id, plan_path: a.plan_path, plan_text: a.plan_text, batch_size, agent_type } };
}

// Renderer-safe envelope for a contract violation: mirrors the success
// envelope's shape AND field types (empty collections, null rate) so a caller
// that reads fields does not crash; status + error carry the violation.
function invalidInputEnvelope(error) {
  return {
    status: "invalid_input",
    error,
    drift_rate: null,
    low_confidence: false,
    counts: { done: 0, remaining: 0, drifted: 0, unverifiable: 0, attempted: 0, dropped: 0, failed_batches: 0, total_units: 0 },
    units: [],
    unverifiable: [],
    plan_path: typeof A.plan_path === "string" ? A.plan_path : "",
    artifact_path: "",
    run_id: typeof A.run_id === "string" ? A.run_id : "",
  };
}

const VALIDATION = validateArgs(A);
if (!VALIDATION.ok) {
  log("invalid_input: " + VALIDATION.error);
  return invalidInputEnvelope(VALIDATION.error);
}
const RUN_ID = VALIDATION.normalized.run_id;
const PLAN_PATH = VALIDATION.normalized.plan_path;
const PLAN_TEXT = VALIDATION.normalized.plan_text;
const BATCH_SIZE = VALIDATION.normalized.batch_size;
const AGENT_TYPE = VALIDATION.normalized.agent_type;
const ARTIFACT_DIR = "/tmp/compound-engineering/ce-verify-work/" + RUN_ID;

// Per-batch classifier output: one verdict object per unit (drift-rollup applies
// the evidence-required-for-done/drifted rule on the way in).
const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["u_id", "verdict", "rationale"],
        properties: {
          u_id: { type: "string" },
          verdict: { type: "string", enum: ["done", "remaining", "drifted", "unverifiable"] },
          evidence: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
      },
    },
  },
};

// Concise classifier rubric — the canonical full version is
// references/verdict-rubric.md (which the prose fallback loads). Inlined here
// because the workflow runtime cannot Read sibling files.
const RUBRIC = [
  "Verdicts (classify each unit against ACTUAL repo state — git + file state only):",
  "- done: declared Files present AND Verification satisfied by current repo state. REQUIRES non-empty evidence (cite existing paths, landing commits, the satisfying code/test).",
  "- remaining: NO git evidence the unit was attempted (no commit touched its declared paths). Progress, not rework — excluded from the drift rate. Inferred from absence of an attempt, never from 'not recently touched'.",
  "- drifted: a commit DID touch the declared paths BUT the repo diverged (Verification unmet, Files partial/deleted). Rework-shaped. REQUIRES non-empty evidence citing BOTH the attempt and the divergence.",
  "- unverifiable: HIGHEST BAR — Verification is intrinsically behavioral/runtime (e.g. 'improves latency') and cannot be settled from static repo state. A unit with concrete Files and a statically-checkable Verification is NEVER unverifiable.",
  "Rules: never read legacy [ ]/[x] checkbox marks as state. On a borderline statically-checkable call, lean drifted over a false done; never escape a checkable unit to unverifiable. When a touched path is shared across units, adjudicate by the unit's own Verification.",
].join("\n");

function unitBlock(u) {
  return [
    "### " + u.u_id + ". " + u.name,
    "Goal: " + (u.goal || "(none)"),
    "Declared files: " + (u.files && u.files.all.length ? u.files.all.join(", ") : "(none declared)"),
    "Verification: " + (u.verification || "(none stated)"),
  ].join("\n");
}

function batchPrompt(units) {
  return [
    "Classify each Implementation Unit below against the ACTUAL state of this git repository.",
    "Read the full plan for each unit's complete Goal/Approach/Verification: " + PLAN_PATH,
    "",
    RUBRIC,
    "",
    "Inspect repo state with native file tools (Read/Grep/Glob) and single, unchained git commands run one at a time:",
    "  - do the declared file paths exist, and with the claimed capability? (Read/Glob)",
    "  - did any commit touch a declared path? (git log --oneline -- <path>) and what changed? (git log -p -- <path>)",
    "  - is the Verification satisfied by what is actually present?",
    "Treat 'file absent' / 'no such ref' as DATA (a remaining or drifted signal), never an aborting error.",
    "",
    "Units to classify in this batch:",
    "",
    units.map(unitBlock).join("\n\n"),
    "",
    "Return ONE verdict object per unit, u_id verbatim. done and drifted REQUIRE a non-empty evidence array (repo-relative paths, commit SHAs, diff-hunk references). Keep rationale to one sentence.",
  ].join("\n");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- classify --------------------------------------------------------------
phase("Classify");

const UNITS = parsePlanUnits(PLAN_TEXT);
if (UNITS.length === 0) {
  // The orchestrator should have caught this; defend the boundary anyway.
  return invalidInputEnvelope("plan_text parsed to zero Implementation Units");
}

const batches = chunk(UNITS, BATCH_SIZE);
const results = await parallel(
  batches.map((batch, i) => () =>
    agent(batchPrompt(batch), {
      label: "classify:batch-" + (i + 1),
      phase: "Classify",
      schema: VERDICT_SCHEMA,
      ...(AGENT_TYPE ? { agentType: AGENT_TYPE } : {}),
    })
      .then((r) => {
        if (r && Array.isArray(r.verdicts)) return { ok: true, verdicts: r.verdicts };
        log("classify batch " + (i + 1) + " returned no verdicts");
        return { ok: false, verdicts: [] };
      })
      .catch((e) => {
        // Surface dispatch/runtime failures — a swallowed agentType-resolution
        // error reads as an empty, confidently-wrong drift rate.
        log("classify batch " + (i + 1) + " failed: " + (e && e.message ? e.message : String(e)));
        return { ok: false, verdicts: [] };
      }),
  ),
);

// ---- roll-up ---------------------------------------------------------------
phase("Roll-up");

const failedBatches = results.filter((r) => !r.ok).length;
const allVerdicts = results.flatMap((r) => r.verdicts);
const rolled = rollupVerdicts(allVerdicts);
const status = failedBatches > 0 ? "degraded" : "complete";

log(
  "Classified " + UNITS.length + " units in " + batches.length + " batches" +
    (failedBatches ? " (" + failedBatches + " failed)" : "") +
    "; drift_rate " + (rolled.drift_rate == null ? "n/a" : rolled.drift_rate.toFixed(2)) +
    (rolled.low_confidence ? " [low_confidence]" : ""),
);

return {
  status,
  drift_rate: rolled.drift_rate,
  low_confidence: rolled.low_confidence,
  counts: { ...rolled.counts, failed_batches: failedBatches, total_units: UNITS.length },
  units: rolled.units,
  unverifiable: rolled.unverifiable,
  plan_path: PLAN_PATH,
  artifact_path: ARTIFACT_DIR + "/",
  run_id: RUN_ID,
};
