/**
 * Naqsha — Mermaid export (IR → Mermaid), owner: convert.
 *
 * `toMermaid(ir)` turns Naqsha IR v1 back into the closest Mermaid dialect that
 * `convertMermaid()` reads into the same diagram: the node-label multiset, node
 * count, edge count and declaration order survive the round trip. Output is
 * deterministic, newline-terminated and has no trailing whitespace.
 *
 *   architecture / workflow  ->  front matter + `flowchart TD|LR`
 *     one `subgraph` per IR group, node shape from `kind` (see SHAPES below),
 *     edge syntax from `kind` (`-->` main/data, `-.->` async/return,
 *     `==>` security/message).
 *   sequence  ->  front matter + `sequenceDiagram`
 *     `participant`/`actor` declarations in IR order, messages in IR order
 *     (`->>` main/data, `-->>` return, `-)` async, `--x` security, `->`
 *     message), fragment groups become `loop`/`alt`/`opt` blocks around the
 *     runs of messages whose both endpoints are in the group. A group message
 *     with only one endpoint inside is left outside with a warning (Mermaid
 *     blocks cannot span it); a non-adjacent group is emitted as several
 *     blocks so message order stays intact.
 *   erd  ->  front matter + `erDiagram`
 *     one entity block per node with its attribute rows (`type name PK|FK|UK`),
 *     then one relation per edge with the IR cardinality token
 *     (`1:1` -> `||--||`, `1:n` -> `||--o{`, `n:m` -> `}o--o{`) and the edge
 *     label as a quoted role after `:` (unlabelled -> `: ""`).
 *   class  ->  front matter + `classDiagram`
 *     one class per node with its member rows verbatim, an explicit
 *     `<<interface>>`/`<<abstract>>` line when the IR says so, then one
 *     relation per edge: extends `${to} <|-- ${from}` and implements
 *     `${to} <|.. ${from}` point at the parent, association `-->`,
 *     composition `*--` and dependency `..>` keep the IR direction.
 *   tree / timeline / waterfall / dataflow / lifecycle  ->  flowchart fallback
 *     (those five have no Mermaid dialect); a `to-mermaid/type-simplified`
 *     warning says the type-specific fields were dropped.
 *
 * Escaping. Mermaid-safe output is a hard requirement, verified against a real
 * Mermaid 11 renderer as well as against our own ingest:
 *   - ids are sanitized to `[A-Za-z0-9_]` (IR `orders-db` -> `orders_db`;
 *     `convertMermaid` normalizes that back to `orders-db`), unique per
 *     diagram, collisions get `_2`, `_3` …, and ids a Mermaid parser reads as
 *     a keyword (`style`, `subgraph`, `end`) get an `n_` prefix;
 *   - flowchart labels: `&` `<` `>` `"` become `&amp;` `&lt;` `&gt;`
 *     `&quot;` (the ingest decodes those back, so round trips are exact),
 *     newlines/tabs/control chars collapse to spaces, and a label is bare only
 *     when unambiguous — otherwise it is quoted (`id["(x)"]`,
 *     `-->|"a;b"|`) so shape delimiters, `|` and statement separators cannot
 *     break the file; a `|` inside an edge label becomes the Mermaid `#124;`
 *     entity. Real Mermaid renders quoted labels/edge labels without the
 *     quotes;
 *   - sequence text is free-form in Mermaid, so `<` `>` `&` and quotes are
 *     left as text (escaping them to entities would inject the `;` statement
 *     separator); only `;` (-> `,`), an odd quote count (-> `'`) and
 *     unbalanced brackets (-> quoted form) are normalised, with warnings.
 *
 * Warning-only (never fatal) losses: notes on flowcharts, walkthrough steps,
 * diff statuses (`status`), sublabels (unless `{ sublabels: true }` inlines
 * them), fragment messages with a single endpoint inside the group, and
 * invalid/degenerate IR entries that are skipped.
 *
 * Mermaid cannot carry Naqsha's full fidelity: group `kind` (zone vs boundary)
 * and most node kinds collapse into Mermaid shapes, and a fragment label gains
 * its block type prefix on re-ingest (`fallback` -> `loop: fallback`).
 *
 * @param {object} ir Naqsha IR v1 object
 * @param {{sublabels?: boolean}} [options] `sublabels: true` appends
 *   `" - sublabel"` to a node/participant label when the result fits in
 *   Naqsha's 80-character label budget (Mermaid has no sub-label).
 * @returns {{ok: boolean, mermaid: string, warnings: Array<{code: string, message: string}>}}
 */
import { DIAGRAM_TYPES } from "../validate/index.mjs";
export function toMermaid(ir, options = {}) {
  const settings = { sublabels: Boolean(options && options.sublabels) };
  if (!ir || typeof ir !== "object" || Array.isArray(ir)) {
    return {
      ok: false,
      mermaid: "",
      warnings: [
        {
          code: "to-mermaid/invalid-ir",
          message: "toMermaid() expects a Naqsha IR object with title, type, nodes and edges",
        },
      ],
    };
  }
  if (ir.type === "sequence") return exportSequence(ir, settings);
  if (ir.type === "erd") return exportErd(ir, settings);
  if (ir.type === "class") return exportClassDiagram(ir, settings);
  if (FLOW_TYPES.has(ir.type)) return exportFlowchart(ir, settings);
  if (DIAGRAM_TYPES.includes(ir.type)) return exportFlowchart(ir, settings, ir.type);
  return {
    ok: false,
    mermaid: "",
    warnings: [
      {
        code: "to-mermaid/unsupported-type",
        message: `cannot export ${JSON.stringify(ir.type)}: the IR "type" must be one of ${DIAGRAM_TYPES.join(", ")}; anything else is not a Naqsha diagram`,
      },
    ],
  };
}

export default toMermaid;

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */

const FLOW_TYPES = new Set(["architecture", "workflow"]);
const NODE_KINDS = new Set(["service", "datastore", "actor", "external", "queue", "compute", "security", "state", "note"]);
const EDGE_KINDS = new Set(["main", "return", "async", "security", "message", "data"]);
const STATUSES = new Set(["added", "removed", "changed"]);
const BLOCK_TYPES = new Set(["loop", "alt", "opt", "par", "critical", "break", "rect"]);
/** Naqsha's hard label budget: an inlined `label - sublabel` must still fit. */
const SUBLABEL_MAX = 80;
/** Keep generated ids in Mermaid's comfortable range. */
const ID_MAX = 40;
/** First tokens the flowchart ingest reads as directives; a node id equal to
 * one of these would make its declaration/edge line disappear. */
