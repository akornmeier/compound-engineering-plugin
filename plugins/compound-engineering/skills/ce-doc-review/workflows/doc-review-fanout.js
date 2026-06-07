// ce-doc-review report-only fan-out — Claude Code dynamic workflow.
//
// Converts the mode:headless persona fan-out + synthesis pipeline into a
// background workflow so the orchestrator's context (and its caller's — ce-plan
// Phase 5.3.8, ce-brainstorm Phase 4) receives only the final envelope, never
// the per-persona findings or the synthesis working memory.
//
// SELF-CONTAINED ASSEMBLY: the Workflow runtime cannot import sibling files and
// requires `export const meta` to be the first statement. The clean-mechanical
// synthesis brackets therefore live in the canonical, unit-tested module
// `workflows/merge-doc-findings.js`. At BUILD TIME, scripts/build-doc-review-workflow.ts
// inlines that module (minus its trailing `export`) at the merge-module marker
// below and writes the committed, runnable `doc-review-fanout.generated.js`. The
// SKILL.md mode:headless guard reads that generated artifact and hands it to the
// Workflow tool — there is no runtime assembly. As authored here this file is a
// TEMPLATE, not independently runnable (mergeFront/mergeBack are undefined until
// assembly); regenerate after editing it.
//
// PIPELINE SPLIT (Key Decision 2): JS owns the contiguous clean-mechanical front
// (3.1-3.3) and back (3.7-3.9); ONE context-isolated synthesis agent owns the
// contiguous interleaved middle (3.3b -> 3.4 -> 3.5 -> 3.5b -> 3.5c -> 3.6) in
// mandated pipeline order, because those steps carry bidirectional data
// dependencies that a clean mechanical/judgment split would invert.
//
// Inputs (args), produced by the orchestrator's Phase 1. Validated per ADR 0002:
// the orchestrator validates fully (with fs) before invoking; validateArgs (in
// the inlined merge module) re-checks structurally and returns invalid_input on
// a malformed call. All fields are REQUIRED except origin_path.
//   run_id         string   REQUIRED, path-safe [A-Za-z0-9_-]+ (no fs/random in the
//                           runtime -> cannot mint a collision-free fallback)
//   personas       [{ name, agentType, model? }]  REQUIRED, non-empty; each name
//                           path-safe ([A-Za-z0-9_-]+, used in the artifact path),
//                           each agentType non-empty (selection is model-side)
//   document_path  string   REQUIRED, ABSOLUTE (orchestrator resolves; personas Read it)
//   document_type  "requirements" | "plan"  REQUIRED (enum)
//   origin_path    string   optional -> defaults to "none" (origin: frontmatter value)

export const meta = {
  name: "ce-doc-review-fanout",
  description:
    "Report-only persona fan-out + synthesis-agent + deterministic merge for ce-doc-review mode:headless",
  phases: [
    { title: "Fan-out", detail: "parallel persona reviewers, schema'd, full findings" },
    { title: "Synthesize", detail: "one context-isolated agent runs the 3.3b-3.6 middle" },
    { title: "Merge", detail: "deterministic route/sort/suppress + protected drop" },
  ],
};

/* __MERGE_MODULE__ */
// Assembly inserts merge-doc-findings.js here, exposing mergeFront(returns) and
// mergeBack(annotated, softBuckets).

// ---- args ------------------------------------------------------------------
// The Workflow runtime may deliver `args` as an object OR a JSON string. Parse
// defensively — a naive `args || {}` keeps the raw string; here a parse failure
// falls through to the input-contract guard below, which rejects it as
// invalid_input rather than running all-defaults (the "empty review" mode).
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
// status:"invalid_input" BEFORE any agent dispatch — kept distinct from a
// degraded RUN so a machine caller can tell "I mis-wired the call" from "the
// reviewers had trouble." This is the structural defense-in-depth tier; the
// orchestrator validates fully (with fs access) before ever invoking the
// workflow. Bare `|| default` parsing here would re-create exactly the silent
// empty-output the conversion's live-boundary learning was written to stop.
const VALIDATION = validateArgs(A);
if (!VALIDATION.ok) {
  log("invalid_input: " + VALIDATION.error);
  return invalidInputEnvelope(VALIDATION.error);
}
const RUN_ID = VALIDATION.normalized.run_id;
const ARTIFACT_DIR = "/tmp/compound-engineering/ce-doc-review/" + RUN_ID;
const PERSONAS = VALIDATION.normalized.personas;
const DOCUMENT_PATH = VALIDATION.normalized.document_path;
const DOCUMENT_TYPE = VALIDATION.normalized.document_type;
const ORIGIN_PATH = VALIDATION.normalized.origin_path;

