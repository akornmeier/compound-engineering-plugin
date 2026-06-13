// ce-compound-refresh broad-scope corpus-audit fan-out — Claude Code dynamic workflow.
//
// Converts the broad-scope headless classification pass + the Phase 1.75 cross-doc
// contradiction check into a background workflow, so the orchestrator's context
// receives only the final envelope — the per-doc classification evidence and the
// contradiction reasoning stay in the workflow runtime (the context-fracture the
// opportunity map targets). The workflow is SIDE-EFFECT-FREE: it classifies and
// recommends; the orchestrator applies every file write centrally after the
// envelope returns (KTD2, R10).
//
// SELF-CONTAINED ASSEMBLY: the Workflow runtime cannot import sibling files and
// requires `export const meta` to be the first statement. The deterministic
// classify/roll-up logic therefore lives in the canonical, unit-tested module
// `workflows/classify-rollup.js`. At BUILD TIME, scripts/build-compound-refresh-workflow.ts
// inlines that module (minus its trailing `export`) at the merge-module marker
// below and writes the committed, runnable `corpus-audit-fanout.generated.js`.
// The SKILL.md guard reads that generated artifact and hands it to the Workflow
// tool — there is no runtime assembly. As authored here this file is a TEMPLATE,
// not independently runnable (rollupClassifications/buildClusters/... are undefined
// until assembly); regenerate after editing it. A freshness test asserts the
// committed generated file matches its sources and keeps meta first.
//
// The Workflow runtime has NO filesystem access, so it never reads a doc itself —
// the orchestrator globs docs/solutions/ and passes the PATH LIST in args (KTD3);
// the dispatched classifier and contradiction agents DO have file tools and Read
// the docs they classify/compare. The module only ever touches agent-returned
// structured data, so no raw-file parsing happens in the workflow script.
//
// Inputs (args), produced by the orchestrator (Date.now() is unavailable in the
// runtime, so today/run_id are minted in the orchestrator — live-boundary contract 6):
//   paths               [string]  in-scope docs/solutions/ paths (KTD3 — paths, not contents)
//   solutions_file_count number   in-scope corpus size measured at glob time (R4 — arms B2)
//   run_id              string    path-safe [A-Za-z0-9_-]+, interpolated into the scratch path
//   today               string    YYYY-MM-DD, for stale_date stamping in the orchestrator
//   scope_hint          string    optional scope-narrowing hint, for classifier context

export const meta = {
  name: "ce-compound-refresh-corpus-audit",
  description:
    "Read-only per-doc classifier fan-out + cluster-bounded loop-until-dry contradiction pass for ce-compound-refresh broad-scope headless",
  phases: [
    { title: "Classify", detail: "one read-only classifier per doc, schema'd verdicts" },
    { title: "Contradictions", detail: "cluster-bounded loop-until-dry cross-doc pass" },
  ],
};

/* __MERGE_MODULE__ */
// Assembly inserts classify-rollup.js here, exposing normalizeVerdict,
// rollupClassifications(verdicts, opts), buildClusters(verdicts),
// contradictionTermination(state), and the AMBIGUITY_CONFIDENCE_THRESHOLD /
// CONTRADICTION_K / CONTRADICTION_CAP constants.

// ---- args ------------------------------------------------------------------
// The Workflow runtime may deliver `args` as an object OR a JSON string. Parse
// defensively — a naive `args || {}` keeps the raw string, so every A.field is
// undefined and the workflow silently classifies an empty corpus.
let A = args;
if (typeof A === "string") {
  try {
    A = JSON.parse(A);
  } catch (e) {
    log("args was a non-JSON string; running with an empty corpus: " + (e && e.message ? e.message : String(e)));
    A = {};
  }
}
A = A || {};

const PATHS = Array.isArray(A.paths) ? A.paths.filter((p) => typeof p === "string" && p) : [];
const SOLUTIONS_FILE_COUNT = Number.isInteger(A.solutions_file_count) ? A.solutions_file_count : PATHS.length;
const RUN_ID = typeof A.run_id === "string" && /^[A-Za-z0-9_-]+$/.test(A.run_id) ? A.run_id : "corpus-audit";
const TODAY = typeof A.today === "string" ? A.today : "";
const SCOPE_HINT = typeof A.scope_hint === "string" ? A.scope_hint : "";
const ARTIFACT_DIR = "/tmp/compound-engineering/ce-compound-refresh/" + RUN_ID;