const FLOW_RESERVED = new Set([
  "subgraph", "direction", "end", "graph", "flowchart", "classdef", "class",
  "style", "linkstyle", "click", "callback", "acctitle", "accdescr", "default",
  "title",
]);

/** Flowchart shape pairs per IR node kind (contract §IR → Mermaid). */
const SHAPES = {
  service: ["[", "]"],
  queue: ["[", "]"],
  compute: ["[", "]"],
  state: ["[", "]"],
  actor: ["([", "])"],
  datastore: ["[(", ")]"],
  security: ["{", "}"],
  note: [">", "]"],
  external: ["[[", "]]"],
};

/** Flowchart edge syntax per IR edge kind (contract §IR → Mermaid). */
const FLOW_ARROWS = {
  main: "-->",
  data: "-->",
  async: "-.->",
  return: "-.->",
  security: "==>",
  message: "==>",
};

/** IR cardinality -> Mermaid ER relation token (the from-side marker first). */
const ER_CARDINALITY = { "1:1": "||--||", "1:n": "||--o{", "n:m": "}o--o{" };
/** Used for an invalid IR so the file still parses; warned about. */
const ER_CARDINALITY_DEFAULT = "1:n";
/** IR attribute key -> Mermaid ER row mark. */
const ER_ATTRIBUTE_MARK = { pk: "PK", fk: "FK", unique: "UK" };
/** Relation tokens for the three class kinds whose IR direction is literal;
 * extends/implements are emitted reversed (marker on the parent side). */
const CLASS_RELATION = { association: "-->", composition: "*--", dependency: "..>" };
/** Ids a Mermaid er/class parser would read as a directive get an `n_` prefix. */
const DIALECT_RESERVED = new Set([
  "direction", "erdiagram", "class", "classdiagram", "namespace", "note",
  "end", "style", "click", "callback", "link", "cssclass",
]);

/** Sequence arrow per IR edge kind. `security`/`data` are unavoidable
 * approximations: Mermaid sequence arrows have no security/data form. */
const SEQ_ARROWS = {
  main: "->>",
  return: "-->>",
  async: "-)",
  security: "--x",
  data: "->>",
  message: "->",
};

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (text) => Array.from(text).length;
const shown = (value, max = 60) => {
  const list = Array.from(String(value));
  return list.length > max ? `${list.slice(0, max - 3).join("")}...` : list.join("");
};

function pushWarning(warnings, code, message) {
  warnings.push({ code, message });
}

function newStats() {
  return {
    nodesSkipped: 0,
    duplicateNodes: 0,
    missingNodeLabels: 0,
    unknownNodeKinds: 0,
    idsNormalized: 0,
    sublabelsDropped: 0,
    sublabelsInlined: 0,
    labelCollapsed: 0,
    groupsSkipped: 0,
    groupMembersMissing: 0,
    groupOverlap: 0,
    emptyGroups: 0,
    groupMismatch: 0,
    edgesSkipped: 0,
    duplicateEdges: 0,
    selfEdges: 0,
    unknownEdgeKinds: 0,
    edgeLabelsSanitized: 0,
    textSanitized: 0,
    textQuoted: 0,
    notesDropped: 0,
    notesEmitted: 0,
    walkthrough: 0,
    statusNodes: 0,
    statusEdges: 0,
    directionIgnored: 0,
    fragmentsSkipped: 0,
    fragmentsEmpty: 0,
    fragmentsSplit: 0,
    fragmentsOverlap: 0,
    fragmentPartialMessages: 0,
    fragmentIdleMembers: 0,
    groupsDropped: 0,
    erdAttributesMissing: 0,
    erdAttrSanitized: 0,
    erdRefDropped: 0,
    erdKeyIgnored: 0,
    erdCardinalityDefault: 0,
    classMemberSanitized: 0,
    classEdgeKindMapped: 0,
    stereotypeIgnored: 0,
    labelSanitized: 0,
  };
}

