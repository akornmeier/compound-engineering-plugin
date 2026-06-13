// Deterministic core of ce-compound-refresh's broad-scope corpus audit: verdict
// normalization, the stale-on-ambiguity safety coercion, the loop-until-dry
// contradiction-termination predicate, deterministic sort, grouped projection,
// and contradiction clustering.
//
// Pure module: no Workflow/Agent/filesystem dependencies. It is importable by
// `bun test` AND designed to be inlined into the dynamic workflow script (the
// Workflow runtime is self-contained and cannot `import` a sibling file, so
// corpus-audit-fanout.js prepends this module's function bodies; the single
// trailing `export` line is the only thing that must be stripped on inline).
// The prose fallback (SKILL.md "Workflow acceleration" subsection) cites the
// named constants and the termination decision table below VERBATIM, so the
// workflow path and the fallback cannot diverge.
//
// Faithful to:
//   plugins/compound-engineering/skills/ce-compound-refresh/SKILL.md
//     (the five-action taxonomy, the headless safety invariant at line ~25:
//      "mark ambiguous stale, never destructively act on ambiguity")
//
// THE SAFETY INVARIANT, stated once (R5): the workflow never emits a destructive
// verdict (Delete / Replace / Consolidate) when the classification is ambiguous
// or its evidence is insufficient. Anything not provably safe collapses to
// `stale`. A failed classifier collapses to `unverifiable`, never `Keep` (R6).

// The five maintenance actions a classifier may emit, plus `stale` (the
// fail-safe verdict). Capitalized exactly as the SKILL.md taxonomy names them.
const CLASSIFIER_VERDICTS = new Set(["Keep", "Update", "Consolidate", "Replace", "Delete", "stale"]);
// Confidence anchors the classifier may report (the inline agent() schema pins
// this enum — KTD8). A continuous 0-100 free integer is intentionally NOT used:
// anchors are the proven structured-output shape and make the threshold total.
const VALID_CONFIDENCE = new Set([0, 25, 50, 75, 100]);

// Named tuning constants — the prose fallback cites these by value (R9 parity),
// and the U4 prose-parity guard asserts the same numbers appear in SKILL.md.

// At or above this confidence anchor a verdict keeps its class; below it the
// classification is treated as ambiguous and coerces to `stale`.
const AMBIGUITY_CONFIDENCE_THRESHOLD = 75;
// Loop-until-dry: K consecutive contradiction-free, non-failed rounds declare
// the corpus quiescent.
const CONTRADICTION_K = 2;
// Hard iteration cap: stop after this many rounds regardless, degraded if the
// pass never reached quiescence.
const CONTRADICTION_CAP = 5;

// Verdict groups, in the order the report walks them. `unverifiable` is NOT a
// classifier-emittable verdict — the module assigns it to failed entries (R6).
const VERDICT_GROUPS = ["Keep", "Update", "Consolidate", "Replace", "Delete", "stale", "unverifiable"];

function strcmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pathOf(raw) {
  return raw && typeof raw.path === "string" ? raw.path.trim() : "";
}

/**
 * Normalize one raw classifier entry into a record the roll-up can bucket,
 * applying the stale-on-ambiguity coercion (R5) and the fail-closed
 * failed-classifier rule (R6). Returns one of:
 *   { record: "valid", path, verdict, confidence, coerced_from, evidence,
 *     module, tags, problem_type }   — verdict is the EFFECTIVE post-coercion verdict
 *   { record: "failed", path, verdict: "unverifiable" }  — null/failed classifier
 *   { record: "dropped" }            — malformed (bad/missing path, verdict, confidence)
 */
