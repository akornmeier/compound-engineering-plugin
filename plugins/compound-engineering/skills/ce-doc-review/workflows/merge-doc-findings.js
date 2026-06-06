// Deterministic port of ce-doc-review's CLEAN-MECHANICAL synthesis brackets.
//
// Pure module: no Workflow/Agent/filesystem dependencies. It is importable by
// `bun test` AND designed to be inlined into the dynamic workflow script (the
// Workflow runtime is self-contained and cannot `import` a sibling file, so
// doc-review-fanout.js prepends this module's function bodies; the single
// trailing `export` line is the only thing stripped on inline).
//
// Faithful to:
//   plugins/compound-engineering/skills/ce-doc-review/references/synthesis-and-presentation.md
//   plugins/compound-engineering/skills/ce-doc-review/references/findings-schema.json
//
// SCOPE — only the two CONTIGUOUS clean-mechanical brackets of the pipeline:
//   mergeFront: 3.1 validate -> 3.2 anchor gate -> 3.3 cross-persona dedup
//   mergeBack:  3.7 route    -> 3.8 sort        -> 3.9 suppress restatements
//               -> protected-artifact drop
// The interleaved middle (3.3b collapse, 3.4 cross-persona promotion, 3.5
// contradictions, 3.5b recommended-action tie-break, 3.5c chains, 3.6
// auto-promotion) is owned by the in-workflow synthesis agent (U2) because its
// steps carry bidirectional data dependencies with deterministic steps and
// cannot be split without inverting pipeline order. This module deliberately
// does NOT implement them.
//
// Where the prose delegates a decision to model judgment, this module makes an
// explicit, test-pinned choice marked [INTERP].

const SEVERITY_RANK = { P0: 3, P1: 2, P2: 1, P3: 0 };
// [INTERP] merge conservatism — the more judgment / less silent apply, the higher.
const AUTOFIX_CONSERVATISM = { manual: 2, gated_auto: 1, safe_auto: 0 };
const VALID_SEVERITY = new Set(["P0", "P1", "P2", "P3"]);
const VALID_FINDING_TYPE = new Set(["error", "omission"]);
const VALID_AUTOFIX = new Set(["safe_auto", "gated_auto", "manual"]);
const VALID_ANCHORS = new Set([0, 25, 50, 75, 100]);
// Anchors dropped silently by 3.2 (false positive / unverifiable).
const DROPPED_ANCHORS = new Set([0, 25]);
// 3.5c Step 4: cap dependents rendered per root.
const MAX_DEPENDENTS = 6;
// Protected-artifact directories (synthesis "Protected Artifacts").
const PROTECTED_DIRS = ["docs/brainstorms/", "docs/plans/", "docs/solutions/"];

// 3.3 normalization: lowercase, strip punctuation, collapse whitespace. Replace
// punctuation with a space (not nothing) so "Unit-4" and "Unit 4" fingerprint
// the same; otherwise punctuation-only differences would fail to dedup and would
// produce divergent stable ids.
function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasFix(finding) {
  return typeof finding.suggested_fix === "string" && finding.suggested_fix.trim().length > 0;
}

// ---------------------------------------------------------------------------
// mergeFront — 3.1 validate, 3.2 anchor gate, 3.3 cross-persona dedup.
// ---------------------------------------------------------------------------

// 3.1: validate one return's findings against the schema vocabulary. Unlike the
// code-review module, doc-review does NOT remap legacy values — the synthesis
// prose treats the pre-rename `auto` / `present` values as malformed and drops
// them until persona output is regenerated.
function validate(returns) {
  const findings = [];
  const softBuckets = { residual_risks: [], deferred_questions: [] };
  const malformedAgents = new Set();
  let droppedReturns = 0;
  let droppedFindings = 0;
  let order = 0;

  for (const ret of Array.isArray(returns) ? returns : []) {
    if (
      !ret ||
      typeof ret.reviewer !== "string" ||
      !Array.isArray(ret.findings) ||
      !Array.isArray(ret.residual_risks) ||
      !Array.isArray(ret.deferred_questions)
    ) {
      droppedReturns++;
      continue;
    }
    softBuckets.residual_risks.push(...ret.residual_risks);
    softBuckets.deferred_questions.push(...ret.deferred_questions);

    for (const raw of ret.findings) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.title !== "string" ||
        !VALID_SEVERITY.has(raw.severity) ||
        typeof raw.section !== "string" ||
        typeof raw.why_it_matters !== "string" ||
        !VALID_FINDING_TYPE.has(raw.finding_type) ||
        !VALID_AUTOFIX.has(raw.autofix_class) ||
        !VALID_ANCHORS.has(raw.confidence) ||
        !Array.isArray(raw.evidence) ||
        raw.evidence.length < 1
      ) {
        droppedFindings++;
        malformedAgents.add(ret.reviewer);
        continue;
      }
      findings.push({
        section: raw.section,
        title: raw.title,
        severity: raw.severity,
        finding_type: raw.finding_type,
        autofix_class: raw.autofix_class,
        confidence: raw.confidence,
        why_it_matters: raw.why_it_matters,
        evidence: [...raw.evidence],
        suggested_fix: typeof raw.suggested_fix === "string" ? raw.suggested_fix : null,
        _reviewer: ret.reviewer,
        _order: order++,
      });
    }
  }
  return {
    findings,
    softBuckets,
    droppedReturns,
    droppedFindings,
    malformedAgents: [...malformedAgents].sort(),
  };
}