/** Newlines, tabs and control characters cannot live in a Mermaid statement. */
function collapseControl(raw) {
  return String(raw)
    .replace(/\r\n?/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ");
}

const hasControlChars = (raw) => /[\r\n\u0000-\u001f\u007f]/.test(String(raw));

/** HTML entities: `convertMermaid` decodes exactly these, so the round trip
 * keeps the original text (`&` first, or the other replacements get re-escaped). */
function escapeEntities(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** True when `[`/`]`, `{`/`}` and `(`/`)` nest correctly. Unbalanced brackets
 * outside quotes would make the Mermaid ingest join the following line. */
function balancedDelimiters(text) {
  const pairs = { "]": "[", "}": "{", ")": "(" };
  const stack = [];
  for (const ch of String(text)) {
    if (ch === "[" || ch === "{" || ch === "(") stack.push(ch);
    else if (ch === "]" || ch === "}" || ch === ")") {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

/** Strip text for a label: collapse control chars and trim. */
function cleanText(raw) {
  return collapseControl(raw).replace(/^\s+|\s+$/g, "");
}

/** Sanitized, unique Mermaid id. Valid IR ids keep their identity:
 * `orders-db` -> `orders_db` -> (ingest normalizeId) `orders-db`. Ids that a
 * Mermaid parser treats as a statement keyword (`subgraph`, `style`, …) get an
 * `n_` prefix so a node declaration never turns into a directive. */
function mermaidId(raw, used, reserved) {
  let base = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "node";
  if (/^[0-9]/.test(base)) base = `n_${base}`;
  if (base.length > ID_MAX) base = base.slice(0, ID_MAX).replace(/_+$/g, "");
  if (!base) base = "node";
  if (reserved && reserved.has(base)) base = `n_${base}`;
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `_${counter}`;
    candidate = `${base.slice(0, ID_MAX - suffix.length).replace(/_+$/g, "")}${suffix}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** The id `convertMermaid` will hand back for a (sanitized) exported id. */
function expectedId(raw) {
  return String(raw).trim().toLowerCase().replace(/-/g, "_");
}

/* ------------------------------------------------------------------------- */
/* Front matter (title/subtitle survive through the YAML block)              */
/* ------------------------------------------------------------------------- */

/** Quote a YAML scalar only when a plain scalar would be ambiguous. */
function yamlScalar(value) {
  const text = cleanText(value);
  if (!text) return null;
  const needsQuotes =
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /: | #|:$/.test(text) ||
    text.includes('"') ||
    text.includes("'");
  if (!needsQuotes) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontMatter(ir) {
  const lines = [];
  const title = typeof ir.title === "string" ? yamlScalar(ir.title) : null;
  const subtitle = typeof ir.subtitle === "string" ? yamlScalar(ir.subtitle) : null;
  if (!title && !subtitle) return lines;
  lines.push("---");
  if (title) lines.push(`title: ${title}`);
  if (subtitle) lines.push(`subtitle: ${subtitle}`);
  lines.push("---");
  return lines;
}

/* ------------------------------------------------------------------------- */
/* Shared IR → model                                                         */
/* ------------------------------------------------------------------------- */

/** Collect nodes in declaration order with sanitized ids and final labels. */
function buildNodes(ir, settings, stats, reserved) {
  const rawNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const used = new Set();
  const list = [];
  const byRawId = new Map();
  rawNodes.forEach((node, index) => {
    if (!isObj(node)) {
      stats.nodesSkipped += 1;
      return;
    }
    let rawId = typeof node.id === "string" && node.id.trim() ? node.id.trim() : "";
    if (!rawId) {
      rawId = `node-${index + 1}`;
      stats.nodesSkipped += 1;
    }
    if (byRawId.has(rawId)) {
      stats.duplicateNodes += 1;
      return;
    }
    const id = mermaidId(rawId, used, reserved);
    if (id !== expectedId(rawId)) stats.idsNormalized += 1;
    let kind = "service";
    if (typeof node.kind === "string" && NODE_KINDS.has(node.kind)) kind = node.kind;
    else if (node.kind !== undefined) stats.unknownNodeKinds += 1;

    let label = typeof node.label === "string" && node.label.trim() ? node.label : "";
    if (!label) {
      label = rawId;
      stats.missingNodeLabels += 1;
    }
    const sublabel = typeof node.sublabel === "string" ? cleanText(node.sublabel) : "";
    if (sublabel) {
      if (settings.sublabels) {
        const candidate = `${cleanText(label)} - ${sublabel}`;
        if (chars(candidate) <= SUBLABEL_MAX) {
          label = candidate;
          stats.sublabelsInlined += 1;
        } else {
          stats.sublabelsDropped += 1;
        }
      } else {
        stats.sublabelsDropped += 1;
      }
    }
    if (typeof node.status === "string" && STATUSES.has(node.status)) stats.statusNodes += 1;
    const record = {
      rawId,
      id,
      label,
      kind,
      group: typeof node.group === "string" && node.group ? node.group : null,
      // Payload for the relational dialects; ignored by flowchart/sequence.
      attributes: Array.isArray(node.attributes) ? node.attributes : null,
      members: Array.isArray(node.members) ? node.members : null,
      stereotype: typeof node.stereotype === "string" ? node.stereotype : null,
    };
    list.push(record);
    byRawId.set(rawId, record);
  });
  return { list, byRawId };
}

/** Collect groups in declaration order; membership follows `groups[].nodes`. */
function buildGroups(ir, model, stats) {
  const rawGroups = Array.isArray(ir.groups) ? ir.groups : [];
  const used = new Set();
  const claimed = new Set();
  const groups = [];
  const byRawId = new Map();
  for (const group of rawGroups) {
    if (!isObj(group)) {
      stats.groupsSkipped += 1;
      continue;
    }
    let rawId = typeof group.id === "string" && group.id.trim() ? group.id.trim() : "";
    if (!rawId) {
      rawId = `group-${groups.length + 1}`;
      stats.groupsSkipped += 1;
    }
    if (byRawId.has(rawId)) {
      stats.groupsSkipped += 1;
      continue;
    }
    const members = [];
    for (const rawNodeId of Array.isArray(group.nodes) ? group.nodes : []) {
      const node = model.byRawId.get(rawNodeId);
      if (!node) {
        stats.groupMembersMissing += 1;
        continue;
      }
      if (claimed.has(node.rawId)) {
        stats.groupOverlap += 1;
        continue;
      }
      claimed.add(node.rawId);
      members.push(node);
    }
    if (members.length === 0) {
      stats.emptyGroups += 1;
      continue;
    }
    const record = {
      rawId,
      id: mermaidId(rawId, used),
      label: typeof group.label === "string" && group.label.trim() ? group.label : rawId,
      members,
    };
    groups.push(record);
    byRawId.set(rawId, record);
  }
  for (const node of model.list) {
    if (!node.group) continue;
    const group = byRawId.get(node.group);
    if (!group || !group.members.some((member) => member.rawId === node.rawId)) stats.groupMismatch += 1;
  }
  return groups;
}

/** Collect edges in declaration order, dropping entries Mermaid cannot draw. */
function buildEdges(ir, model, stats) {
  const rawEdges = Array.isArray(ir.edges) ? ir.edges : [];
  const seen = new Set();
  const edges = [];
  for (const edge of rawEdges) {
    if (!isObj(edge)) {
      stats.edgesSkipped += 1;
      continue;
    }
    const from = model.byRawId.get(edge.from);
    const to = model.byRawId.get(edge.to);
    if (!from || !to) {
      stats.edgesSkipped += 1;
      continue;
    }
    if (from.rawId === to.rawId) {
      stats.selfEdges += 1;
      continue;
    }
    const label = typeof edge.label === "string" ? cleanText(edge.label) : "";
    const key = `${from.rawId}\u0000${to.rawId}\u0000${label}`;
    if (seen.has(key)) {
      stats.duplicateEdges += 1;
      continue;
    }
    seen.add(key);
    let kind = "main";
    if (typeof edge.kind === "string" && EDGE_KINDS.has(edge.kind)) kind = edge.kind;
    else if (edge.kind !== undefined) stats.unknownEdgeKinds += 1;
    if (typeof edge.status === "string" && STATUSES.has(edge.status)) stats.statusEdges += 1;
    edges.push({ from, to, label, kind });
  }
  return edges;
}

/* ------------------------------------------------------------------------- */
/* Flowchart                                                                 */
/* ------------------------------------------------------------------------- */

function flowNodeLine(node, stats) {
  const [open, close] = SHAPES[node.kind] || SHAPES.service;
  if (hasControlChars(node.label)) stats.labelCollapsed += 1;
  const escaped = escapeEntities(cleanText(node.label)) || escapeEntities(node.id);
  // Quotes keep link/shape delimiters (and `|`, which Mermaid only accepts in
  // quoted labels) from breaking the file.
  const body = /[[\]{}()|]/.test(escaped) ? `"${escaped}"` : escaped;
  return `${node.id}${open}${body}${close}`;
}

function flowGroupHeader(group, stats) {
  if (hasControlChars(group.label)) stats.labelCollapsed += 1;
  const escaped = escapeEntities(cleanText(group.label)) || escapeEntities(group.id);
  const body = /[[\]{}()|]/.test(escaped) ? `"${escaped}"` : escaped;
  return `subgraph ${group.id}[${body}]`;
}

/** Edge label for `from -->|label| to`. A bare pipe label is only safe when it
 * has no `;` (our ingest's statement separator) and no unbalanced brackets;
 * otherwise quotes protect it. Real Mermaid renders quoted edge labels without
 * the quotes (verified against Mermaid 11), and the pipe delimiter itself only
 * exists as the `#124;` entity code. */
function flowEdgeLabel(label, stats) {
  if (!label) return "";
  if (hasControlChars(label)) stats.labelCollapsed += 1;
  let text = label;
  if (text.includes("|")) {
    text = text.replace(/\|/g, "#124;");
    stats.edgeLabelsSanitized += 1;
  }
  const escaped = escapeEntities(text);
  if (!escaped) return "";
  // A bare pipe label cannot hold `;` (statement separator) or any bracket — the
  // Mermaid lexer treats `(`/`[`/`{` as shape syntax there; quoting fixes both and
  // renders without the quotes.
  const bare = !escaped.includes(";") && !/[[\]{}()]/.test(escaped);
  return bare ? `|${escaped}|` : `|"${escaped}"|`;
}

function exportFlowchart(ir, settings, simplifiedType = null) {
  const warnings = [];
  const stats = newStats();
  if (simplifiedType) {
    pushWarning(warnings, "to-mermaid/type-simplified", `"${simplifiedType}" has no native Mermaid dialect; exported as a flowchart with nodes, edges and groups (type-specific fields are dropped)`);
  }
  const model = buildNodes(ir, settings, stats, FLOW_RESERVED);
  if (model.list.length === 0) {
    pushWarning(warnings, "to-mermaid/no-nodes", "the IR has no usable nodes, so there is nothing to draw");
    return { ok: false, mermaid: "", warnings };
  }
  const groups = buildGroups(ir, model, stats);
  if (typeof ir.direction === "string" && ir.direction !== "TB" && ir.direction !== "LR") stats.directionIgnored += 1;

  const lines = frontMatter(ir);
  lines.push(`flowchart ${ir.direction === "LR" ? "LR" : "TD"}`);

  const grouped = new Set();
  for (const group of groups) for (const member of group.members) grouped.add(member.rawId);
  for (const node of model.list) {
    if (!grouped.has(node.rawId)) lines.push(`  ${flowNodeLine(node, stats)}`);
  }
  for (const group of groups) {
    lines.push(`  ${flowGroupHeader(group, stats)}`);
    for (const member of group.members) lines.push(`    ${flowNodeLine(member, stats)}`);
    lines.push("  end");
  }

  const edges = buildEdges(ir, model, stats);
  for (const edge of edges) {
    const arrow = FLOW_ARROWS[edge.kind] || FLOW_ARROWS.main;
    const label = flowEdgeLabel(edge.label, stats);
    lines.push(`  ${label ? `${edge.from.id} ${arrow}${label} ${edge.to.id}` : `${edge.from.id} ${arrow} ${edge.to.id}`}`);
  }

  appendLossWarnings(ir, warnings, stats, { sequence: false });
  return { ok: true, mermaid: `${lines.join("\n")}\n`, warnings };
}

/* ------------------------------------------------------------------------- */
/* Sequence                                                                  */
/* ------------------------------------------------------------------------- */

/** Text that can live after `:`/`as`/`Note ...:` in a sequence statement.
 *
 * Mermaid sequence text is free-form: `&`, `<`, `>` and even quotes render
 * literally (verified against Mermaid 11), and so does the Naqsha ingest, so no
 * entity escaping is needed — and HTML entities would break both parsers,
 * because `;` is a statement separator there. Only the structural cases are
 * normalised: `;` becomes a comma, an odd quote count becomes `'` (a lone quote
 * would swallow the following lines), and unbalanced brackets force a quoted
 * form so the statement stays intact; both parsers accept quoted text. */
function sequenceText(raw, stats) {
  const original = String(raw ?? "");
  if (hasControlChars(original)) stats.labelCollapsed += 1;
  let text = cleanText(original);
  if (text.includes(";")) {
    text = text.replace(/;/g, ",");
    stats.textSanitized += 1;
  }
  const quotes = (text.match(/"/g) || []).length;
  if (!balancedDelimiters(text)) {
    if (quotes > 0) {
      text = text.replace(/"/g, "'");
      stats.textSanitized += 1;
    }
    stats.textQuoted += 1;
    return `"${text}"`;
  }
  if (quotes % 2 === 1) {
    text = text.replace(/"/g, "'");
    stats.textSanitized += 1;
  }
  return text;
}

/** Decide the Mermaid block type for a fragment label. Naqsha's own ingest
 * stores `alt: valid token`, so the prefix it added is peeled off again to keep
 * the round trip exact. */
function fragmentBlock(label) {
  const text = cleanText(label);
  const match = /^(loop|alt|opt|par|critical|break|rect)\s*:\s*([\s\S]*)$/i.exec(text);
  if (match) return { type: match[1].toLowerCase(), label: cleanText(match[2]) };
  if (BLOCK_TYPES.has(text.toLowerCase())) return { type: text.toLowerCase(), label: "" };
  return { type: "loop", label: text };
}

/** Turn fragment groups into non-overlapping message runs. */
function planFragmentBlocks(edges, fragments, warnings, stats) {
  const opens = new Map();
  const closes = new Map();
  for (const fragment of fragments) {
    const inGroup = fragment.members;
    const flags = edges.map((edge) =>
      inGroup.has(edge.from.rawId) && inGroup.has(edge.to.rawId) ? 2 : inGroup.has(edge.from.rawId) || inGroup.has(edge.to.rawId) ? 1 : 0,
    );
    const usedMembers = new Set();
    flags.forEach((flag, index) => {
      if (flag === 2) {
        usedMembers.add(edges[index].from.rawId);
        usedMembers.add(edges[index].to.rawId);
      }
      if (flag !== 1) return;
      stats.fragmentPartialMessages += 1;
      const edge = edges[index];
      const label = edge.label ? ` ("${shown(edge.label, 40)}")` : "";
      pushWarning(
        warnings,
        "to-mermaid/fragment-partial-message",
        `message ${edge.from.rawId} -> ${edge.to.rawId}${label} has only one endpoint inside fragment "${shown(fragment.label || "fragment")}" — a Mermaid block cannot wrap it, so it stays outside`,
      );
    });

    const runs = [];
    let start = -1;
    flags.forEach((flag, index) => {
      if (flag === 2 && start < 0) start = index;
      else if (flag !== 2 && start >= 0) {
        runs.push({ start, end: index - 1 });
        start = -1;
      }
    });
    if (start >= 0) runs.push({ start, end: flags.length - 1 });
    if (runs.length === 0) {
      stats.fragmentsEmpty += 1;
      pushWarning(
        warnings,
        "to-mermaid/fragment-empty",
        `fragment "${shown(fragment.label || "fragment")}" has no message with both endpoints inside it — Mermaid blocks cannot express it, so it was dropped`,
      );
      continue;
    }
    for (const member of inGroup) {
      if (!usedMembers.has(member)) stats.fragmentIdleMembers += 1;
    }
    if (runs.length > 1) {
      stats.fragmentsSplit += 1;
      pushWarning(
        warnings,
        "to-mermaid/fragment-split",
        `fragment "${shown(fragment.label || "fragment")}" wraps ${runs.length} non-adjacent runs of messages, so it becomes ${runs.length} blocks (message order is preserved)`,
      );
    }
    const block = fragmentBlock(fragment.label);
    const labelText = block.label ? sequenceText(block.label, stats) : "";
    const header = labelText ? `${block.type} ${labelText}` : block.type;
    for (const run of runs) {
      if (opens.has(run.start) || closes.has(run.end)) {
        stats.fragmentsOverlap += 1;
        continue;
      }
      opens.set(run.start, header);
      closes.set(run.end, "end");
    }
  }
  return { opens, closes };
}

function exportSequence(ir, settings) {
  const warnings = [];
  const stats = newStats();
  const model = buildNodes(ir, settings, stats);
  if (model.list.length === 0) {
    pushWarning(warnings, "to-mermaid/no-nodes", "the IR has no usable participants, so there is nothing to draw");
    return { ok: false, mermaid: "", warnings };
  }
  if (typeof ir.direction === "string") stats.directionIgnored += 1;

  const lines = frontMatter(ir);
  lines.push("sequenceDiagram");
  for (const node of model.list) {
    const role = node.kind === "actor" ? "actor" : "participant";
    const label = sequenceText(node.label, stats);
    lines.push(label ? `  ${role} ${node.id} as ${label}` : `  ${role} ${node.id}`);
  }

  const notes = Array.isArray(ir.notes) ? ir.notes.filter((note) => typeof note === "string" && note.trim()) : [];
  const first = model.list[0].id;
  const last = model.list[model.list.length - 1].id;
  const targets = first === last ? first : `${first},${last}`;
  for (const note of notes) {
    const text = sequenceText(note, stats);
    if (!text) continue;
    stats.notesEmitted += 1;
    lines.push(`  Note over ${targets}: ${text}`);
  }
  if (notes.length > stats.notesEmitted) stats.notesDropped += notes.length - stats.notesEmitted;

  const edges = buildEdges(ir, model, stats);
  const fragments = [];
  for (const group of Array.isArray(ir.groups) ? ir.groups : []) {
    if (!isObj(group)) {
      stats.fragmentsSkipped += 1;
      continue;
    }
    if (group.kind !== "fragment") {
      stats.fragmentsSkipped += 1;
      continue;
    }
    const members = new Set();
    for (const rawNodeId of Array.isArray(group.nodes) ? group.nodes : []) {
      const node = model.byRawId.get(rawNodeId);
      if (node) members.add(node.rawId);
      else stats.groupMembersMissing += 1;
    }
    if (members.size === 0) {
      stats.fragmentsEmpty += 1;
      continue;
    }
    fragments.push({ members, label: typeof group.label === "string" ? group.label : "" });
  }
  const plan = planFragmentBlocks(edges, fragments, warnings, stats);

  let depth = 0;
  edges.forEach((edge, index) => {
    if (plan.opens.has(index)) {
      lines.push(`  ${"  ".repeat(depth)}${plan.opens.get(index)}`);
      depth += 1;
    }
    const arrow = SEQ_ARROWS[edge.kind] || SEQ_ARROWS.main;
    const text = edge.label ? sequenceText(edge.label, stats) : "";
    lines.push(`  ${"  ".repeat(depth)}${edge.from.id}${arrow}${edge.to.id}${text ? `: ${text}` : ":"}`);
    if (plan.closes.has(index)) {
      depth = Math.max(0, depth - 1);
      lines.push(`  ${"  ".repeat(depth)}end`);
    }
  });

  appendLossWarnings(ir, warnings, stats, { sequence: true });
  return { ok: true, mermaid: `${lines.join("\n")}\n`, warnings };
}


/* ------------------------------------------------------------------------- */
/* ERD (erDiagram)                                                           */
/* ------------------------------------------------------------------------- */

/** One Mermaid attribute word: letters, digits, `_`, `-`, `()` and `[]` are
 * accepted by the ER grammar; anything else is folded to `_` (warned). */
function mermaidWord(raw, fallback) {
  const original = String(raw ?? "").trim();
  let word = original
    .replace(/[^A-Za-z0-9_\-()[\]]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!word) word = fallback;
  else if (/^[0-9]/.test(word)) word = `${fallback}_${word}`;
  return { word, changed: word !== original };
}

/** Text inside a Mermaid quoted dialect label (entity/class alias, ER role).
 * Quotes and backslashes cannot be carried by these quoted strings, so they
 * degrade to `'`/`/` with a warning instead of breaking the file. */
function quotedDialectText(text, stats) {
  let value = text;
  if (value.includes('"') || value.includes("\\")) {
    value = value.replace(/\\/g, "/").replace(/"/g, "'");
    stats.labelSanitized += 1;
  }
  return value;
}

/** `id["Display label"]` only when the label says something the id does not. */
function dialectAlias(node, stats) {
  const label = cleanText(node.label);
  if (hasControlChars(node.label)) stats.labelCollapsed += 1;
  if (label === node.id) return "";
  return `["${quotedDialectText(label, stats)}"]`;
}

/** `TB`/`LR` for the dialects that accept a direction line; null when absent. */
function dialectDirection(ir, stats) {
  if (typeof ir.direction !== "string") return null;
  if (ir.direction === "TB" || ir.direction === "LR") return ir.direction;
  stats.directionIgnored += 1;
  return null;
}

/** Edges shared by erd/class: endpoints, dedupe and status flags only. */
function collectRelationEdges(ir, model, stats) {
  const rawEdges = Array.isArray(ir.edges) ? ir.edges : [];
  const seen = new Set();
  const edges = [];
  for (const edge of rawEdges) {
    if (!isObj(edge)) {
      stats.edgesSkipped += 1;
      continue;
    }
    const from = model.byRawId.get(edge.from);
    const to = model.byRawId.get(edge.to);
    if (!from || !to) {
      stats.edgesSkipped += 1;
      continue;
    }
    if (from.rawId === to.rawId) {
      stats.selfEdges += 1;
      continue;
    }
    const rawLabel = typeof edge.label === "string" ? edge.label : "";
    if (hasControlChars(rawLabel)) stats.labelCollapsed += 1;
    const label = cleanText(rawLabel);
    const key = `${from.rawId}\u0000${to.rawId}\u0000${label}`;
    if (seen.has(key)) {
      stats.duplicateEdges += 1;
      continue;
    }
    seen.add(key);
    if (typeof edge.status === "string" && STATUSES.has(edge.status)) stats.statusEdges += 1;
    edges.push({
      from,
      to,
      label,
      kind: typeof edge.kind === "string" ? edge.kind : null,
      cardinality: typeof edge.cardinality === "string" ? edge.cardinality : null,
    });
  }
  return edges;
}

function erdAttributeLine(attr, stats) {
  const type = mermaidWord(attr.type, "text");
  const name = mermaidWord(attr.name, "column");
  if (type.changed || name.changed) stats.erdAttrSanitized += 1;
  if (typeof attr.ref === "string" && attr.ref.trim()) stats.erdRefDropped += 1;
  if (attr.key !== undefined && attr.key !== null && !ER_ATTRIBUTE_MARK[attr.key]) stats.erdKeyIgnored += 1;
  const mark = ER_ATTRIBUTE_MARK[attr.key];
  return `${type.word} ${name.word}${mark ? ` ${mark}` : ""}`;
}

function exportErd(ir, settings) {
  const warnings = [];
  const stats = newStats();
  const model = buildNodes(ir, settings, stats, DIALECT_RESERVED);
  if (model.list.length === 0) {
    pushWarning(warnings, "to-mermaid/no-nodes", "the IR has no usable entities, so there is nothing to draw");
    return { ok: false, mermaid: "", warnings };
  }
  if (Array.isArray(ir.groups) && ir.groups.length > 0) stats.groupsDropped += ir.groups.length;

  const lines = frontMatter(ir);
  lines.push("erDiagram");
  const direction = dialectDirection(ir, stats);
  if (direction) lines.push(`  direction ${direction}`);

  for (const node of model.list) {
    const alias = dialectAlias(node, stats);
    const rows = [];
    for (const attr of Array.isArray(node.attributes) ? node.attributes : []) {
      if (!isObj(attr)) {
        stats.erdAttrSanitized += 1;
        continue;
      }
      rows.push(erdAttributeLine(attr, stats));
    }
    if (rows.length === 0) {
      stats.erdAttributesMissing += 1;
      rows.push("text id");
    }
    lines.push(`  ${node.id}${alias} {`);
    for (const row of rows) lines.push(`    ${row}`);
    lines.push("  }");
  }

  const edges = collectRelationEdges(ir, model, stats);
  for (const edge of edges) {
    let cardinality = edge.cardinality && ER_CARDINALITY[edge.cardinality] ? ER_CARDINALITY[edge.cardinality] : null;
    if (!cardinality) {
      cardinality = ER_CARDINALITY[ER_CARDINALITY_DEFAULT];
      stats.erdCardinalityDefault += 1;
    }
    const label = `"${quotedDialectText(edge.label, stats)}"`;
    lines.push(`  ${edge.from.id} ${cardinality} ${edge.to.id} : ${label}`);
  }

  appendLossWarnings(ir, warnings, stats, { sequence: false });
  return { ok: true, mermaid: `${lines.join("\n")}\n`, warnings };
}

/* ------------------------------------------------------------------------- */
/* Class (classDiagram)                                                      */
/* ------------------------------------------------------------------------- */

/** One class member row: emitted verbatim when the class grammar can hold it,
 * with braces folded (they would close the `class { … }` block early). */
function classMemberText(raw, stats) {
  let text = cleanText(raw);
  if (!text) {
    stats.classMemberSanitized += 1;
    return "";
  }
  let changed = false;
  if (/[{}]/.test(text)) {
    text = text.replace(/\{/g, "(").replace(/\}/g, ")");
    changed = true;
  }
  if (/^<<[\s\S]*>>$/.test(text)) {
    // A member that looks like a stereotype would be swallowed by the parser.
    text = text.replace(/^<<+/, "((").replace(/>>+$/, "))");
    changed = true;
  }
  if (changed) stats.classMemberSanitized += 1;
  return text;
}

/** Relation label on a class line. The class grammar stops the label at `;`
 * and `:`, so those are folded with a warning; quotes are legal there. */
function classRelationLabel(text, stats) {
  if (!text) return "";
  let value = text;
  if (/[;:]/.test(value)) {
    value = value.replace(/;\s*/g, ", ").replace(/:\s*/g, " - ");
  }
  if (/[{}]/.test(value)) value = value.replace(/\{/g, "(").replace(/\}/g, ")");
  if (value !== text) stats.labelSanitized += 1;
  return value;
}

function exportClassDiagram(ir, settings) {
  const warnings = [];
  const stats = newStats();
  const model = buildNodes(ir, settings, stats, DIALECT_RESERVED);
  if (model.list.length === 0) {
    pushWarning(warnings, "to-mermaid/no-nodes", "the IR has no usable classes, so there is nothing to draw");
    return { ok: false, mermaid: "", warnings };
  }
  if (Array.isArray(ir.groups) && ir.groups.length > 0) stats.groupsDropped += ir.groups.length;

  const lines = frontMatter(ir);
  lines.push("classDiagram");
  const direction = dialectDirection(ir, stats);
  if (direction) lines.push(`  direction ${direction}`);

  for (const node of model.list) {
    const alias = dialectAlias(node, stats);
    const members = [];
    for (const member of Array.isArray(node.members) ? node.members : []) {
      if (typeof member !== "string") {
        stats.classMemberSanitized += 1;
        continue;
      }
      if (hasControlChars(member)) stats.labelCollapsed += 1;
      const text = classMemberText(member, stats);
      if (text) members.push(text);
    }
    if (members.length === 0) {
      lines.push(`  class ${node.id}${alias}`);
    } else {
      lines.push(`  class ${node.id}${alias} {`);
      for (const member of members) lines.push(`    ${member}`);
      lines.push("  }");
    }
    if (node.stereotype === "interface" || node.stereotype === "abstract") lines.push(`  <<${node.stereotype}>> ${node.id}`);
    else if (node.stereotype && node.stereotype !== "class") stats.stereotypeIgnored += 1;
  }

  const edges = collectRelationEdges(ir, model, stats);
  for (const edge of edges) {
    let line;
    if (edge.kind === "extends") line = `${edge.to.id} <|-- ${edge.from.id}`;
    else if (edge.kind === "implements") line = `${edge.to.id} <|.. ${edge.from.id}`;
    else if (edge.kind && CLASS_RELATION[edge.kind]) line = `${edge.from.id} ${CLASS_RELATION[edge.kind]} ${edge.to.id}`;
    else if (edge.kind === null) line = `${edge.from.id} --> ${edge.to.id}`;
    else {
      // Generic flowchart kinds are valid IR, but class diagrams only carry the
      // five UML relations, so they become a plain association.
      stats.classEdgeKindMapped += 1;
      line = `${edge.from.id} --> ${edge.to.id}`;
    }
    const label = classRelationLabel(edge.label, stats);
    lines.push(`  ${line}${label ? ` : ${label}` : ""}`);
  }

  appendLossWarnings(ir, warnings, stats, { sequence: false });
  return { ok: true, mermaid: `${lines.join("\n")}\n`, warnings };
}


/* ------------------------------------------------------------------------- */
/* Warnings                                                                  */
/* ------------------------------------------------------------------------- */

/** Aggregate warnings, appended in a fixed order so output is deterministic. */
function appendLossWarnings(ir, warnings, stats, { sequence }) {
  if (Array.isArray(ir.walkthrough) && ir.walkthrough.length > 0) {
    stats.walkthrough = ir.walkthrough.length;
  }
  if (stats.walkthrough > 0) {
    pushWarning(
      warnings,
      "to-mermaid/walkthrough-dropped",
      `${stats.walkthrough} walkthrough step(s) have no Mermaid equivalent and were dropped (keep the HTML diagram for the tour)`,
    );
  }
  if (stats.statusNodes + stats.statusEdges > 0) {
    pushWarning(
      warnings,
      "to-mermaid/diff-status-dropped",
      `${stats.statusNodes} node status flag(s) and ${stats.statusEdges} edge status flag(s) were dropped — Mermaid has no diff styling, so a diff IR exports as a plain diagram`,
    );
  }
  if (!sequence && stats.notesDropped === 0 && Array.isArray(ir.notes) && ir.notes.length > 0) {
    stats.notesDropped = ir.notes.length;
  }
  if (stats.notesDropped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/notes-dropped",
      `${stats.notesDropped} note(s) have no Mermaid equivalent in this dialect and were dropped`,
    );
  }
  if (stats.sublabelsDropped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/sublabel-dropped",
      `${stats.sublabelsDropped} sublabel(s) have no Mermaid equivalent and were dropped — call toMermaid(ir, { sublabels: true }) to inline them as "label - sublabel" when they fit ${SUBLABEL_MAX} characters`,
    );
  }
  if (stats.sublabelsInlined > 0) {
    pushWarning(
      warnings,
      "to-mermaid/sublabel-inlined",
      `${stats.sublabelsInlined} sublabel(s) were appended to the label as "label - sublabel" because Mermaid has no separate sub-label`,
    );
  }
  if (stats.labelCollapsed > 0) {
    pushWarning(
      warnings,
      "to-mermaid/label-collapsed",
      `${stats.labelCollapsed} label(s) contained newlines or control characters; they were collapsed to single-line text`,
    );
  }
  if (stats.fragmentIdleMembers > 0) {
    pushWarning(
      warnings,
      "to-mermaid/fragment-idle-member",
      `${stats.fragmentIdleMembers} participant(s) listed in a fragment appear in no message inside it; Mermaid infers block membership from messages, so they will not come back in the group`,
    );
  }
  if (stats.fragmentsOverlap > 0) {
    pushWarning(warnings, "to-mermaid/fragment-overlap", `${stats.fragmentsOverlap} fragment message run(s) overlapped an earlier fragment and were left outside a block`);
  }
  if (stats.fragmentsSkipped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/group-skipped",
      `${stats.fragmentsSkipped} group(s) cannot be expressed in a Mermaid sequence diagram (only fragment groups map to loop/alt/opt blocks)`,
    );
  }
  if (stats.groupsDropped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/groups-dropped",
      `${stats.groupsDropped} group(s) were dropped — Mermaid erDiagram/classDiagram has no subgraph equivalent`,
    );
  }
  if (stats.erdAttributesMissing > 0) {
    pushWarning(
      warnings,
      "to-mermaid/erd-attributes",
      `${stats.erdAttributesMissing} entity entr${stats.erdAttributesMissing === 1 ? "y had" : "ies had"} no attribute rows; a placeholder row keeps the Mermaid entity valid`,
    );
  }
  if (stats.erdAttrSanitized > 0) {
    pushWarning(
      warnings,
      "to-mermaid/erd-attribute-sanitized",
      `${stats.erdAttrSanitized} ER attribute type/name value(s) contained characters a Mermaid ER row cannot hold and were folded to letters, digits, "_", "-", "()" and "[]"`,
    );
  }
  if (stats.erdKeyIgnored > 0) {
    pushWarning(warnings, "to-mermaid/erd-key-ignored", `${stats.erdKeyIgnored} attribute key value(s) were not pk/fk/unique and got no PK/FK/UK mark`);
  }
  if (stats.erdRefDropped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/erd-ref-dropped",
      `${stats.erdRefDropped} attribute reference target(s) (ref) have no Mermaid erDiagram equivalent and were dropped`,
    );
  }
  if (stats.erdCardinalityDefault > 0) {
    pushWarning(
      warnings,
      "to-mermaid/erd-cardinality",
      `${stats.erdCardinalityDefault} relationship(s) had no valid cardinality; they were written as ${ER_CARDINALITY_DEFAULT}`,
    );
  }
  if (stats.classMemberSanitized > 0) {
    pushWarning(
      warnings,
      "to-mermaid/class-member-sanitized",
      `${stats.classMemberSanitized} class member(s) contained characters the Mermaid class block cannot hold (empty, braces or a stereotype lookalike) and were adjusted`,
    );
  }
  if (stats.classEdgeKindMapped > 0) {
    pushWarning(
      warnings,
      "to-mermaid/class-edge-kind",
      `${stats.classEdgeKindMapped} class relation(s) used a non-UML kind and were exported as a plain association`,
    );
  }
  if (stats.stereotypeIgnored > 0) {
    pushWarning(warnings, "to-mermaid/stereotype-ignored", `${stats.stereotypeIgnored} unknown stereotype value(s) were ignored (Mermaid has interface/abstract)`);
  }
  if (stats.labelSanitized > 0) {
    pushWarning(
      warnings,
      "to-mermaid/label-sanitized",
      `${stats.labelSanitized} er/class label or relation value(s) contained characters Mermaid's quoted-string/role grammar cannot carry and were folded (quotes -> ', colons/semicolons -> punctuation)`,
    );
  }
  if (stats.idsNormalized > 0) {
    pushWarning(
      warnings,
      "to-mermaid/id-normalized",
      `${stats.idsNormalized} id(s) did not match Naqsha's id shape and were sanitized for Mermaid`,
    );
  }
  if (stats.nodesSkipped > 0) {
    pushWarning(warnings, "to-mermaid/node-skipped", `${stats.nodesSkipped} node entr${stats.nodesSkipped === 1 ? "y was" : "ies were"} skipped (missing object or id)`);
  }
  if (stats.duplicateNodes > 0) {
    pushWarning(warnings, "to-mermaid/duplicate-node", `${stats.duplicateNodes} duplicate node id(s) were skipped; the first definition wins`);
  }
  if (stats.missingNodeLabels > 0) {
    pushWarning(warnings, "to-mermaid/node-label", `${stats.missingNodeLabels} node(s) had no label; their id was used instead`);
  }
  if (stats.unknownNodeKinds > 0) {
    pushWarning(warnings, "to-mermaid/node-kind", `${stats.unknownNodeKinds} unknown node kind(s) were drawn as service boxes`);
  }
  if (stats.groupsSkipped > 0) {
    pushWarning(warnings, "to-mermaid/group-invalid", `${stats.groupsSkipped} group entr${stats.groupsSkipped === 1 ? "y was" : "ies were"} skipped (missing object or duplicate id)`);
  }
  if (stats.groupMembersMissing > 0) {
    pushWarning(warnings, "to-mermaid/group-member-missing", `${stats.groupMembersMissing} group member reference(s) pointed at unknown participants and were skipped`);
  }
  if (stats.groupOverlap > 0) {
    pushWarning(warnings, "to-mermaid/group-overlap", `${stats.groupOverlap} node(s) appeared in more than one group; the first group wins`);
  }
  if (stats.emptyGroups > 0) {
    pushWarning(warnings, "to-mermaid/group-empty", `${stats.emptyGroups} group(s) had no members and were skipped`);
  }
  if (stats.groupMismatch > 0) {
    pushWarning(
      warnings,
      "to-mermaid/group-mismatch",
      `${stats.groupMismatch} node(s) declare a group they are not listed in; membership was taken from groups[].nodes`,
    );
  }
  if (stats.edgesSkipped > 0) {
    pushWarning(warnings, "to-mermaid/edge-skipped", `${stats.edgesSkipped} edge entr${stats.edgesSkipped === 1 ? "y was" : "ies were"} skipped (missing object or unknown endpoint)`);
  }
  if (stats.duplicateEdges > 0) {
    pushWarning(warnings, "to-mermaid/duplicate-edge", `${stats.duplicateEdges} duplicate edge(s) were skipped; the first definition wins`);
  }
  if (stats.selfEdges > 0) {
    pushWarning(warnings, "to-mermaid/self-edge", `${stats.selfEdges} self-edge(s) cannot be expressed in IR v1 and were skipped`);
  }
  if (stats.unknownEdgeKinds > 0) {
    pushWarning(warnings, "to-mermaid/edge-kind", `${stats.unknownEdgeKinds} unknown edge kind(s) were drawn as plain arrows`);
  }
  if (stats.textQuoted > 0) {
    pushWarning(
      warnings,
      "to-mermaid/text-quoted",
      `${stats.textQuoted} sequence text(s) had unbalanced brackets and were written inside quotes so the Mermaid statement stays intact (Mermaid renders the surrounding quotes)`,
    );
  }
  if (stats.edgeLabelsSanitized + stats.textSanitized > 0) {
    const parts = [];
    if (stats.edgeLabelsSanitized > 0) parts.push(`${stats.edgeLabelsSanitized} edge label(s) contained "|" (written as the Mermaid entity #124;)`);
    if (stats.textSanitized > 0) parts.push(`${stats.textSanitized} sequence text(s) contained ";" or an unmatched quote (normalised to "," or "'")`);
    pushWarning(
      warnings,
      "to-mermaid/text-sanitized",
      `${parts.join(" and ")} — those characters are statement separators in the Mermaid grammar and cannot be reproduced safely`,
    );
  }
  if (stats.directionIgnored > 0) {
    pushWarning(
      warnings,
      "to-mermaid/direction-ignored",
      "direction was ignored — only flowchart, erd and class diagrams carry a TB/LR direction, and only TB/LR are valid values",
    );
  }
}
