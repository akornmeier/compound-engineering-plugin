// ce-code-review report-only fan-out — Claude Code dynamic workflow.
//
// Converts Stage 4 (parallel persona dispatch) + Stage 5 (merge) of the
// mode:agent path into a background workflow so the orchestrator's context
// receives only the final merged envelope, never the per-persona returns.
//
// SELF-CONTAINED ASSEMBLY: the Workflow runtime cannot import sibling files,
// and it requires `export const meta` to be the first statement. The merge
// logic therefore lives in the canonical, unit-tested module
// `workflows/merge-findings.js`. Before invoking, the SKILL.md guard replaces
// the merge-module marker below (the lone block-comment placeholder) with that
// module's source minus its trailing `export` line, then passes the assembled
// string as the Workflow
// `script`. As authored here the file is a template, not independently runnable
// (mergeFindings is undefined until assembly). A converter/sync test (U4)
// asserts the assembled product parses and keeps meta first.
//
// Inputs (args), all produced by the orchestrator's Stages 1-3:
//   run_id            string
//   personas          [{ name, agentType, model? }]   structured reviewers
//   ceAgents          [{ name, agentType, bucket, model? }]  unstructured CE agents
//   diffPaths         { full, files }                  staged paths (not content)
//   standardsPaths    [string]                         AGENTS.md/CLAUDE.md paths
//   scope             { base, branch, head_sha, pr_url, files_changed }
//   intent            string
//   intent_confidence "explicit" | "inferred" | "uncertain"
//   pr_scope_mode     "local-aligned" | "pr-remote" | "branch-remote"
//   head_ref          string | undefined  (remote head for pr/branch-remote)

export const meta = {
  name: "ce-code-review-fanout",
  description:
    "Report-only persona fan-out + deterministic merge for ce-code-review mode:agent",
  phases: [
    { title: "Fan-out", detail: "parallel persona reviewers + CE agents, schema'd" },
    { title: "Merge", detail: "deterministic dedup/gate/route" },
    { title: "Validate", detail: "independent per-finding validators, drop rejected" },
  ],
};

/* __MERGE_MODULE__ */
// Assembly inserts merge-findings.js here, exposing mergeFindings(returns).

// ---- args ------------------------------------------------------------------
// The Workflow runtime may deliver `args` as an object OR as a JSON string
// (see the platform's example workflows). Accept both.
let A = args;
if (typeof A === "string") {
  try {
    A = JSON.parse(A);
  } catch (e) {
    A = {};
  }
}
A = A || {};
const RUN_ID = A.run_id || "unknown-run";
const ARTIFACT_DIR = "/tmp/compound-engineering/ce-code-review/" + RUN_ID;
const PERSONAS = Array.isArray(A.personas) ? A.personas : [];
const CE_AGENTS = Array.isArray(A.ceAgents) ? A.ceAgents : [];
const DIFF_PATHS = A.diffPaths || {};
const STANDARDS_PATHS = Array.isArray(A.standardsPaths) ? A.standardsPaths : [];
const SCOPE = A.scope || {};
const INTENT = A.intent || "";
const INTENT_CONFIDENCE = A.intent_confidence || "uncertain";
const PR_SCOPE_MODE = A.pr_scope_mode || "local-aligned";
const HEAD_REF = A.head_ref;

// Compact (merge-tier) schema — detail-tier why_it_matters/evidence stay in the
// on-disk artifact and are intentionally omitted from the return.
const COMPACT_SCHEMA = {
  type: "object",
  required: ["reviewer", "findings", "residual_risks", "testing_gaps"],
  properties: {
    reviewer: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "title",
          "severity",
          "file",
          "line",
          "confidence",
          "autofix_class",
          "owner",
          "requires_verification",
          "pre_existing",
        ],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          confidence: { type: "integer", enum: [0, 25, 50, 75, 100] },
          autofix_class: { type: "string", enum: ["gated_auto", "manual", "advisory"] },
          owner: { type: "string", enum: ["downstream-resolver", "human", "release"] },
          requires_verification: { type: "boolean" },
          pre_existing: { type: "boolean" },
          suggested_fix: { type: ["string", "null"] },
        },
      },
    },
    residual_risks: { type: "array", items: { type: "string" } },
    testing_gaps: { type: "array", items: { type: "string" } },
  },
};

// Stage 5b verdict schema — one independent validator per surviving finding.
const VERDICT_SCHEMA = {
  type: "object",
  required: ["validated", "reason"],
  properties: {
    validated: { type: "boolean" },
    reason: { type: "string" },
  },
};