function normalizeVerdict(raw) {
  // A failed/null classifier is unverifiable — NEVER silently read as Keep (R6).
  if (raw == null || raw.failed === true || raw.verdict == null) {
    return { record: "failed", path: pathOf(raw), verdict: "unverifiable" };
  }

  const path = pathOf(raw);
  if (!path || !CLASSIFIER_VERDICTS.has(raw.verdict) || !VALID_CONFIDENCE.has(raw.confidence)) {
    return { record: "dropped" };
  }

  let verdict = raw.verdict;
  let coerced_from = null;

  // (1) Ambiguity gate — applies to EVERY class, Keep included. An unsure Keep
  // is exactly the "I cannot confirm this is still accurate" case the
  // conservative-stale posture targets, so it is flagged, not silently trusted.
  const ambiguous = raw.ambiguous === true || raw.confidence < AMBIGUITY_CONFIDENCE_THRESHOLD;
  if (ambiguous && verdict !== "stale") {
    coerced_from = verdict;
    verdict = "stale";
  }

  // (2) Per-destructive evidence gate — even a confident destructive verdict
  // needs its evidence, enforced deterministically here (not in the schema —
  // KTD8): Replace needs sufficient evidence; Delete needs all three auto-delete
  // signals (implementation gone + domain gone + inbound links clear).
  if (verdict === "Replace" && raw.replace_evidence_sufficient !== true) {
    coerced_from = "Replace";
    verdict = "stale";
  }
  if (
    verdict === "Delete" &&
    !(raw.implementation_gone === true && raw.domain_gone === true && raw.inbound_links_clear === true)
  ) {
    coerced_from = "Delete";
    verdict = "stale";
  }

  return {
    record: "valid",
    path,
    verdict,
    confidence: raw.confidence,
    coerced_from,
    evidence: typeof raw.evidence === "string" ? raw.evidence : "",
    module: typeof raw.module === "string" ? raw.module : "",
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
    problem_type: typeof raw.problem_type === "string" ? raw.problem_type : "",
  };
}

/**
 * Roll an array of raw classifier entries up into the normalized, deterministi-
 * cally-sorted verdict list, the grouped projection the orchestrator applies
 * verbatim (R7), per-class counts, and the classification status (R6). Failed
 * entries make the status `degraded`. Deterministic: same input -> byte-identical
 * output, and output order does not depend on input order.
 *
 * @param {Array} rawVerdicts
 * @param {{ solutionsFileCount?: number }} options  R4 file-count passthrough
 */
function rollupClassifications(rawVerdicts, options = {}) {
  const solutions_file_count = Number.isInteger(options.solutionsFileCount) ? options.solutionsFileCount : 0;
  const counts = {
    Keep: 0,
    Update: 0,
    Consolidate: 0,
    Replace: 0,
    Delete: 0,
    stale: 0,
    unverifiable: 0,
    dropped: 0,
    coerced: 0,
  };
  const verdicts = [];

  for (const raw of Array.isArray(rawVerdicts) ? rawVerdicts : []) {
    const n = normalizeVerdict(raw);
    if (n.record === "dropped") {
      counts.dropped++;
      continue;
    }
    if (n.record === "failed") {
      counts.unverifiable++;
      verdicts.push({ path: n.path, verdict: "unverifiable", confidence: 0, coerced_from: null, evidence: "classifier failed", module: "", tags: [], problem_type: "" });
      continue;
    }
    counts[n.verdict]++;
    if (n.coerced_from) counts.coerced++;
    verdicts.push(n);
  }

  // Order on the path total key so output does NOT depend on the model's verdict-
  // emission order (a parallel fan-out returns in arbitrary order). Tie-break on
  // verdict for full determinism if a duplicate path ever slips through.
  verdicts.sort((a, b) => strcmp(a.path, b.path) || strcmp(a.verdict, b.verdict));

  // Verdict-grouped path lists derived from the SORTED list. The orchestrator
  // copies these verbatim and applies writes per group (R7) — no LLM re-buckets.
  const grouped = {};
  for (const g of VERDICT_GROUPS) {
    grouped[g] = verdicts.filter((v) => v.verdict === g).map((v) => v.path);
  }

  // Fail-closed (R6): a failed classifier (unverifiable) OR a malformed/dropped
  // return makes the run degraded — either way a doc was NOT cleanly classified,
  // so it is unprocessed. A dropped entry has no usable path and cannot enter a
  // group, so forcing degraded is the only signal that the envelope covers fewer
  // docs than were in scope. A degraded run is never read as "everything Keep."
  const status = counts.unverifiable > 0 || counts.dropped > 0 ? "degraded" : "complete";

  return { status, solutions_file_count, verdicts, grouped, counts };
}

