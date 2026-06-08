// Deterministic core of ce-verify-work: a plan-unit parser and a verdict roll-up.
//
// Pure module: no Workflow/Agent/filesystem dependencies. It is importable by
// `bun test` AND designed to be inlined into the dynamic workflow script (the
// Workflow runtime is self-contained and cannot `import` a sibling file, so
// work-vs-plan-fanout.js prepends this module's function bodies; the single
// trailing `export` line is the only thing that must be stripped on inline).
// The orchestrator's pre-dispatch validation and the prose fallback both reuse
// parsePlanUnits / rollupVerdicts, so the rate cannot diverge across paths.
//
// Faithful to:
//   plugins/compound-engineering/skills/ce-plan/SKILL.md  (### U<n>. unit spec)
//   plugins/compound-engineering/skills/ce-verify-work/references/verdict-schema.json
//
// Key Decision 4: drift_rate = drifted / (done + drifted). `remaining` (never
// attempted) and `unverifiable` (not statically settleable) are counted but
// EXCLUDED from the denominator, so the rate measures the redo-shaped subset,
// not how far along the plan is.

const VALID_VERDICTS = new Set(["done", "remaining", "drifted", "unverifiable"]);
// Verdicts whose claim must be provable — an uncited done/drifted is dropped,
// so the rate is recomputed from cited verdicts only (Key Decision 5).
const EVIDENCE_REQUIRED = new Set(["done", "drifted"]);
// Below this many attempted (done + drifted) units the denominator is too small
// to trust — a 1-done/1-drifted plan reads 0.5 from a meaningless sample.
const ATTEMPTED_FLOOR = 3;
// A run dominated by unverifiable units is low-confidence even if a few units
// were attempted — the rate covers too little of the plan.
const UNVERIFIABLE_FRACTION = 0.5;

const FIELD_NAMES = {
  goal: "goal",
  requirements: "requirements",
  dependencies: "dependencies",
  files: "files",
  approach: "approach",
  "execution note": "execution_note",
  "patterns to follow": "patterns",
  "test scenarios": "test_scenarios",
  verification: "verification",
};

// ---- plan parsing ----------------------------------------------------------

// ce-work reads both markdown and HTML plans. HTML plans carry the same section
// and field names, just wrapped in semantic elements (<h3>U1. ...</h3>,
// <dt>Goal</dt><dd>...</dd>, <details><summary>Verification</summary>...). Fold
// the structural tags back to their markdown equivalents so one parser handles
// both; the U-ID is found as the literal "U1." text in either form.
function htmlToText(s) {
  return s
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<\/h2>/gi, "\n")
    .replace(/<h[34][^>]*>/gi, "\n### ")
    .replace(/<\/h[34]>/gi, "\n")
    .replace(/<dt[^>]*>/gi, "\n**")
    .replace(/<\/dt>/gi, ":**")
    .replace(/<summary[^>]*>/gi, "\n**")
    .replace(/<\/summary>/gi, ":**")
    .replace(/<(strong|b)[^>]*>/gi, "**")
    .replace(/<\/(strong|b)>/gi, "**")
    .replace(/<code[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(p|dd|dl|ul|ol|article|section|details|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function looksLikeHtml(s) {
  return /<(h[1-6]|article|section|dl|dt|details)\b/i.test(s);
}

// Drop legacy `- [ ]` / `- [x]` checkbox marks from a heading. ce-plan forbids
// them, but legacy plans carry them; they are never read as done/remaining state.
function stripCheckbox(s) {
  return s.replace(/\[[ xX]\]/g, "").replace(/\s+/g, " ").trim();
}

function isTestPath(p) {
  return /(^|\/)tests?\//.test(p) || /[._-](test|spec)\.[A-Za-z0-9]+$/i.test(p);
}

// Well-known extensionless repo files. A bare token (no slash, no extension)
// is a real path only when it is one of these — this readmits `Dockerfile` /
// `Makefile` / `LICENSE` without also readmitting bare identifiers like
// `import` / `fs` / `Read` that appear in Files prose. (Dotfiles such as
// `.gitignore` already pass via the extension rule — the leading dot reads as
// `.ext`.) Heuristic, not exhaustive: an obscure extensionless file not listed
// here is still dropped, which is acceptable for a Files-block scanner.
const EXTENSIONLESS_FILES = new Set([
  "dockerfile", "makefile", "license", "procfile", "gemfile", "rakefile",
  "jenkinsfile", "brewfile", "vagrantfile", "caddyfile", "justfile", "containerfile",
  "notice", "authors", "contributors", "codeowners", "readme", "changelog", "version",
]);

// A backtick span inside a Files block is a real declared path only if it has a
// path shape. Files prose mixes inline code that is NOT a path — globs (`ce-*`),
// templated placeholders (`ce-<name>.md`), shell commands (`bun run release:validate`),
// and bare identifiers (`import`, `fs`). Skip those so they never read as a
// missing/declared file. A path has no whitespace, no glob/placeholder chars,
// and either a directory separator, a trailing file extension, or a known
// extensionless filename.
function isPlausiblePath(p) {
  if (/\s/.test(p)) return false;
  if (/[*<>]/.test(p)) return false;
  if (p.includes("/") || /\.[A-Za-z0-9]+$/.test(p)) return true;
  return EXTENSIONLESS_FILES.has(p.toLowerCase());
}

// From a Files field block, pull each backtick-wrapped path and classify it by
// its trailing annotation (`(new)` -> create, `(modified)`/`(extended)` ->
// modify) and by path shape (test). `all` is every distinct declared path —
// the attempt signal the classifier checks against git is "a commit touched one
// of these".
function parseFiles(block) {
  const create = [];
  const modify = [];
  const test = [];
  const all = [];
  const seen = new Set();
  // Trailing capture stops at the next backtick (not end of line) so a Files
  // bullet with several backtick spans yields every token, not just the first.
  const re = /`([^`]+)`([^`\n]*)/g;
  let m;
  while ((m = re.exec(block))) {
    const p = m[1].trim();
    if (!p || !isPlausiblePath(p)) continue;
    const trailing = (m[2] || "").toLowerCase();
    if (!seen.has(p)) {
      seen.add(p);
      all.push(p);
      if (/\bnew\b/.test(trailing)) create.push(p);
      if (/modif|extend/.test(trailing)) modify.push(p);
      if (isTestPath(p)) test.push(p);
    }
  }
  return { create, modify, test, all };
}