// 3.3: merge a fingerprint cluster (same normalize(section)+normalize(title))
// into one finding. [INTERP] The prose says preserve opposing-action pairs for
// 3.5; opposing findings in practice carry DIFFERENT titles (-> different
// fingerprints -> never clustered here -> they reach the synthesis agent as
// distinct same-section findings, where 3.5 resolves the contradiction). So an
// identical-fingerprint cluster is treated as the same concern and merged.
function mergeCluster(members) {
  const reviewers = [...new Set(members.map((m) => m._reviewer))].sort();
  // Representative = highest severity, then highest anchor, then first by order.
  const rep = [...members].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.confidence - a.confidence ||
      a._order - b._order,
  )[0];

  const severity = members.reduce(
    (acc, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc] ? m.severity : acc),
    "P3",
  );
  // 3.3 keeps the highest confidence anchor. NO cross-persona promotion here —
  // that is 3.4, owned by the synthesis agent.
  const confidence = Math.max(...members.map((m) => m.confidence));

  // [INTERP] autofix_class on merge: the prose does not define a merge rule, so
  // keep the most conservative (more judgment / less silent apply):
  // manual > gated_auto > safe_auto. The agent's 3.6 may still promote it.
  const autofix_class = members
    .map((m) => m.autofix_class)
    .reduce((a, b) => (AUTOFIX_CONSERVATISM[b] > AUTOFIX_CONSERVATISM[a] ? b : a));

  const evidence = [...new Set(members.flatMap((m) => m.evidence))];
  const suggested_fix =
    (members.find((m) => m._reviewer === rep._reviewer && hasFix(m)) ||
      members.find((m) => hasFix(m)) ||
      {}).suggested_fix ?? null;

  return {
    id: normalize(rep.section) + "|" + normalize(rep.title),
    section: rep.section,
    title: rep.title,
    severity,
    finding_type: rep.finding_type,
    autofix_class,
    confidence,
    why_it_matters: rep.why_it_matters,
    evidence,
    suggested_fix,
    reviewers,
    _order: rep._order,
  };
}

/**
 * Front bracket: validate -> anchor gate -> cross-persona dedup.
 * Returns the deduped finding set the synthesis agent consumes, the soft
 * buckets it must carry through to mergeBack, and the front's coverage counts.
 *
 * @param {Array<{reviewer:string, findings:Array, residual_risks:Array, deferred_questions:Array}>} returns
 */