/**
 * Cluster normalized verdicts for the cluster-bounded contradiction pass (KTD6):
 * docs that might contradict each other are those covering related territory.
 * To stay deterministic AND avoid an N^2 all-pairs blow-up, derive ONE selective
 * cluster key per doc, preferring the most specific attribute available:
 *   module  >  problem_type  >  first (sorted) tag  >  no key (singleton)
 * `module` is preferred because a coarse shared tag (e.g. "skill-design" on every
 * doc) would merge the whole corpus into one cluster and defeat the bounding.
 * Returns { clusters, singletons }: clusters are size>=2 (a contradiction needs a
 * partner); singletons have no partner and are skipped by the contradiction pass.
 * Failed (`unverifiable`) entries are excluded — there is nothing to compare.
 */
function buildClusters(verdicts) {
  const byKey = new Map();
  const singletons = [];

  for (const e of Array.isArray(verdicts) ? verdicts : []) {
    if (!e || typeof e.path !== "string" || !e.path) continue;
    if (e.verdict === "unverifiable") continue;
    const key = clusterKey(e);
    if (key == null) {
      singletons.push(e.path);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e.path);
  }

  const clusters = [];
  for (const paths of byKey.values()) {
    const sorted = [...new Set(paths)].sort(strcmp);
    if (sorted.length >= 2) clusters.push(sorted);
    else singletons.push(...sorted);
  }

  clusters.sort((a, b) => strcmp(a[0], b[0]));
  singletons.sort(strcmp);
  return { clusters, singletons };
}

function clusterKey(e) {
  if (e.module && e.module.trim()) return "module:" + e.module.trim().toLowerCase();
  if (e.problem_type && e.problem_type.trim()) return "ptype:" + e.problem_type.trim().toLowerCase();
  if (Array.isArray(e.tags) && e.tags.length) {
    const tags = e.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).sort(strcmp);
    if (tags.length) return "tag:" + tags[0];
  }
  return null;
}

/**
 * Loop-until-dry termination predicate (R3, KTD5). Given the round just
 * completed, return the next action, the updated dry counter, and the terminal
 * status. Pure — the caller owns the loop and the round dispatch.
 *
 *   Termination decision table (input -> dry_count update -> action -> status):
 *   ---------------------------------------------------------------------------
 *   round_failed = true        -> dry_count := 0    -> continue / done* -> degraded
 *   found_new    = true        -> dry_count := 0    -> continue / done* -> degraded
 *   clean round (neither)      -> dry_count += 1
 *       dry_count >= K         ->                       done           -> complete
 *       rounds    >= cap       ->                       done           -> degraded
 *       otherwise              ->                       continue       -> continue
 *   ---------------------------------------------------------------------------
 *   * a failed or contradiction-finding round still returns `done` once rounds
 *     reaches the cap, but never with `complete` status — a capped-out pass is
 *     never read as "no contradictions." A failed round NEVER counts as dry, so
 *     a flaky round restarts the quiescence count (fail-closed, R6).
 *
 * @param {{ rounds:number, dry_count:number, found_new:boolean, round_failed:boolean }} state
 *   rounds = count INCLUDING the round just completed.
 */
function contradictionTermination(state, k = CONTRADICTION_K, cap = CONTRADICTION_CAP) {
  const rounds = Number.isInteger(state && state.rounds) ? state.rounds : 0;
  const failed = state && state.round_failed === true;
  const foundNew = state && state.found_new === true;
  let dry_count = Number.isInteger(state && state.dry_count) ? state.dry_count : 0;

  if (failed || foundNew) dry_count = 0;
  else dry_count += 1;

  // Quiescence: K consecutive contradiction-free, non-failed rounds.
  if (!failed && !foundNew && dry_count >= k) {
    return { action: "done", dry_count, status: "complete" };
  }
  // Hard cap reached without quiescence -> stop, flagged degraded so a caller
  // never reads a capped-out pass as "no contradictions."
  if (rounds >= cap) {
    return { action: "done", dry_count, status: "degraded" };
  }
  return { action: "continue", dry_count, status: "continue" };
}

export {
  normalizeVerdict,
  rollupClassifications,
  buildClusters,
  contradictionTermination,
  AMBIGUITY_CONFIDENCE_THRESHOLD,
  CONTRADICTION_K,
  CONTRADICTION_CAP,
};