/**
 * Parse a plan document (markdown or HTML) into its Implementation Units,
 * preserving each U-ID verbatim (gaps allowed; never renumbered). Returns an
 * empty array for input with no `### U<n>.` unit headings (which drives the
 * orchestrator's invalid_input). Pure: no fs, no network.
 */
function parsePlanUnits(planText) {
  if (typeof planText !== "string" || planText.length === 0) return [];
  const text = looksLikeHtml(planText) ? htmlToText(planText) : planText;
  const lines = text.split("\n");

  // Locate unit headings: a level-2..4 heading whose text (after checkbox strip)
  // is `U<n>. <name>`. Prose mentions of "U1" are not headings and are ignored.
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2,4}\s+(.*)$/.exec(lines[i]);
    if (!h) continue;
    const htext = stripCheckbox(h[1]);
    const u = /^(U\d+)\.\s*(.*)$/.exec(htext);
    if (u) heads.push({ line: i, u_id: u[1], name: u[2].trim() });
  }
  if (heads.length === 0) return [];

  // A unit body runs from its heading to the next unit heading, the next
  // level-2 section, or a horizontal rule — whichever comes first.
  function bodyEnd(start, nextHead) {
    for (let i = start; i < lines.length; i++) {
      if (i === nextHead) return i;
      if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) return i;
    }
    return lines.length;
  }

  return heads.map((head, idx) => {
    const nextHead = idx + 1 < heads.length ? heads[idx + 1].line : -1;
    const end = bodyEnd(head.line + 1, nextHead);
    const body = lines.slice(head.line + 1, end);
    const fields = parseFields(body);
    return {
      u_id: head.u_id,
      name: head.name,
      goal: fields.goal || "",
      requirements: fields.requirements || "",
      dependencies: fields.dependencies || "",
      files: parseFiles(fields.files || ""),
      approach: fields.approach || "",
      execution_note: fields.execution_note || "",
      patterns: fields.patterns || "",
      test_scenarios: fields.test_scenarios || "",
      verification: fields.verification || "",
    };
  });
}

// Split a unit body into its bold fields. A field starts at a `**Name:**` line;
// its value is the inline remainder plus every following line up to the next
// `**Name:**` start. Unknown field names are ignored.
function parseFields(bodyLines) {
  const out = {};
  let key = null;
  let buf = [];
  const flush = () => {
    if (key) out[key] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of bodyLines) {
    const f = /^\s*\*\*([A-Za-z][A-Za-z /]*?):\*\*\s?(.*)$/.exec(line);
    if (f) {
      const mapped = FIELD_NAMES[f[1].trim().toLowerCase()];
      flush();
      if (mapped) {
        key = mapped;
        buf = [f[2]];
      } else {
        key = null;
      }
    } else if (key) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// ---- verdict roll-up -------------------------------------------------------

/**
 * Roll an array of `{ u_id, verdict, evidence?, rationale? }` up into the drift
 * rate, verdict counts, ordered verdict table, and the low-confidence flag.
 * Malformed entries (bad verdict, missing u_id, or an uncited done/drifted) are
 * dropped and counted. Deterministic: same input -> byte-identical output.
 */
function rollupVerdicts(verdicts) {
  const counts = { done: 0, remaining: 0, drifted: 0, unverifiable: 0, attempted: 0, dropped: 0 };
  const units = [];
  const unverifiable = [];

  for (const raw of Array.isArray(verdicts) ? verdicts : []) {
    if (
      !raw ||
      typeof raw.u_id !== "string" ||
      raw.u_id.length === 0 ||
      !VALID_VERDICTS.has(raw.verdict)
    ) {
      counts.dropped++;
      continue;
    }
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((e) => typeof e === "string" && e.length > 0) : [];
    if (EVIDENCE_REQUIRED.has(raw.verdict) && evidence.length === 0) {
      counts.dropped++;
      continue;
    }
    const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
    counts[raw.verdict]++;
    units.push({ u_id: raw.u_id, verdict: raw.verdict, evidence, rationale });
    if (raw.verdict === "unverifiable") unverifiable.push({ u_id: raw.u_id, reason: rationale });
  }

  counts.attempted = counts.done + counts.drifted;
  const total = counts.done + counts.remaining + counts.drifted + counts.unverifiable;
  const drift_rate = counts.attempted === 0 ? null : counts.drifted / counts.attempted;
  // Low-information sample: too few attempted units — INCLUDING zero, where an
  // all-remaining plan is the least-informative sample of all — or a run
  // dominated by unverifiable units. Guarded by `total > 0` so a genuinely empty
  // result (no valid verdicts) is not flagged.
  const low_confidence =
    total > 0 &&
    (counts.attempted < ATTEMPTED_FLOOR || counts.unverifiable / total >= UNVERIFIABLE_FRACTION);

  return { drift_rate, low_confidence, counts, units, unverifiable };
}

export { parsePlanUnits, rollupVerdicts };