function mergeFront(returns) {
  const { findings, softBuckets, droppedReturns, droppedFindings, malformedAgents } =
    validate(returns);

  // 3.2: drop anchors 0/25 (counted); keep 50/75/100. The FYI-vs-actionable
  // split is finalized by anchor in mergeBack 3.7 — anchors mutate in the agent
  // (3.3b demote -> 50, 3.4 promote 50 -> 75), so the front must not separate.
  let dropped = 0;
  const gated = findings.filter((f) => {
    if (DROPPED_ANCHORS.has(f.confidence)) {
      dropped++;
      return false;
    }
    return true;
  });

  // 3.3: cluster by normalize(section)+normalize(title), merge each cluster.
  const groups = new Map();
  for (const f of gated) {
    const key = normalize(f.section) + "|" + normalize(f.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  let dedupMerged = 0;
  const merged = [...groups.keys()].sort().map((key) => {
    const cluster = groups.get(key);
    if (cluster.length > 1) dedupMerged += cluster.length - 1;
    return mergeCluster(cluster);
  });

  return {
    findings: merged,
    residual_risks: softBuckets.residual_risks,
    deferred_questions: softBuckets.deferred_questions,
    coverage: {
      dropped, // 3.2 anchors 0/25
      dropped_returns: droppedReturns,
      dropped_findings: droppedFindings,
      malformed_agents: malformedAgents,
      dedup_merged: dedupMerged,
    },
  };
}

// ---------------------------------------------------------------------------
// mergeBack — 3.7 route, 3.8 sort, 3.9 suppress restatements, protected drop.
// ---------------------------------------------------------------------------

// 3.7: apply the anchor x autofix_class route table. Each (anchor, original
// class) cell is a TERMINAL single-step lookup — demotion is not cascaded.
// safe_auto demotes exactly one step to gated_auto (silent apply is reserved
// for 100 + safe_auto + fix); only a finding whose ORIGINAL class is gated_auto
// and which lacks a fix demotes to manual. Returns the destination bucket name.
function routeBucket(f) {
  if (f.confidence === 50) return "fyi"; // anchor 50 -> FYI regardless of class
  if (f.autofix_class === "safe_auto") {
    if (f.confidence === 100 && hasFix(f)) return "applied"; // silent apply
    return "proposed_fixes"; // 75 + safe_auto, or 100 + safe_auto missing a fix
  }
  if (f.autofix_class === "gated_auto") {
    return hasFix(f) ? "proposed_fixes" : "decisions"; // no fix -> manual
  }
  return "decisions"; // manual (suggested_fix optional)
}

// 3.8: P0->P3, errors before omissions, anchor desc, document order final.
// [INTERP] "document order" uses the stable _order index assigned at first
// appearance in mergeFront (the document is not available to a pure module);
// agent-emitted findings without _order sort last within their tie group. This
// preserves determinism — the parity requirement — even if it is not literal
// section position.
function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      typeRank(a) - typeRank(b) ||
      b.confidence - a.confidence ||
      orderOf(a) - orderOf(b),
  );
}
function typeRank(f) {
  return f.finding_type === "error" ? 0 : 1; // errors before omissions
}
function orderOf(f) {
  return Number.isFinite(f._order) ? f._order : Number.MAX_SAFE_INTEGER;
}

// Protected-artifact predicate: the fix proposes deleting a file under a
// protected docs dir. [INTERP] clear-cut = a protected path token AND a
// deletion verb in the same suggested_fix; borderline mentions are kept.
const DELETE_VERB = /\b(delete|remove|drop|rm)\b/i;
function recommendsProtectedDeletion(f) {
  if (!hasFix(f)) return false;
  const fix = f.suggested_fix;
  const mentionsProtected = PROTECTED_DIRS.some((d) => fix.includes(d));
  return mentionsProtected && DELETE_VERB.test(fix);
}

// 3.9: a residual/deferred item restates an actionable finding when it shares a
// section with one AND its substance overlaps the finding's title/why_it_matters.
// [INTERP] mechanical substance overlap = >=2 shared significant words (>=4
// chars). "When in doubt, keep" — only obvious restatements drop.
const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "will",
  "would",
  "could",
  "should",
  "there",
  "their",
  "which",
  "where",
  "when",
  "what",
  "than",
  "then",
  "into",
  "over",
  "under",
  "about",
  "section",
  "document",
  "finding",
]);
function significantWords(text) {
  return new Set(
    normalize(text)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}
function sharesTwoWords(itemWords, findingWords) {
  let shared = 0;
  for (const w of itemWords) if (findingWords.has(w)) shared++;
  return shared >= 2;
}
function sharesAnyWord(itemWords, words) {
  for (const w of words) if (itemWords.has(w)) return true;
  return false;
}
// 3.9 restatement suppression. `actionable` entries are precomputed once by the
// caller (`{ words, sectionWords }`) — the finding word-sets are reused across
// every residual/deferred item, so recomputing them per item would be
// O(A*(R+D)) tokenization. `questionForm` selects the spec branch:
//   - residual statements (questionForm=false): spec case (a) — require BOTH a
//     section-name overlap AND substance overlap, so an item that merely shares
//     generic terms with an UNRELATED section is not dropped.
//   - deferred questions (questionForm=true): spec case (b) — a question whose
//     substance matches an actionable finding is a restatement regardless of
//     section.
function suppressRestatements(items, actionable, questionForm) {
  let restated = 0;
  const kept = items.filter((item) => {
    const itemWords = significantWords(item);
    const isRestatement = actionable.some((f) => {
      if (!sharesTwoWords(itemWords, f.words)) return false;
      if (questionForm) return true;
      return sharesAnyWord(itemWords, f.sectionWords);
    });
    if (isRestatement) {
      restated++;
      return false;
    }
    return true;
  });
  return { kept, restated };
}

// 3.5c count invariant: coverage and rendering must derive from ONE source of
// truth. The synthesis agent can emit inconsistent annotations (a finding listed
// in a root's `dependents` array but with `depends_on: null`, or a depends_on
// pointing at a finding the protected-artifact drop removed). Reconcile both
// sides from the `depends_on` back-pointers (the dependent's own declaration):
// rebuild each root's `dependents` from who actually points at it, clear dangling
// /self depends_on, and apply the cap so the array and back-pointers agree by
// construction. Mutates the findings in place; returns the coverage counts.
function reconcileChains(findings) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  // Clear depends_on that does not point at another surviving finding.
  for (const f of findings) {
    if (f.depends_on && (f.depends_on === f.id || !byId.has(f.depends_on))) f.depends_on = null;
  }
  // Enforce the one-level model: a dependent cannot also be a root. If a
  // finding's declared root is itself a dependent (depth-2+ chain), drop the
  // link so the finding renders independently — the walk-through cascades a
  // single root decision over one level, not a tree. Snapshot first so the
  // decision is order-independent.
  const isDependent = new Set(findings.filter((f) => f.depends_on).map((f) => f.id));
  for (const f of findings) {
    if (f.depends_on && isDependent.has(f.depends_on)) f.depends_on = null;
  }
  // Group dependents by their declared root.
  const back = new Map();
  for (const f of findings) {
    if (!f.depends_on) continue;
    if (!back.has(f.depends_on)) back.set(f.depends_on, []);
    back.get(f.depends_on).push(f);
  }
  // Cap per root (keep top 6 by severity, anchor desc, document order); the
  // overflow lose their link and render independently.
  for (const deps of back.values()) {
    deps.sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.confidence - a.confidence ||
        orderOf(a) - orderOf(b),
    );
    for (const extra of deps.slice(MAX_DEPENDENTS)) extra.depends_on = null;
  }
  // Rebuild every finding's dependents array from the (post-cap) back-pointers —
  // the agent's original array is discarded so the two sides cannot drift.
  let roots = 0;
  let dependents = 0;
  for (const f of findings) {
    const live = (back.get(f.id) || []).filter((d) => d.depends_on === f.id);
    f.dependents = live.map((d) => d.id);
    if (f.dependents.length > 0) roots++;
    if (f.depends_on) dependents++;
  }
  return { roots, dependents };
}