// Compact classify schema (KTD8) — type/required/enum/items only, NO allOf/if/then.
// The Replace-needs-evidence and Delete-needs-signals cross-field rules are
// enforced deterministically in normalizeVerdict (a conditional schema keyword
// the runtime might reject would risk the silent-empty failure mode).
const CLASSIFY_SCHEMA = {
  type: "object",
  required: ["path", "verdict", "confidence", "evidence"],
  properties: {
    path: { type: "string" },
    verdict: { type: "string", enum: ["Keep", "Update", "Consolidate", "Replace", "Delete", "stale"] },
    confidence: { type: "integer", enum: [0, 25, 50, 75, 100] },
    ambiguous: { type: "boolean" },
    replace_evidence_sufficient: { type: "boolean" },
    implementation_gone: { type: "boolean" },
    domain_gone: { type: "boolean" },
    inbound_links_clear: { type: "boolean" },
    module: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    problem_type: { type: "string" },
    evidence: { type: "string" },
  },
};

// Compact contradiction schema — one round's per-cluster cross-doc findings.
const CONTRADICTION_SCHEMA = {
  type: "object",
  required: ["contradictions"],
  properties: {
    contradictions: {
      type: "array",
      items: {
        type: "object",
        required: ["doc_a", "doc_b", "summary"],
        properties: {
          doc_a: { type: "string" },
          doc_b: { type: "string" },
          dimension: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
};

// Concise classifier rubric — the canonical full version is the SKILL.md
// Maintenance Model + Core Rules; inlined here because the workflow runtime
// cannot Read sibling files.
const RUBRIC = [
  "Classify this docs/solutions/ learning against the CURRENT codebase. Verdicts:",
  "- Keep: still accurate and useful (no edit).",
  "- Update: core solution still correct, but references drifted (paths/classes/links/metadata).",
  "- Consolidate: overlaps heavily with another doc, both correct — one subsumes the other.",
  "- Replace: the recommended guidance is now misleading; a better successor is documentable.",
  "- Delete: the implementation AND the problem domain are gone, with no substantive inbound links.",
  "- stale: use when classification is genuinely ambiguous or evidence is thin.",
  "",
  "SAFETY: when unsure, return stale — never guess a destructive verdict. Specifically:",
  "- Set ambiguous:true if the call is Update-vs-Replace-vs-Consolidate-vs-Delete borderline.",
  "- For Replace, set replace_evidence_sufficient:true ONLY if you can document the successor honestly.",
  "- For Delete, set implementation_gone / domain_gone / inbound_links_clear — all three must hold.",
  "- confidence is your certainty anchor (0/25/50/75/100); below 75 is treated as ambiguous.",
  "",
  "Read the doc's YAML frontmatter and RETURN its module, tags, and problem_type verbatim",
  "(used to cluster docs for the cross-doc contradiction pass).",
].join("\n");

function safeName(p) {
  return p.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function classifyPrompt(p) {
  return [
    "Classify ONE docs/solutions/ learning against the current codebase.",
    "Read this doc: " + p,
    SCOPE_HINT ? "Refresh scope hint: " + SCOPE_HINT : "",
    "",
    RUBRIC,
    "",
    "Inspect with native file tools (Read/Grep/Glob): do the referenced paths/classes still exist?",
    "does the recommended solution still match how the code works? are cross-referenced docs present?",
    "Treat 'file absent' as DATA (a drift/Delete signal), never an aborting error.",
    "",
    "Write your FULL analysis — the specific drift, the exact edits an Update needs, the merge plan a",
    "Consolidate needs, the successor evidence a Replace needs — to " + ARTIFACT_DIR + "/" + safeName(p) + ".json",
    "(the orchestrator reads it when applying the write). Return the COMPACT verdict object only.",
    'Set path to "' + p + '".',
  ]
    .filter(Boolean)
    .join("\n");
}

function contradictionPrompt(clusterPaths, round, known) {
  return [
    "Compare these related docs/solutions/ docs for OUTRIGHT CONTRADICTIONS between them",
    "(not individual staleness): opposing recommendations, a path one says is deprecated that",
    "another still relies on, or different root causes for the same problem.",
    "",
    "Docs to compare (Read each):",
    clusterPaths.map((p) => "- " + p).join("\n"),
    known && known.length
      ? "\nAlready found (do NOT re-report these; look for any OTHERS):\n" + known.map((k) => "- " + k).join("\n")
      : "",
    "",
    "Return a (possibly empty) contradictions array. For each: doc_a, doc_b, the dimension",
    "(problem|solution|root_cause|files|prevention), and a one-sentence summary.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Sorted doc-pair, ignoring dimension. The PAIR is the unit of "a contradiction"
// for loop termination — two docs either contradict or they don't; the dimension
// is a facet, not a separate problem.
function contradictionPairKey(c) {
  return [String(c.doc_a || ""), String(c.doc_b || "")].sort().join("|");
}

// Pair + dimension. Used only to exact-dedup the REPORT, so the same facet
// reported twice across rounds is not double-listed.
function contradictionKey(c) {
  return contradictionPairKey(c) + "::" + String(c.dimension || "");
}

// ---- classify --------------------------------------------------------------
phase("Classify");

if (PATHS.length === 0) {
  // Not a silent empty run — log the boundary the live-boundary learning warns about.
  log("no in-scope paths supplied; returning a clean empty envelope");
}

const classifierResults = await parallel(
  PATHS.map((p) => () =>
    agent(classifyPrompt(p), {
      label: "classify:" + safeName(p),
      phase: "Classify",
      model: "sonnet",
      schema: CLASSIFY_SCHEMA,
    })
      .then((r) => (r && typeof r === "object" ? { ...r, path: typeof r.path === "string" && r.path ? r.path : p } : { path: p, failed: true }))
      .catch((e) => {
        // Surface dispatch/runtime failures — a swallowed error reads as a doc
        // that "classified Keep," the exact fail-open the safety invariant forbids.
        log("classify " + p + " failed: " + (e && e.message ? e.message : String(e)));
        return { path: p, failed: true };
      }),
  ),
);

const rolled = rollupClassifications(classifierResults, { solutionsFileCount: SOLUTIONS_FILE_COUNT });
const failedClassifiers = classifierResults.filter((r) => r && r.failed === true).length;

// ---- contradictions (cluster-bounded loop-until-dry) -----------------------
phase("Contradictions");

const { clusters, singletons } = buildClusters(rolled.verdicts);
const contradictions = [];
const seen = new Set(); // (pair + dimension) — exact-dedups the report
const seenPairs = new Set(); // (pair only) — drives loop termination
let dry_count = 0;
let rounds = 0;
let contradictionDegraded = false;

while (clusters.length > 0) {
  rounds += 1;
  const roundResults = await parallel(
    clusters.map((clusterPaths, i) => () => {
      const known = contradictions
        .filter((c) => clusterPaths.includes(c.doc_a) || clusterPaths.includes(c.doc_b))
        .map((c) => c.summary);
      return agent(contradictionPrompt(clusterPaths, rounds, known), {
        label: "contradict:r" + rounds + "-c" + (i + 1),
        phase: "Contradictions",
        model: "sonnet",
        schema: CONTRADICTION_SCHEMA,
      })
        .then((r) => ({ ok: true, contradictions: r && Array.isArray(r.contradictions) ? r.contradictions : [] }))
        .catch((e) => {
          log("contradiction round " + rounds + " cluster " + (i + 1) + " failed: " + (e && e.message ? e.message : String(e)));
          return { ok: false, contradictions: [] };
        });
    }),
  );

  const round_failed = roundResults.some((r) => !r.ok);
  // found_new drives termination off newly-discovered PAIRS, not new facets of a
  // known pair: a round that only enumerates more dimensions of an already-seen
  // contradiction is "dry" (discovery has converged), so a thorough classifier is
  // not penalized into a never-quiescent (degraded) loop. All facets are still
  // collected for the report.
  let found_new = false;
  for (const r of roundResults) {
    for (const c of r.contradictions) {
      if (!c || typeof c.doc_a !== "string" || typeof c.doc_b !== "string") continue;
      const key = contradictionKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      contradictions.push({ doc_a: c.doc_a, doc_b: c.doc_b, dimension: typeof c.dimension === "string" ? c.dimension : "", summary: typeof c.summary === "string" ? c.summary : "" });
      const pairKey = contradictionPairKey(c);
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        found_new = true;
      }
    }
  }

  const term = contradictionTermination({ rounds, dry_count, found_new, round_failed });
  dry_count = term.dry_count;
  if (term.action === "done") {
    if (term.status === "degraded") contradictionDegraded = true;
    break;
  }
}

// ---- envelope --------------------------------------------------------------
const status = rolled.status === "degraded" || contradictionDegraded ? "degraded" : "complete";

log(
  "Corpus audit complete: " +
    rolled.verdicts.length +
    "/" +
    PATHS.length +
    " classified" +
    (failedClassifiers ? " (" + failedClassifiers + " classifier failures)" : "") +
    (rolled.counts.dropped ? " (" + rolled.counts.dropped + " malformed dropped)" : "") +
    "; " +
    contradictions.length +
    " contradictions over " +
    rounds +
    " rounds across " +
    clusters.length +
    " clusters",
);

return {
  status,
  solutions_file_count: rolled.solutions_file_count,
  verdicts: rolled.verdicts,
  // Verdict-grouped path lists the orchestrator copies VERBATIM and applies per
  // group (R7) — the determinism lives in rollupClassifications, not an LLM re-group.
  grouped: rolled.grouped,
  contradictions,
  counts: {
    ...rolled.counts,
    failed_classifiers: failedClassifiers,
    clusters: clusters.length,
    singletons: singletons.length,
    contradiction_rounds: rounds,
  },
  today: TODAY,
  artifact_path: ARTIFACT_DIR + "/",
  run_id: RUN_ID,
};