// Shared review bundle — paths only, never inlined content (the child Reads
// what it needs). Scope mode controls how the child inspects cited code.
function reviewBundle() {
  const lines = [
    "Review run id: " + RUN_ID,
    "Scope mode: " + PR_SCOPE_MODE,
    HEAD_REF ? "Remote head ref: " + HEAD_REF : null,
    DIFF_PATHS.full ? "Full diff (Read this path): " + DIFF_PATHS.full : null,
    DIFF_PATHS.files ? "Changed files list (Read this path): " + DIFF_PATHS.files : null,
    STANDARDS_PATHS.length
      ? "Project standards (Read what is relevant): " + STANDARDS_PATHS.join(", ")
      : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function personaPrompt(p) {
  return [
    "Review the staged diff strictly through your reviewer persona.",
    reviewBundle(),
    // Per-persona extra context (e.g. <review-base> for data-migration,
    // <standards-paths> for project-standards) when the orchestrator supplies it.
    p.extraContext ? p.extraContext : "",
    "",
    "In local-aligned scope, Read/Grep the cited code, callers, and guards.",
    "In pr-remote/branch-remote scope, inspect via the remote head ref or diff",
    "hunks only — do not Read workspace paths for in-scope files.",
    "",
    "Write your FULL analysis (including why_it_matters and evidence for every",
    "finding) to " + ARTIFACT_DIR + "/" + p.name + ".json.",
    "Return the COMPACT findings object (omit why_it_matters and evidence).",
    "Set reviewer to \"" + p.name + "\". Return empty findings if nothing qualifies.",
  ].join("\n");
}

function ceAgentPrompt(a) {
  return [
    "Run your standard analysis over the staged diff.",
    reviewBundle(),
    "",
    "Return your findings as prose; they are preserved verbatim for synthesis.",
  ].join("\n");
}

// [INTERP] Verdict derivation — Stage 6 prose synthesizes this from judgment;
// the parity-first port uses a deterministic rule. Parity risk; covered by U5.
function deriveVerdict(findings) {
  if (findings.some((f) => f.severity === "P0")) return "Not ready";
  if (findings.length > 0) return "Ready with fixes";
  return "Ready to merge";
}

// Stage 5b validator prompt — independent re-verification of one finding,
// ported from references/validator-template.md (inlined because the workflow
// runtime cannot Read sibling files).
function validatorPrompt(f) {
  const reviewer = (f.reviewers && f.reviewers[0]) || "reviewer";
  return [
    "You are an independent validator for ONE code review finding. Verify whether",
    "it holds up under fresh inspection. You have no commitment to it; reject false",
    "positives. Conservative bias: when in doubt, reject.",
    "",
    "Finding:",
    "  Title: " + f.title,
    "  Severity: " + f.severity,
    "  File: " + f.file,
    "  Line: " + f.line,
    "  Suggested fix: " + (f.suggested_fix || "(none)"),
    "  Original reviewer(s): " + (f.reviewers || []).join(", "),
    "  Confidence anchor: " + f.confidence,
    "",
    "Optional context (the original why-it-matters): you may Read " +
      ARTIFACT_DIR + "/" + reviewer + ".json; proceed without it if absent.",
    DIFF_PATHS.full ? "Full diff (Read this path): " + DIFF_PATHS.full : "",
    "Scope mode: " + PR_SCOPE_MODE + (HEAD_REF ? " | head ref: " + HEAD_REF : ""),
    "In local-aligned scope, Read/Grep the cited code, its callers, and guards.",
    "In pr-remote/branch-remote, inspect via the head ref or diff hunks only.",
    "",
    "Decide: (1) is the issue real in the code as written; (2) is it introduced by",
    "THIS diff (not pre-existing); (3) is it not already handled by a guard,",
    "middleware, framework default, or type constraint elsewhere?",
    "",
    'Return ONLY {"validated": true|false, "reason": "<one sentence>"}.',
    "If you cannot read the cited file, return validated:false with that reason.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Stage 5b: validate survivors with a bounded budget. P0/P1 are always
// validated (cap raised if they alone exceed 15); the P2/P3 tail beyond the cap
// is dropped from the report and counted. Infra failure drops P2/P3 but keeps
// P0/P1 as degraded — a transient failure must never silently remove a critical
// finding. Findings are identified by their stable merge number.
async function runValidation(findings) {
  const result = {
    survivors: new Set(),
    dropped: [],
    degraded: [],
    validated_true: 0,
    validated_false: 0,
    infra_failures: 0,
    over_budget: 0,
  };
  if (findings.length === 0) return result;

  // findings arrive already sorted severity -> anchor desc by the merge step.
  const criticalCount = findings.filter((f) => f.severity === "P0" || f.severity === "P1").length;
  const cap = Math.max(15, criticalCount);
  const selected = findings.slice(0, cap);
  result.over_budget = findings.length - selected.length;

  const verdicts = await parallel(
    selected.map((f) => () =>
      agent(validatorPrompt(f), {
        label: "validate:#" + f.number,
        phase: "Validate",
        model: "sonnet",
        schema: VERDICT_SCHEMA,
      })
        .then((v) => ({ f, v, infra: false }))
        .catch(() => ({ f, v: null, infra: true })),
    ),
  );

  for (const { f, v, infra } of verdicts) {
    const critical = f.severity === "P0" || f.severity === "P1";
    if (infra || !v || typeof v.validated !== "boolean") {
      result.infra_failures++;
      if (critical) {
        result.survivors.add(f.number);
        result.degraded.push(f.number);
      } else {
        result.dropped.push({ number: f.number, reason: "validator failed" });
      }
      continue;
    }
    if (v.validated) {
      result.validated_true++;
      result.survivors.add(f.number);
    } else {
      result.validated_false++;
      result.dropped.push({ number: f.number, reason: v.reason || "rejected" });
    }
  }
  return result;
}

// ---- fan-out ---------------------------------------------------------------
phase("Fan-out");

const structured = await parallel(
  PERSONAS.map((p) => () =>
    agent(personaPrompt(p), {
      label: "review:" + p.name,
      phase: "Fan-out",
      agentType: p.agentType,
      schema: COMPACT_SCHEMA,
      ...(p.model ? { model: p.model } : {}),
    })
      .then((r) => (r ? { ...r, reviewer: r.reviewer || p.name } : null))
      .catch((e) => {
        // Surface dispatch/runtime failures instead of silently dropping —
        // a swallowed agentType-resolution error reads as an empty review.
        log("persona " + p.name + " (" + p.agentType + ") failed: " + (e && e.message ? e.message : String(e)));
        return null;
      }),
  ),
);

const ceOutputs = await parallel(
  CE_AGENTS.map((a) => () =>
    agent(ceAgentPrompt(a), {
      label: "ce:" + a.name,
      phase: "Fan-out",
      agentType: a.agentType,
      ...(a.model ? { model: a.model } : {}),
    })
      .then((text) => ({ name: a.name, bucket: a.bucket, text }))
      .catch((e) => {
        log("CE agent " + a.name + " (" + a.agentType + ") failed: " + (e && e.message ? e.message : String(e)));
        return null;
      }),
  ),
);

// ---- merge -----------------------------------------------------------------
phase("Merge");

const validReturns = structured.filter(Boolean);
const droppedAgents = PERSONAS.length - validReturns.length;
const merged = mergeFindings(validReturns);

const learnings = [];
const agent_native_gaps = [];
const deployment_notes = [];
for (const o of ceOutputs.filter(Boolean)) {
  if (o.bucket === "learnings") learnings.push(o.text);
  else if (o.bucket === "agent_native") agent_native_gaps.push(o.text);
  else if (o.bucket === "deployment") deployment_notes.push(o.text);
}

// ---- validate (Stage 5b) ---------------------------------------------------
phase("Validate");
const validation = await runValidation(merged.findings);
const survived = (f) => validation.survivors.has(f.number);
const findings = merged.findings.filter(survived);
const actionable_findings = merged.actionable_findings.filter(survived);

const status =
  validReturns.length === 0 || droppedAgents > 0 || validation.degraded.length > 0
    ? "degraded"
    : "complete";

log(
  "Report-only complete: " +
    validReturns.length +
    "/" +
    PERSONAS.length +
    " reviewers, " +
    findings.length +
    " findings after gate + validation",
);

return {
  status,
  verdict: deriveVerdict(findings),
  scope: SCOPE,
  intent: INTENT,
  intent_confidence: INTENT_CONFIDENCE,
  reviewers: validReturns.map((r) => r.reviewer),
  findings,
  actionable_findings,
  pre_existing_findings: merged.pre_existing_findings,
  requirements_completeness: A.requirements_completeness ?? null,
  learnings,
  agent_native_gaps,
  deployment_notes,
  residual_risks: merged.residual_risks,
  testing_gaps: merged.testing_gaps,
  coverage: {
    ...merged.coverage,
    dropped_agents: droppedAgents,
    validation: {
      validated_true: validation.validated_true,
      validated_false: validation.validated_false,
      dropped: validation.dropped,
      degraded: validation.degraded,
      infra_failures: validation.infra_failures,
      over_budget: validation.over_budget,
    },
  },
  artifact_path: ARTIFACT_DIR + "/",
  run_id: RUN_ID,
};