/**
 * Back bracket: consumes the synthesis agent's annotated finding set (final
 * anchors, recommended_action, autofix_class, depends_on/dependents already
 * set) plus the soft buckets from mergeFront. Routes, sorts, suppresses
 * restatements, drops protected-artifact deletions, and returns the envelope
 * buckets the headless text output is rendered from.
 *
 * @param {Array<object>} annotated  findings keyed by stable id, post-synthesis
 * @param {{residual_risks:Array<string>, deferred_questions:Array<string>}} softBuckets
 */
function mergeBack(annotated, softBuckets) {
  // Defensive 3.2 re-gate: SYNTHESIS_SCHEMA permits confidence 0/25, so an agent
  // that wrongly demotes/keeps a finding below 50 must not slip past — the
  // "anchors 0/25 never surface" invariant is enforced on both sides of the agent.
  const surviving = (Array.isArray(annotated) ? annotated : []).filter(
    (f) =>
      f &&
      typeof f === "object" &&
      !DROPPED_ANCHORS.has(f.confidence) &&
      !recommendsProtectedDeletion(f),
  );

  // Reconcile depends_on/dependents into one consistent structure BEFORE routing
  // so coverage counts and the rendered nesting cannot drift (3.5c invariant).
  const chains = reconcileChains(surviving);

  const buckets = { applied: [], proposed_fixes: [], decisions: [], fyi: [] };
  for (const f of surviving) buckets[routeBucket(f)].push(f);

  buckets.applied = sortFindings(buckets.applied);
  buckets.proposed_fixes = sortFindings(buckets.proposed_fixes);
  buckets.decisions = sortFindings(buckets.decisions);
  buckets.fyi = sortFindings(buckets.fyi);

  // 3.9 runs against the finalized actionable + FYI set. Tokenize each finding
  // once and reuse the word-sets across every residual/deferred item.
  const actionable = [
    ...buckets.applied,
    ...buckets.proposed_fixes,
    ...buckets.decisions,
    ...buckets.fyi,
  ];
  const actionableEntries = actionable.map((f) => ({
    words: significantWords(f.title + " " + f.why_it_matters),
    sectionWords: significantWords(f.section),
  }));
  const soft = softBuckets || { residual_risks: [], deferred_questions: [] };
  const residual = suppressRestatements(soft.residual_risks || [], actionableEntries, false);
  const deferred = suppressRestatements(soft.deferred_questions || [], actionableEntries, true);

  return {
    applied: buckets.applied,
    proposed_fixes: buckets.proposed_fixes,
    decisions: buckets.decisions,
    fyi: buckets.fyi,
    residual_risks: residual.kept,
    deferred_questions: deferred.kept,
    coverage: {
      restated: residual.restated + deferred.restated,
      chains, // { roots, dependents } reconciled from a single source of truth
    },
  };
}

export { mergeFront, mergeBack, normalize };