// Renderer-safe envelope for a contract violation (ADR 0002): mirrors the
// success envelope's shape AND field types — empty collections and empty strings,
// never null — so a caller that reads fields (even string ops like .startsWith)
// does not crash; status + error carry the contract violation, not the run.
function invalidInputEnvelope(error) {
  return {
    status: "invalid_input",
    error,
    document_type: "",
    reviewers: [],
    fixes_to_apply: [],
    proposed_fixes: [],
    decisions: [],
    fyi: [],
    residual_risks: [],
    deferred_questions: [],
    coverage: {
      dropped: 0,
      dropped_returns: 0,
      dropped_findings: 0,
      malformed_agents: 0,
      dedup_merged: 0,
      dropped_agents: 0,
      restated: 0,
      chains: { roots: 0, dependents: 0 },
    },
    run_id: typeof A.run_id === "string" ? A.run_id : "",
    artifact_path: "",
  };
}

// Full findings schema (findings-schema.json). Personas return FULL findings —
// why_it_matters + evidence are NOT stripped, because the synthesis agent needs
// them for collapse, contradiction, and chain linking (Key Decision 7). The
// detail stays in the workflow runtime; only the final envelope leaves it.
const FINDINGS_SCHEMA = {
  type: "object",
  required: ["reviewer", "findings", "residual_risks", "deferred_questions"],
  properties: {
    reviewer: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "title",
          "severity",
          "section",
          "why_it_matters",
          "finding_type",
          "autofix_class",
          "confidence",
          "evidence",
        ],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          section: { type: "string" },
          why_it_matters: { type: "string" },
          finding_type: { type: "string", enum: ["error", "omission"] },
          autofix_class: { type: "string", enum: ["safe_auto", "gated_auto", "manual"] },
          suggested_fix: { type: ["string", "null"] },
          confidence: { type: "integer", enum: [0, 25, 50, 75, 100] },
          evidence: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
    residual_risks: { type: "array", items: { type: "string" } },
    deferred_questions: { type: "array", items: { type: "string" } },
  },
};

// Synthesis-agent output schema — array-in (post-mergeFront findings) /
// annotated-array-out, keyed by the stable finding id. This round-trip shape has
// no template precedent (code-review's only second-stage agent returned a 2-field
// verdict per finding); it is specified concretely here.
const SYNTHESIS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "confidence", "autofix_class", "recommended_action", "depends_on", "dependents"],
        properties: {
          id: { type: "string" },
          confidence: { type: "integer", enum: [0, 25, 50, 75, 100] }, // post-3.3b demote / 3.4 promote
          autofix_class: { type: "string", enum: ["safe_auto", "gated_auto", "manual"] }, // post-3.6
          recommended_action: { type: "string", enum: ["Apply", "Defer", "Skip"] }, // post-3.5b
          suggested_fix: { type: ["string", "null"] },
          depends_on: { type: ["string", "null"] }, // post-3.5c
          dependents: { type: "array", items: { type: "string" } }, // post-3.5c
          variant_count: { type: "integer" }, // post-3.3b: related variants demoted on the kept finding
          // For agent-emitted contradiction-combined findings (3.5), the full
          // display fields are supplied and is_new is set.
          is_new: { type: "boolean" },
          section: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          finding_type: { type: "string", enum: ["error", "omission"] },
          why_it_matters: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          reviewers: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

// ---- persona prompt --------------------------------------------------------
// Lean by design (mirrors the code-review template): persona identity + domain
// calibration come from the agentType (the persona agent file); the schema
// enforces enum structure. Round-1 only — the empty decision primer means the
// persona runs with no prior-round suppression (R29/R30 are orchestrator-side
// and never fire in single-round headless).
function personaPrompt(p) {
  return [
    "You are a specialist document reviewer. Review the document strictly through your reviewer persona.",
    "",
    "Document type: " + DOCUMENT_TYPE,
    "Document path (Read this file): " + DOCUMENT_PATH,
    "Origin: " + ORIGIN_PATH,
    "",
    "<prior-decisions>",
    "Round 1 — no prior decisions.",
    "</prior-decisions>",
    "",
    "Read the document at the path above and analyze it through your persona. You are",
    "operationally read-only: do not edit the document. Use the anchored confidence",
    "rubric and the false-positive suppression rules from your persona definition;",
    "suppress anything you cannot honestly anchor at 50 or higher.",
    "",
    "Write your FULL analysis (every finding with why_it_matters and evidence) to",
    "this exact path (no trailing punctuation): " + ARTIFACT_DIR + "/" + p.name + ".json",
    "Return the FULL findings object matching the schema (keep why_it_matters and",
    "evidence — synthesis needs them). Set reviewer to \"" + p.name + "\".",
    "Return an empty findings array if nothing qualifies.",
  ].join("\n");
}

// ---- synthesis agent -------------------------------------------------------
// One context-isolated call that owns the contiguous interleaved middle of the
// pipeline. The step definitions are inlined (the workflow runtime cannot Read
// the reference file) and are faithful to references/synthesis-and-presentation.md.
function synthesisInput(findings) {
  return findings.map((f) => ({
    id: f.id,
    section: f.section,
    title: f.title,
    severity: f.severity,
    finding_type: f.finding_type,
    autofix_class: f.autofix_class,
    confidence: f.confidence,
    why_it_matters: f.why_it_matters,
    evidence: f.evidence,
    suggested_fix: f.suggested_fix,
    reviewers: f.reviewers,
  }));
}

function synthesisPrompt(findings) {
  return [
    "You are the synthesis stage of a multi-persona document review. The mechanical",
    "front (schema validation, anchor gate, cross-persona dedup) has already run. Your",
    "job is the JUDGMENT middle of the pipeline. Run these steps IN THIS EXACT ORDER —",
    "each depends on the previous; do not reorder:",
    "",
    "3.3b SAME-PERSONA PREMISE COLLAPSE. For each persona, cluster that persona's own",
    "findings that share a root premise (same finding_type, overlapping why_it_matters",
    "concern, fixes all obviated by the same upstream decision). For a cluster of N>=3:",
    "keep the single strongest finding (highest anchor, else most concrete evidence),",
    "set its variant_count to N-1, and demote the other N-1 to confidence 50 (FYI).",
    "Demoted variants do NOT participate in 3.4. Collapse within ONE persona only —",
    "never across personas (cross-persona agreement is the independence signal 3.4 rewards).",
    "",
    "3.4 CROSS-PERSONA AGREEMENT PROMOTION. When 2+ independent personas flagged the",
    "same finding (reviewers array length >= 2), promote its anchor one step: 50->75,",
    "75->100. 100 stays. Skip findings demoted in 3.3b.",
    "",
    "3.5 RESOLVE CONTRADICTIONS. When personas disagree on the same section (one says",
    "cut/keep, impossible/essential), emit a NEW combined finding (set is_new:true, a",
    "fresh id, finding_type:error, autofix_class:manual) presenting both sides as a",
    "tradeoff — not a verdict. Same-issue agreement (no disagreement) is already merged;",
    "do not emit a contradiction for it.",
    "",
    "3.5b RECOMMENDED-ACTION TIE-BREAK. Every finding gets exactly one recommended_action.",
    "Scan contributing personas' implied actions in this order, most conservative first —",
    "Skip > Defer > Apply — first match wins. Persona-to-action: safe_auto/gated_auto =>",
    "Apply; manual with a concrete recommended fix => Apply; manual tradeoff/scope question",
    "with no recommended resolution => Defer; low-confidence/suppression-eligible or",
    "'keep as-is' in a contradiction => Skip. If all silent: suggested_fix present => Apply,",
    "absent => Defer. INVARIANT: if the winner is Apply but the finding has no suggested_fix",
    "after 3.6, downgrade to Defer.",
    "",
    "3.5c PREMISE-DEPENDENCY CHAIN LINKING. Identify ROOTS: a finding is a root candidate",
    "only when ALL hold — severity P0 or P1; autofix_class manual; it challenges a",
    "FOUNDATIONAL premise (is X justified / premise unsupported / do-nothing baseline not",
    "evaluated / is the approach right); and its section is framing-level (Summary, Problem",
    "Frame, Overview, Why, Motivation, Goals) OR it questions whether a named component",
    "should exist. Elevate ALL matching roots. For each root, find DEPENDENTS among the",
    "remaining findings: the dependent targets the same component the root challenges, and",
    "its concern would DISSOLVE if the root's premise is rejected. INDEPENDENCE SAFEGUARD —",
    "do NOT link a finding that stands on its own (operational obligations like rollback,",
    "error handling, test coverage; evidence-grounded codebase facts; any safe_auto). When",
    "uncertain, do NOT link. Annotate depends_on (root id) on each dependent and dependents",
    "(array of dependent ids) on each root. A dependent links to at most one root. Cap",
    "dependents at 6 per root (keep top 6 by severity, then anchor desc, then document order).",
    "Linking is annotative only — do not re-route or change anchors here.",
    "",
    "3.6 PROMOTE AUTO-ELIGIBLE FINDINGS. Scan manual findings for promotion to gated_auto",
    "(codebase-pattern-resolved with a concrete cited reference; factually incorrect behavior;",
    "missing standard security/reliability control with an established fix; framework-native-API",
    "substitution) or safe_auto (mechanically-implied completeness with exactly one correct",
    "addition). Do NOT promote scope/priority changes where the author may have weighed hidden",
    "tradeoffs. STRAWMAN SAFEGUARD: if a safe_auto names dismissed alternatives that are",
    "actually plausible, downgrade to gated_auto.",
    "",
    "Return the SAME findings keyed by id, each annotated with its final confidence (post-3.3b/3.4),",
    "autofix_class (post-3.6), recommended_action (post-3.5b), depends_on/dependents (post-3.5c),",
    "variant_count (post-3.3b), and suggested_fix. Include any new contradiction findings with",
    "is_new:true and full display fields (section, title, severity, finding_type, why_it_matters,",
    "evidence, reviewers). Do not drop input findings — every input id must appear in the output.",
    "",
    "Findings (JSON):",
    JSON.stringify(synthesisInput(findings), null, 2),
  ].join("\n");
}

// Re-associate the agent's annotations back onto the front findings by id, and
// append any new contradiction findings. Returns the annotated set mergeBack
// consumes. Used both for the happy path and (with an identity annotator) for
// the degraded fallback when the synthesis agent fails.
function applyAnnotations(frontFindings, synthFindings) {
  const annById = new Map();
  for (const a of Array.isArray(synthFindings) ? synthFindings : []) {
    if (a && typeof a.id === "string") annById.set(a.id, a);
  }
  const frontIds = new Set(frontFindings.map((f) => f.id));
  const out = frontFindings.map((f) => {
    const a = annById.get(f.id);
    if (!a) return { ...f, recommended_action: defaultAction(f), depends_on: null, dependents: [], variant_count: 0 };
    return {
      ...f,
      confidence: VALID_OK(a.confidence) ? a.confidence : f.confidence,
      autofix_class: a.autofix_class || f.autofix_class,
      // Coalesce, do not overwrite: an agent returning an explicit null must not
      // erase a front-supplied fix (which would demote a safe_auto@100 out of the
      // apply bucket). The agent may still REPLACE it with a new non-null fix.
      suggested_fix: a.suggested_fix != null ? a.suggested_fix : f.suggested_fix,
      recommended_action: a.recommended_action || defaultAction(f),
      depends_on: typeof a.depends_on === "string" ? a.depends_on : null,
      dependents: Array.isArray(a.dependents) ? a.dependents : [],
      variant_count: Number.isInteger(a.variant_count) ? a.variant_count : 0,
    };
  });
  // Agent-emitted contradiction findings (ids not present in the front set).
  let order = frontFindings.length;
  for (const a of Array.isArray(synthFindings) ? synthFindings : []) {
    if (!a || typeof a.id !== "string" || frontIds.has(a.id)) continue;
    out.push({
      id: a.id,
      section: a.section || "",
      title: a.title || "",
      severity: a.severity || "P2",
      finding_type: a.finding_type || "error",
      autofix_class: a.autofix_class || "manual",
      confidence: VALID_OK(a.confidence) ? a.confidence : 75,
      why_it_matters: a.why_it_matters || "",
      evidence: Array.isArray(a.evidence) ? a.evidence : [],
      suggested_fix: a.suggested_fix ?? null,
      reviewers: Array.isArray(a.reviewers) ? a.reviewers : [],
      recommended_action: a.recommended_action || "Defer",
      depends_on: typeof a.depends_on === "string" ? a.depends_on : null,
      dependents: Array.isArray(a.dependents) ? a.dependents : [],
      variant_count: 0,
      _order: order++,
    });
  }
  return out;
}
function VALID_OK(c) {
  return c === 0 || c === 25 || c === 50 || c === 75 || c === 100;
}
function defaultAction(f) {
  return f.suggested_fix && String(f.suggested_fix).trim() ? "Apply" : "Defer";
}

// ---- fan-out ---------------------------------------------------------------
phase("Fan-out");

const structured = await parallel(
  PERSONAS.map((p) => () =>
    agent(personaPrompt(p), {
      label: "review:" + p.name,
      phase: "Fan-out",
      agentType: p.agentType,
      schema: FINDINGS_SCHEMA,
      ...(p.model ? { model: p.model } : {}),
    })
      .then((r) => (r ? { ...r, reviewer: r.reviewer || p.name } : null))
      .catch((e) => {
        // Surface dispatch/runtime failures — a swallowed agentType-resolution
        // error reads as a (wrong) empty review.
        log("persona " + p.name + " (" + p.agentType + ") failed: " + (e && e.message ? e.message : String(e)));
        return null;
      }),
  ),
);

const validReturns = structured.filter(Boolean);
const droppedAgents = PERSONAS.length - validReturns.length;

// ---- mechanical front (3.1-3.3) --------------------------------------------
const front = mergeFront(validReturns);

// ---- synthesis (3.3b-3.6) --------------------------------------------------
phase("Synthesize");

let annotated;
let synthesisFailed = false;
if (front.findings.length === 0) {
  annotated = [];
} else {
  const synth = await agent(synthesisPrompt(front.findings), {
    label: "synthesize",
    phase: "Synthesize",
    schema: SYNTHESIS_SCHEMA,
  })
    .then((r) => r)
    .catch((e) => {
      log("synthesis agent failed: " + (e && e.message ? e.message : String(e)));
      return null;
    });
  if (synth && Array.isArray(synth.findings)) {
    annotated = applyAnnotations(front.findings, synth.findings);
  } else {
    // Degrade rather than throw: route the un-annotated front findings so no
    // finding is lost (no promotion/collapse/chains, deterministic defaults).
    synthesisFailed = true;
    annotated = applyAnnotations(front.findings, []);
  }
}

// ---- mechanical back (3.7-3.9 + protected drop) ----------------------------
phase("Merge");
const back = mergeBack(annotated, {
  residual_risks: front.residual_risks,
  deferred_questions: front.deferred_questions,
});

const status =
  validReturns.length === 0 || droppedAgents > 0 || synthesisFailed ? "degraded" : "complete";

log(
  "Report-only complete: " +
    validReturns.length +
    "/" +
    PERSONAS.length +
    " reviewers, " +
    (back.applied.length + back.proposed_fixes.length + back.decisions.length) +
    " actionable, " +
    back.fyi.length +
    " FYI",
);

return {
  status,
  document_type: DOCUMENT_TYPE,
  reviewers: validReturns.map((r) => r.reviewer),
  // The workflow is REPORT-ONLY: it never mutates the document. fixes_to_apply
  // are the anchor-100 safe_auto fixes the ORCHESTRATOR applies after this returns.
  fixes_to_apply: back.applied,
  proposed_fixes: back.proposed_fixes,
  decisions: back.decisions,
  fyi: back.fyi,
  residual_risks: back.residual_risks,
  deferred_questions: back.deferred_questions,
  coverage: {
    dropped: front.coverage.dropped,
    dropped_returns: front.coverage.dropped_returns,
    dropped_findings: front.coverage.dropped_findings,
    malformed_agents: front.coverage.malformed_agents,
    dedup_merged: front.coverage.dedup_merged,
    dropped_agents: droppedAgents,
    restated: back.coverage.restated,
    chains: back.coverage.chains,
  },
  run_id: RUN_ID,
  artifact_path: ARTIFACT_DIR + "/",
};
