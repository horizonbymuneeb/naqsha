/**
 * naqsha — compose({ scene, options }) -> one self-contained HTML string.
 *
 * Scene v1 in, interactive v1.0 viewer out. Everything is inlined: CSS, SVG, JS.
 * No network requests, no web fonts, no external assets, no dependencies.
 * The output is deterministic for a given scene + options.
 *
 * v1.0 additions (additive): scene.walkthrough tour, scene.diff styling +
 * chips, node/edge `status`, and the client-side SVG/PNG export action wired up
 * by viewer.js. Chrome is English-only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEW_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(VIEW_DIR, "template.html"), "utf8");
const STYLE = readFileSync(join(VIEW_DIR, "theme.css"), "utf8");
const SCRIPT = readFileSync(join(VIEW_DIR, "viewer.js"), "utf8");

const MODES = ["light", "dark", "auto"];
const THEME_NAMES = { auto: "follow system", light: "light", dark: "dark" };
const NEXT_THEME = { auto: "light", light: "dark", dark: "auto" };

const NODE_KINDS = [
  "service", "datastore", "actor", "external",
  "queue", "compute", "security", "state", "note"
];
const SHAPES = [
  "card", "pill", "diamond", "box", "note", "participant",
  "entity", "class", "event", "span", "stage", "state"
];
const EDGE_KINDS = [
  "main", "return", "async", "security", "message", "data",
  "extends", "implements", "composition", "association", "dependency"
];
const EDGE_LABELS = {
  main: "Main request",
  return: "Return / response",
  async: "Async event",
  security: "Security / auth",
  message: "Message",
  data: "Data flow",
  extends: "Extends",
  implements: "Implements",
  composition: "Composition",
  association: "Association",
  dependency: "Dependency"
};
/* v1.2 relational heads: hollow triangle (inheritance), filled diamond
   (composition at the whole end), dashed open (dependency), plain (association). */
const CLASS_EDGE_KINDS = ["extends", "implements", "composition", "association", "dependency"];
const CLASS_EDGE_DEFAULT = "association";
const STEREOTYPES = ["interface", "abstract", "class"];
const NODE_ROLES = ["root", "branch", "leaf", "start", "end", "state"];
const CARDINALITIES = ["1:1", "1:n", "n:m"];
const ARROWS = ["end", "start", "both", "none"];
const DIFF_STATUSES = ["added", "removed", "changed"];
const DIFF_BADGES = { added: "+", removed: "−", changed: "~" };
const DIFF_WORDS = { added: "added", removed: "removed", changed: "changed" };
const WORDS = {
  node: ["node", "nodes"],
  edge: ["edge", "edges"],
  group: ["group", "groups"]
};

/* ---- small helpers ---------------------------------------------------- */

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function num(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return n;
  return fallback === undefined ? 0 : fallback;
}

function fixed(n) {
  const rounded = Math.round(num(n) * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function plural(count, pair) {
  const one = Array.isArray(pair) ? pair[0] : pair;
  const many = Array.isArray(pair) ? (pair[1] || pair[0]) : pair;
  return count + " " + (count === 1 ? one : many);
}

/* {name} token fill for the few count/step sentences. */
function fill(template, vars) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/* JSON that is safe to inline inside a <script> element. */
function jsJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => (
    "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  ));
}

/* The artifact has a hard 120 KB budget, so the inlined stylesheet and script
   are compacted deterministically: comments and indentation go, token spacing
   stays exactly where ASI or CSS parsing needs it. The source files stay
   readable; only the rendered document is minified. */

const WORD_CHAR = /[A-Za-z0-9_$]/;

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/\s*:\s*/g, ":")
    .replace(/;}/g, "}")
    .trim();
}

/* JS: strip comments and indentation, drop whitespace that sits next to
   punctuation, and keep every source newline as one newline so automatic
   semicolon insertion can never change meaning. Strings, template literals and
   regular-expression literals are copied verbatim (the compactor must know a
   regex when it sees one: a `/` right after an operator starts a regex, after
   an identifier it is division). */
function minifyJs(source) {
  let out = "";
  let index = 0;
  const total = source.length;
  let quote = null;
  let pendingSpace = false;
  let pendingNewline = false;
  let last = "";
  let lastWord = "";

  const REGEX_AFTER = "([{,;:=!&|?+-*%<>~^";

  const flushSpace = (nextChar) => {
    if (pendingNewline) out += "\n";
    else if (pendingSpace && last && WORD_CHAR.test(last) && nextChar && WORD_CHAR.test(nextChar)) out += " ";
    pendingSpace = false;
    pendingNewline = false;
  };

  const emit = (text) => {
    out += text;
    last = text.charAt(text.length - 1);
    if (/^[A-Za-z0-9_$]+$/.test(text)) lastWord = text;
  };

  while (index < total) {
    const ch = source[index];
    if (quote) {
      const start = index;
      index += 1;
      while (index < total) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        index += 1;
      }
      emit(source.slice(start, index));
      quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      flushSpace(ch);
      quote = ch;
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < total && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? total : end + 2;
      pendingSpace = true;
      continue;
    }
    if (ch === "/" && (last === "" || REGEX_AFTER.indexOf(last) >= 0)) {
      const start = index;
      let inClass = false;
      index += 1;
      while (index < total) {
        const c = source[index];
        if (c === "\\") { index += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { index += 1; break; }
        index += 1;
      }
      while (index < total && /[a-z]/i.test(source[index])) index += 1;
      flushSpace("/");
      emit(source.slice(start, index));
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      while (index < total && " \t\n\r".indexOf(source[index]) >= 0) {
        if (source[index] === "\n") pendingNewline = true;
        else pendingSpace = true;
        index += 1;
      }
      continue;
    }
    flushSpace(ch);
    const start = index;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      while (index < total && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
    } else {
      index += 1;
    }
    emit(source.slice(start, index));
  }
  return out;
}

const STYLE_MIN = minifyCss(STYLE);
const SCRIPT_MIN = minifyJs(SCRIPT);

/* `<slug>-<type>.svg|.png` — Latin, filesystem-safe, never empty. */
function slugify(title) {
  const base = String(title == null ? "" : title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return base || "naqsha";
}

/* Advance-width estimate for the system sans stack. Only used to size
   decorative boxes (markers, halos, badges) — never to trim text: every label
   is drawn in full and box sizing is the layout's job. */
function textWidth(text, size) {
  return String(text).length * size * 0.55;
}

/* ---- scene normalization --------------------------------------------- */

/* Rows are the generic body model for table-ish shapes: ERD attributes and
   class members both land here. `mark` is only ever pk|fk|unique. */
function normalizeRows(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).slice(0, 12).forEach((row) => {
    let label = "";
    let right = "";
    let mark = null;
    if (row && typeof row === "object") {
      label = row.label != null ? String(row.label) : (row.name != null ? String(row.name) : "");
      right = row.right != null ? String(row.right) : (row.type != null ? String(row.type) : "");
      if (row.mark === "pk" || row.mark === "fk" || row.mark === "unique") mark = row.mark;
    } else if (row != null) {
      label = String(row);
    }
    if (label.length || right.length) out.push({ label, right, mark });
  });
  return out;
}

function rowsFromAttributes(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 12).map((attr) => ({
    label: attr && attr.name != null ? String(attr.name) : "",
    right: attr && attr.type != null ? String(attr.type) : "",
    mark: attr && (attr.key === "pk" || attr.key === "fk" || attr.key === "unique") ? attr.key : null
  })).filter((row) => row.label.length || row.right.length);
}

function rowsFromMembers(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 12)
    .filter((member) => typeof member === "string" && member.trim().length)
    .map((member) => ({ label: String(member), right: "", mark: null }));
}

function normalizeBox(raw) {
  if (!raw || typeof raw !== "object" || !(num(raw.w) > 0) || !(num(raw.h) > 0)) return null;
  return { x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h) };
}

function normalizePoints(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((point) => point && Number.isFinite(num(point.x, NaN)) && Number.isFinite(num(point.y, NaN)))
    .map((point) => ({ x: num(point.x), y: num(point.y) }));
}

function normalizeBar(node) {
  const raw = node.bar && typeof node.bar === "object" ? node.bar : null;
  if (!raw && node.start == null && node.duration == null) return null;
  return {
    start: raw ? num(raw.start, num(node.start, 0)) : num(node.start, 0),
    duration: Math.max(0, raw ? num(raw.duration, num(node.duration, 0)) : num(node.duration, 0))
  };
}

function normalizeAxis(raw, width, height) {
  if (!raw || typeof raw !== "object") return null;
  const ticks = (Array.isArray(raw.ticks) ? raw.ticks : [])
    .filter((tick) => tick && Number.isFinite(num(tick.x, NaN)))
    .slice(0, 24)
    .map((tick) => ({ x: num(tick.x), label: tick.label == null ? "" : String(tick.label) }));
  const x0 = Number.isFinite(num(raw.x0, NaN)) ? num(raw.x0) : 64;
  const x1 = Number.isFinite(num(raw.x1, NaN))
    ? num(raw.x1)
    : Math.max(x0 + 40, num(width, 800) - 32);
  const y = Number.isFinite(num(raw.y, NaN)) ? num(raw.y) : Math.max(48, num(height, 600) - 36);
  return {
    kind: raw.kind === "time" ? "time" : "numeric",
    min: num(raw.min, 0),
    max: num(raw.max, 1),
    x0,
    x1,
    y,
    ticks
  };
}

function normalizeLanes(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((lane) => lane && num(lane.h) > 0)
    .slice(0, 24)
    .map((lane, index) => ({
      id: lane.id == null ? "lane-" + index : String(lane.id),
      label: lane.label == null ? "" : String(lane.label),
      y: num(lane.y),
      h: num(lane.h)
    }));
}

function normalizeStatus(value) {
  return DIFF_STATUSES.indexOf(value) >= 0 ? value : null;
}

function normalizeScene(scene) {
  const shapeDefault = (node) => {
    switch (scene.type) {
      case "erd": return "entity";
      case "class": return "class";
      case "timeline": return "event";
      case "waterfall": return "span";
      case "lifecycle": return "state";
      case "sequence": return "participant";
      default:
        if (node.kind === "note") return "note";
        if (node.kind === "actor") return "pill";
        return "card";
    }
  };

  const nodes = (Array.isArray(scene.nodes) ? scene.nodes : [])
    .filter((node) => node && node.id != null && String(node.id).length)
    .map((node) => {
      const members = (Array.isArray(node.members) ? node.members : [])
        .filter((member) => typeof member === "string")
        .slice(0, 12)
        .map((member) => String(member));
      let rows = normalizeRows(node.rows);
      if (!rows.length && Array.isArray(node.attributes)) rows = rowsFromAttributes(node.attributes);
      if (!rows.length && members.length) rows = rowsFromMembers(members);
      return {
        id: String(node.id),
        label: node.label == null ? String(node.id) : String(node.label),
        sublabel: node.sublabel == null ? "" : String(node.sublabel),
        kind: NODE_KINDS.indexOf(node.kind) >= 0 ? node.kind : "service",
        shape: SHAPES.indexOf(node.shape) >= 0 ? node.shape : shapeDefault(node),
        x: num(node.x),
        y: num(node.y),
        w: Math.max(24, num(node.w, 120)),
        h: Math.max(18, num(node.h, 48)),
        group: node.group == null ? null : String(node.group),
        status: normalizeStatus(node.status),
        rows,
        members,
        stereotype: STEREOTYPES.indexOf(node.stereotype) >= 0 ? node.stereotype : null,
        role: NODE_ROLES.indexOf(node.role) >= 0 ? node.role : null,
        bar: normalizeBar(node),
        at: node.at == null ? null : node.at,
        lane: node.lane == null ? null : String(node.lane),
        stage: node.stage == null ? null : String(node.stage),
        leader: normalizePoints(node.leader),
        valueLabel: node.valueLabel == null ? "" : String(node.valueLabel),
        labelBox: normalizeBox(node.labelBox),
        valueBox: normalizeBox(node.valueBox)
      };
    });

  const known = new Set(nodes.map((node) => node.id));

  const edges = (Array.isArray(scene.edges) ? scene.edges : [])
    .filter((edge) => edge && edge.from != null && edge.to != null)
    .map((edge, index) => {
      const points = (Array.isArray(edge.points) ? edge.points : [])
        .filter((point) => point && Number.isFinite(num(point.x, NaN)) && Number.isFinite(num(point.y, NaN)))
        .map((point) => ({ x: num(point.x), y: num(point.y) }));
      let kind = EDGE_KINDS.indexOf(edge.kind) >= 0 ? edge.kind : "main";
      if (scene.type === "class" && CLASS_EDGE_KINDS.indexOf(kind) < 0) kind = CLASS_EDGE_DEFAULT;
      const card = edge.card == null ? (edge.cardinality == null ? "" : String(edge.cardinality)) : String(edge.card);
      return {
        id: edge.id == null ? "e" + (index + 1) : String(edge.id),
        from: String(edge.from),
        to: String(edge.to),
        label: edge.label == null ? "" : String(edge.label),
        kind,
        dashed: edge.dashed === true,
        arrow: ARROWS.indexOf(edge.arrow) >= 0 ? edge.arrow : "end",
        card: CARDINALITIES.indexOf(card) >= 0 ? card : "",
        points,
        labelBox: normalizeBox(edge.labelBox),
        status: normalizeStatus(edge.status)
      };
    })
    .filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to && edge.points.length >= 2);

  const groups = (Array.isArray(scene.groups) ? scene.groups : [])
    .filter((group) => group && num(group.w) > 0 && num(group.h) > 0)
    .map((group, index) => ({
      id: group.id == null ? "g" + (index + 1) : String(group.id),
      label: group.label == null ? "" : String(group.label),
      kind: group.kind === "fragment" ? "fragment" : (group.kind === "boundary" ? "boundary" : "zone"),
      x: num(group.x),
      y: num(group.y),
      w: num(group.w),
      h: num(group.h)
    }));

  let width = num(scene.width, 0);
  let height = num(scene.height, 0);
  if (!(width > 0) || !(height > 0)) {
    let maxX = 0;
    let maxY = 0;
    nodes.forEach((node) => { maxX = Math.max(maxX, node.x + node.w); maxY = Math.max(maxY, node.y + node.h); });
    groups.forEach((group) => { maxX = Math.max(maxX, group.x + group.w); maxY = Math.max(maxY, group.y + group.h); });
    edges.forEach((edge) => edge.points.forEach((point) => {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }));
    width = Math.ceil(maxX) + 48;
    height = Math.ceil(maxY) + 48;
  }

  const notes = (Array.isArray(scene.notes) ? scene.notes : [])
    .filter((note) => typeof note === "string" && note.trim().length)
    .slice(0, 4)
    .map((note) => note.trim());

  const type = scene.type == null ? "architecture" : String(scene.type);
  const legend = normalizeLegend(scene, edges, type);
  const walkthrough = normalizeWalkthrough(scene, known);
  const diff = normalizeDiff(scene, nodes, edges);
  const axis = normalizeAxis(scene.axis, width, height);
  const lanes = normalizeLanes(scene.lanes);

  return {
    type,
    title: scene.title == null ? "Untitled diagram" : String(scene.title),
    subtitle: scene.subtitle == null ? "" : String(scene.subtitle),
    width: Math.max(120, width),
    height: Math.max(120, height),
    slug: slugify(scene.title),
    nodes,
    edges,
    groups,
    notes,
    legend,
    walkthrough,
    diff,
    axis,
    lanes
  };
}

/* Per-type wording for a derived legend ("Main request" belongs to
   architecture, not to a clickstream). Layout-provided labels always win. */
const TYPE_EDGE_LABELS = {
  dataflow: { main: "Flow", data: "Data", async: "Scheduled", message: "Message" },
  lifecycle: { main: "Transition", return: "Rejected", async: "Retry" },
  tree: { main: "Contains" },
  erd: { main: "Relationship", data: "Reference" },
  timeline: { main: "Event" },
  waterfall: { main: "Span" },
  class: {}
};

function legendLabel(type, kind) {
  const map = TYPE_EDGE_LABELS[type];
  if (map && map[kind]) return map[kind];
  return EDGE_LABELS[kind] || kind;
}

function normalizeLegend(scene, edges, type) {
  const used = new Set(edges.map((edge) => edge.kind));
  const orderedUsed = EDGE_KINDS.filter((kind) => used.has(kind));
  const raw = Array.isArray(scene.legend) ? scene.legend : [];
  const picked = raw
    .filter((entry) => entry && EDGE_KINDS.indexOf(entry.kind) >= 0 && used.has(entry.kind))
    .slice(0, 6)
    .map((entry) => ({
      kind: entry.kind,
      label: entry.label == null || String(entry.label).trim() === ""
        ? legendLabel(type, entry.kind)
        : String(entry.label)
    }));
  if (picked.length) return picked;
  return orderedUsed.slice(0, 6).map((kind) => ({ kind, label: legendLabel(type, kind) }));
}

/* Walkthrough steps: max 10, focus is 1..6 existing node ids in reading order. */
function normalizeWalkthrough(scene, known) {
  const raw = Array.isArray(scene.walkthrough) ? scene.walkthrough : [];
  const steps = [];
  raw.slice(0, 10).forEach((step, index) => {
    if (!step || typeof step !== "object") return;
    const focus = [];
    (Array.isArray(step.focus) ? step.focus : []).forEach((rawId) => {
      const id = String(rawId);
      if (known.has(id) && focus.indexOf(id) < 0 && focus.length < 6) focus.push(id);
    });
    if (!focus.length) return;
    steps.push({
      n: steps.length + 1,
      title: step.title == null ? "Step " + (index + 1) : String(step.title),
      text: step.text == null ? "" : String(step.text),
      focus
    });
  });
  return steps;
}

/* Diff summary: scene.diff carries the header counts; when it is missing but
   nodes/edges still carry status, derive the same numbers. */
function normalizeDiff(scene, nodes, edges) {
  const derive = (status) => nodes.filter((node) => node.status === status).length +
    edges.filter((edge) => edge.status === status).length;
  const derived = {
    added: derive("added"),
    removed: derive("removed"),
    changed: derive("changed")
  };
  const raw = scene.diff && typeof scene.diff === "object" ? scene.diff : null;
  if (!raw && derived.added + derived.removed + derived.changed === 0) return null;
  const source = raw || {};
  const count = (key) => {
    const value = num(source[key], NaN);
    return Number.isFinite(value) ? value : derived[key];
  };
  return {
    base: source.base == null ? "" : String(source.base),
    head: source.head == null ? "" : String(source.head),
    added: count("added"),
    removed: count("removed"),
    changed: count("changed")
  };
}

function buildGraph(scene) {
  const out = Object.create(null);
  const inc = Object.create(null);
  const near = Object.create(null);
  const seen = Object.create(null);
  scene.nodes.forEach((node) => {
    out[node.id] = 0;
    inc[node.id] = 0;
    near[node.id] = 0;
    seen[node.id] = Object.create(null);
  });
  scene.edges.forEach((edge) => {
    if (out[edge.from] !== undefined) out[edge.from] += 1;
    if (inc[edge.to] !== undefined) inc[edge.to] += 1;
    if (seen[edge.from] && edge.to !== edge.from && seen[edge.from][edge.to] !== true) {
      seen[edge.from][edge.to] = true;
      near[edge.from] += 1;
    }
    if (seen[edge.to] && edge.from !== edge.to && seen[edge.to][edge.from] !== true) {
      seen[edge.to][edge.from] = true;
      near[edge.to] += 1;
    }
  });
  return { out, inc, near };
}

/* ---- node rendering --------------------------------------------------- */

function participantCardHeight(node) {
  return Math.min(node.h, 52);
}

function renderLabelBlock(node, options) {
  const opts = options || {};
  const padX = opts.padX === undefined ? 12 : opts.padX;
  const lineHeight = 16;
  const showSub = !!(node.sublabel && opts.showSub);
  const center = opts.center === true;
  const anchor = center ? "middle" : "start";
  const tx = center ? node.x + node.w / 2 : node.x + padX;
  const blockH = lineHeight + (showSub ? 3 + 14 : 0);
  const top = Math.max(node.y + 3, node.y + (node.h - blockH) / 2);
  const base = top + (lineHeight + 13 * 0.72) / 2;

  let out = '<text class="node-label" text-anchor="' + anchor + '">' +
    '<tspan x="' + fixed(tx) + '" y="' + fixed(base) + '">' + esc(node.label) + "</tspan></text>";

  if (showSub) {
    const subBase = top + lineHeight + 3 + (14 + 11 * 0.72) / 2;
    out += '<text class="node-sublabel" text-anchor="' + anchor + '">' +
      '<tspan x="' + fixed(tx) + '" y="' + fixed(subBase) + '">' + esc(node.sublabel) + "</tspan></text>";
  }
  return out;
}

function renderCard(node) {
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(node.x) + '" y="' + fixed(node.y) +
    '" width="' + fixed(node.w) + '" height="' + fixed(node.h) + '" rx="6"/>');
  if (node.h > 12) {
    parts.push('<rect class="node-stripe" x="' + fixed(node.x + 1) + '" y="' + fixed(node.y + 1) +
      '" width="3" height="' + fixed(node.h - 2) + '" rx="1.5"/>');
  }
  parts.push(renderLabelBlock(node, { padX: 14, showSub: true }));
  return parts.join("");
}

function renderBox(node) {
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(node.x) + '" y="' + fixed(node.y) +
    '" width="' + fixed(node.w) + '" height="' + fixed(node.h) + '" rx="2"/>');
  parts.push(renderLabelBlock(node, { padX: 12, showSub: true }));
  return parts.join("");
}

function renderPill(node) {
  const radius = Math.min(node.h / 2, node.w / 2);
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(node.x) + '" y="' + fixed(node.y) +
    '" width="' + fixed(node.w) + '" height="' + fixed(node.h) + '" rx="' + fixed(radius) + '"/>');
  parts.push(renderLabelBlock(node, {
    padX: 14,
    center: true,
    showSub: node.h >= 44
  }));
  return parts.join("");
}

function balancedLines(text, maxWidth, size) {
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!raw) return [];
  if (textWidth(raw, size) <= maxWidth) return [raw];
  const words = raw.split(" ");
  if (words.length < 2) return [raw];
  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(" ");
    const right = words.slice(i).join(" ");
    const width = Math.max(textWidth(left, size), textWidth(right, size));
    if (!best || width < best.width) best = { i, width };
  }
  return [words.slice(0, best.i).join(" "), words.slice(best.i).join(" ")];
}

function renderDiamond(node) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const inset = 1;
  const points = [
    [cx, node.y + inset],
    [node.x + node.w - inset, cy],
    [cx, node.y + node.h - inset],
    [node.x + inset, cy]
  ].map((pair) => fixed(pair[0]) + "," + fixed(pair[1])).join(" ");
  const lines = balancedLines(node.label, node.w * 0.62, 13);
  const lineHeight = 16;
  const blockH = lines.length * lineHeight;
  const top = node.y + (node.h - blockH) / 2;
  const base = top + (lineHeight + 13 * 0.72) / 2;
  return '<polygon class="node-box" points="' + points + '"/>' +
    '<text class="node-label" text-anchor="middle">' +
    lines.map((line, index) => (
      '<tspan x="' + fixed(cx) + '" y="' + fixed(base + index * lineHeight) + '">' + esc(line) + "</tspan>"
    )).join("") + "</text>";
}

function renderNote(node) {
  const fold = Math.min(12, Math.max(8, node.h / 4));
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const body = "M" + fixed(x + 2) + " " + fixed(y) +
    "H" + fixed(x + w - fold) +
    "L" + fixed(x + w) + " " + fixed(y + fold) +
    "V" + fixed(y + h - 2) +
    "Q" + fixed(x + w) + " " + fixed(y + h) + " " + fixed(x + w - 2) + " " + fixed(y + h) +
    "H" + fixed(x + 2) +
    "Q" + fixed(x) + " " + fixed(y + h) + " " + fixed(x) + " " + fixed(y + h - 2) +
    "V" + fixed(y + 2) +
    "Q" + fixed(x) + " " + fixed(y) + " " + fixed(x + 2) + " " + fixed(y) + "Z";
  const foldPath = "M" + fixed(x + w - fold) + " " + fixed(y) +
    "L" + fixed(x + w) + " " + fixed(y + fold) +
    "H" + fixed(x + w - fold) + "Z";
  return '<path class="node-box" d="' + body + '"/>' +
    '<path class="node-fold" d="' + foldPath + '"/>' +
    renderLabelBlock(node, { padX: 14, showSub: true });
}

function renderParticipant(node) {
  const cardH = participantCardHeight(node);
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(cardH) + '" rx="6"/>');

  if (cardH > 12) {
    parts.push('<rect class="node-stripe" x="' + fixed(x + 1) + '" y="' + fixed(y + 1) +
      '" width="3" height="' + fixed(cardH - 2) + '" rx="1.5"/>');
  }

  if (node.kind === "actor") {
    // small person glyph badge; the label block stays aligned with every other
    // participant card so the sequence header row reads as one band
    parts.push('<circle class="actor-head" cx="' + fixed(x + 15) + '" cy="' + fixed(y + 15) + '" r="3"/>');
    parts.push('<path class="actor-body" d="M' + fixed(x + 10) + " " + fixed(y + 22) +
      "Q" + fixed(x + 15) + " " + fixed(y + 17) + " " + fixed(x + 20) + " " + fixed(y + 22) + '"/>');
    parts.push(renderLabelBlock({
      x, y, w, h: cardH, label: node.label, sublabel: node.sublabel
    }, { center: true, showSub: !!node.sublabel, padX: 12 }));
  } else {
    parts.push(renderLabelBlock({
      x, y, w, h: cardH, label: node.label, sublabel: node.sublabel
    }, { center: true, showSub: !!node.sublabel, padX: 12 }));
  }
  return parts.join("");
}

/* ---- v1.2 shapes: relational bodies, timelines, spans, states ---------- */

function rowBaseline(top, rowHeight, size) {
  return top + rowHeight / 2 + size * 0.36;
}

function headerBand(x, y, w, h) {
  return "M" + fixed(x + 6) + " " + fixed(y) +
    "H" + fixed(x + w - 6) +
    "Q" + fixed(x + w) + " " + fixed(y) + " " + fixed(x + w) + " " + fixed(y + 6) +
    "V" + fixed(y + h) + "H" + fixed(x) + "V" + fixed(y + 6) +
    "Q" + fixed(x) + " " + fixed(y) + " " + fixed(x + 6) + " " + fixed(y) + "Z";
}

/* ERD table: header band + left-aligned name / right-aligned type columns,
   with a PK / FK / UQ mark column when any row carries a key. */
function renderEntity(node) {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const rows = node.rows;
  const headerH = Math.min(34, h);
  const bodyH = Math.max(0, h - headerH);
  const rowH = rows.length ? bodyH / rows.length : bodyH;
  const markW = rows.some((row) => row.mark) ? 22 : 0;
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="6"/>');
  if (h > 12) {
    parts.push('<rect class="node-stripe" x="' + fixed(x + 1) + '" y="' + fixed(y + 1) +
      '" width="3" height="' + fixed(h - 2) + '" rx="1.5"/>');
  }
  parts.push('<path class="table-head" d="' + headerBand(x, y, w, headerH) + '"/>');
  parts.push('<line class="table-rule" x1="' + fixed(x) + '" y1="' + fixed(y + headerH) +
    '" x2="' + fixed(x + w) + '" y2="' + fixed(y + headerH) + '"/>');
  parts.push('<text class="node-label node-table-title" text-anchor="start">' +
    '<tspan x="' + fixed(x + 16) + '" y="' + fixed(y + headerH / 2 + 4.6) + '">' +
    esc(node.label) + "</tspan></text>");
  rows.forEach((row, index) => {
    const top = y + headerH + index * rowH;
    const base = rowBaseline(top, rowH, 12);
    parts.push('<line class="table-row-rule" x1="' + fixed(x + 8) + '" y1="' + fixed(top) +
      '" x2="' + fixed(x + w - 8) + '" y2="' + fixed(top) + '"/>');
    if (row.mark) {
      const mark = row.mark === "unique" ? "UQ" : row.mark.toUpperCase();
      parts.push('<text class="table-mark mark-' + row.mark + '"><tspan x="' + fixed(x + 14) +
        '" y="' + fixed(base) + '">' + esc(mark) + "</tspan></text>");
    }
    parts.push('<text class="table-name"><tspan x="' + fixed(x + 14 + markW) +
      '" y="' + fixed(base) + '">' + esc(row.label) + "</tspan></text>");
    if (row.right) {
      parts.push('<text class="table-type" text-anchor="end"><tspan x="' + fixed(x + w - 14) +
        '" y="' + fixed(base) + '">' + esc(row.right) + "</tspan></text>");
    }
  });
  return parts.join("");
}

/* Class body: stereotype kicker under the class name, member rows below. */
function renderClassBox(node) {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const rows = node.rows;
  const headerH = Math.min(34, h);
  const bodyH = Math.max(0, h - headerH);
  const rowH = rows.length ? bodyH / rows.length : bodyH;
  const parts = [];
  parts.push('<rect class="node-box" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="6"/>');
  if (h > 12) {
    parts.push('<rect class="node-stripe" x="' + fixed(x + 1) + '" y="' + fixed(y + 1) +
      '" width="3" height="' + fixed(h - 2) + '" rx="1.5"/>');
  }
  parts.push('<path class="table-head" d="' + headerBand(x, y, w, headerH) + '"/>');
  parts.push('<line class="table-rule" x1="' + fixed(x) + '" y1="' + fixed(y + headerH) +
    '" x2="' + fixed(x + w) + '" y2="' + fixed(y + headerH) + '"/>');
  if (node.stereotype) {
    parts.push('<text class="node-label node-class-title" text-anchor="start">' +
      '<tspan x="' + fixed(x + 16) + '" y="' + fixed(y + 18) + '">' + esc(node.label) + "</tspan></text>");
    parts.push('<text class="node-stereotype" text-anchor="start">' +
      '<tspan x="' + fixed(x + 16) + '" y="' + fixed(y + 31) + '">' +
      esc(node.stereotype.toUpperCase()) + "</tspan></text>");
  } else {
    parts.push('<text class="node-label node-class-title" text-anchor="start">' +
      '<tspan x="' + fixed(x + 16) + '" y="' + fixed(y + headerH / 2 + 4.6) + '">' +
      esc(node.label) + "</tspan></text>");
  }
  rows.forEach((row, index) => {
    const top = y + headerH + index * rowH;
    const base = rowBaseline(top, rowH, 12);
    parts.push('<line class="table-row-rule" x1="' + fixed(x + 8) + '" y1="' + fixed(top) +
      '" x2="' + fixed(x + w - 8) + '" y2="' + fixed(top) + '"/>');
    parts.push('<text class="table-name table-member"><tspan x="' + fixed(x + 14) +
      '" y="' + fixed(base) + '">' + esc(row.label) + "</tspan></text>");
    if (row.right) {
      parts.push('<text class="table-type" text-anchor="end"><tspan x="' + fixed(x + w - 14) +
        '" y="' + fixed(base) + '">' + esc(row.right) + "</tspan></text>");
    }
  });
  return parts.join("");
}

/* Invisible full-row hit area: row-based shapes (span, event, state) have
   marks outside their visible box, so the group bbox centre can land on empty
   canvas. A transparent painted rect makes hover/click/focus/inspector work
   anywhere on the mark, and keeps minimap footprints honest. */
function hitRect(x, y, w, h) {
  return '<rect class="node-hit" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(Math.max(8, w)) + '" height="' + fixed(Math.max(8, h)) + '"/>';
}

function formatAt(value) {
  if (value == null) return "";
  return String(value);
}

/* Timeline event: card + kicker date, with the leader polyline and the axis
   dot travelling with the event so focus/hover dims the whole mark. */
function renderEvent(node) {
  const parts = [];
  /* card-only hit area: a leader-spanning rect would cover the card above it
     and steal its clicks (leaders travel up through earlier lanes) */
  parts.push(hitRect(node.x - 4, node.y - 4, node.w + 8, node.h + 8));
  if (node.leader.length) {
    const points = node.leader.map((point) => fixed(point.x) + "," + fixed(point.y)).join(" ");
    parts.push('<polyline class="event-leader" points="' + points + '"/>');
    const dot = node.leader[node.leader.length - 1];
    parts.push('<circle class="event-dot" cx="' + fixed(dot.x) + '" cy="' + fixed(dot.y) + '" r="2.8"/>');
  }
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  parts.push('<rect class="node-box" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="6"/>');
  if (h > 12) {
    parts.push('<rect class="node-stripe" x="' + fixed(x + 1) + '" y="' + fixed(y + 1) +
      '" width="3" height="' + fixed(h - 2) + '" rx="1.5"/>');
  }
  const hasAt = node.at != null && String(node.at).length > 0;
  const blockH = 16 + (hasAt ? 3 + 14 : 0);
  const top = Math.max(y + 3, y + (h - blockH) / 2);
  parts.push('<text class="node-label" text-anchor="start">' +
    '<tspan x="' + fixed(x + 14) + '" y="' + fixed(top + 12.7) + '">' + esc(node.label) + "</tspan></text>");
  if (hasAt) {
    parts.push('<text class="node-sublabel event-date" text-anchor="start">' +
      '<tspan x="' + fixed(x + 14) + '" y="' + fixed(top + 16 + 3 + 10.9) + '">' +
      esc(formatAt(node.at)) + "</tspan></text>");
  }
  return parts.join("");
}

/* Waterfall span: the bar itself plus the left-gutter name and right value
   boxes the layout prepared (full text, never trimmed). */
function renderSpan(node) {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const parts = [];
  const left = node.labelBox ? Math.min(node.labelBox.x, x) : x;
  const right = node.valueBox ? Math.max(node.valueBox.x + node.valueBox.w, x + w) : x + w;
  parts.push(hitRect(left - 4, y - 4, right - left + 8, h + 8));
  parts.push('<rect class="node-box span-bar" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="3"/>');
  if (node.labelBox) {
    const box = node.labelBox;
    parts.push('<text class="span-name" text-anchor="end">' +
      '<tspan x="' + fixed(box.x + box.w) + '" y="' + fixed(box.y + box.h / 2 + 4) + '">' +
      esc(node.label) + "</tspan></text>");
  }
  const value = node.valueLabel || (node.bar ? String(node.bar.duration) : "");
  if (value) {
    const box = node.valueBox;
    if (box) {
      parts.push('<text class="span-value" text-anchor="start">' +
        '<tspan x="' + fixed(box.x) + '" y="' + fixed(box.y + box.h / 2 + 4) + '">' +
        esc(value) + "</tspan></text>");
    } else {
      parts.push('<text class="span-value" text-anchor="start">' +
        '<tspan x="' + fixed(x + w + 8) + '" y="' + fixed(y + h / 2 + 4) + '">' +
        esc(value) + "</tspan></text>");
    }
  }
  return parts.join("");
}

/* Dataflow stage column (used when a stage is a node rather than a group). */
function renderStage(node) {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const headerH = Math.min(28, h);
  const parts = [];
  parts.push('<rect class="node-box stage-col" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="6"/>');
  parts.push('<path class="stage-head" d="' + headerBand(x, y, w, headerH) + '"/>');
  parts.push('<line class="table-rule" x1="' + fixed(x) + '" y1="' + fixed(y + headerH) +
    '" x2="' + fixed(x + w) + '" y2="' + fixed(y + headerH) + '"/>');
  parts.push('<text class="node-kicker stage-title" text-anchor="middle">' +
    '<tspan x="' + fixed(x + w / 2) + '" y="' + fixed(y + headerH / 2 + 4) + '">' +
    esc(node.label.toUpperCase()) + "</tspan></text>");
  return parts.join("");
}

/* Lifecycle state card; role=start gets an entry dot + copper ring, role=end
   gets the terminal double ring. */
function renderState(node) {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  const rx = 8;
  const parts = [];
  const hitLeft = node.role === "start" ? x - 17 : x - 4;
  parts.push(hitRect(hitLeft, y - 4, x + w + 5 - hitLeft, h + 8));
  if (node.role === "start") {
    parts.push('<line class="state-entry-line" x1="' + fixed(x - 10) + '" y1="' + fixed(y + h / 2) +
      '" x2="' + fixed(x) + '" y2="' + fixed(y + h / 2) + '"/>');
    parts.push('<circle class="state-entry-dot" cx="' + fixed(x - 12) + '" cy="' + fixed(y + h / 2) + '" r="3.2"/>');
    parts.push('<rect class="state-ring state-ring-start" x="' + fixed(x - 3) + '" y="' + fixed(y - 3) +
      '" width="' + fixed(w + 6) + '" height="' + fixed(h + 6) + '" rx="' + (rx + 3) + '"/>');
  }
  parts.push('<rect class="node-box" x="' + fixed(x) + '" y="' + fixed(y) +
    '" width="' + fixed(w) + '" height="' + fixed(h) + '" rx="' + rx + '"/>');
  if (node.role === "end") {
    parts.push('<rect class="state-ring state-ring-end" x="' + fixed(x + 3) + '" y="' + fixed(y + 3) +
      '" width="' + fixed(w - 6) + '" height="' + fixed(h - 6) + '" rx="' + (rx - 1) + '"/>');
  }
  parts.push(renderLabelBlock(node, { center: true, showSub: !!node.sublabel }));
  return parts.join("");
}

const SHAPE_RENDERERS = {
  card: renderCard,
  box: renderBox,
  pill: renderPill,
  diamond: renderDiamond,
  note: renderNote,
  participant: renderParticipant,
  entity: renderEntity,
  class: renderClassBox,
  event: renderEvent,
  span: renderSpan,
  stage: renderStage,
  state: renderState
};

/* Diff annotation: an independent outline ring + a corner badge so the diff
   colour never fights the kind colour or the focus ring. `removed` keeps its
   layout slot (the node is still rendered, just muted and untouchable). */
function renderDiffRing(node) {
  const ringH = node.shape === "participant" ? participantCardHeight(node) : node.h;
  const rx = node.shape === "diamond" || node.shape === "box" ? 2 : 8;
  return '<rect class="diff-ring" x="' + fixed(node.x - 2) + '" y="' + fixed(node.y - 2) +
    '" width="' + fixed(node.w + 4) + '" height="' + fixed(ringH + 4) + '" rx="' + rx + '"/>';
}

function renderDiffBadge(status, cx, cy, radius) {
  const glyph = DIFF_BADGES[status];
  return '<g class="diff-badge" aria-hidden="true">' +
    '<circle class="badge-disc" cx="' + fixed(cx) + '" cy="' + fixed(cy) + '" r="' + fixed(radius) + '"/>' +
    '<text class="badge-glyph" x="' + fixed(cx) + '" y="' + fixed(cy + radius * 0.42) + '">' + glyph + "</text></g>";
}

/* Search terms + inspector detail for the v1.2 bodies, without widening the
   action-facing IR: this is presentation metadata, not schema. */
function nodeMeta(node) {
  const search = [];
  const tags = [];
  if (node.shape === "entity" && node.rows.length) {
    node.rows.forEach((row) => {
      if (row.label) search.push(row.label);
      if (row.right) search.push(row.right);
      if (row.mark) search.push(row.mark);
    });
    tags.push(plural(node.rows.length, ["attribute", "attributes"]));
  } else if (node.shape === "class" && node.members.length) {
    node.members.forEach((member) => search.push(member));
    tags.push(plural(node.members.length, ["member", "members"]));
  } else if (node.rows.length) {
    node.rows.forEach((row) => search.push(row.label));
    tags.push(plural(node.rows.length, ["row", "rows"]));
  }
  if (node.stereotype) search.push(node.stereotype);
  /* role + stereotype are separate inspector tags (data-role/data-stereotype),
     so they are searchable here but not repeated in the meta tag string. */
  if (node.at != null) {
    const at = formatAt(node.at);
    if (at) {
      search.push(at);
      tags.push(at);
    }
  }
  if (node.lane) search.push(node.lane);
  if (node.stage) {
    search.push(node.stage);
    tags.push(node.stage);
  }
  if (node.bar) {
    search.push(String(node.bar.start), String(node.bar.duration), node.valueLabel);
    tags.push(node.valueLabel || node.bar.duration + " ms");
  }
  return { search: search.join(" "), meta: tags.filter(Boolean).join(" · ") };
}

function renderNode(node, graph) {
  const outgoing = graph.out[node.id] || 0;
  const incoming = graph.inc[node.id] || 0;
  const meta = nodeMeta(node);
  let aria = node.label + ", " + node.kind + " node" +
    (node.sublabel ? ", " + node.sublabel : "") +
    (meta.meta ? ", " + meta.meta : "") + ". " +
    plural(outgoing, ["outgoing edge", "outgoing edges"]) + ", " +
    plural(incoming, ["incoming edge", "incoming edges"]) + ".";
  if (node.status) aria += " " + DIFF_WORDS[node.status] + ".";

  const render = SHAPE_RENDERERS[node.shape] || renderCard;
  const classes = ["node", "k-" + node.kind, "shape-" + node.shape];
  if (node.status) classes.push("st-" + node.status);
  if (node.role) classes.push("role-" + node.role);
  if (node.stereotype) classes.push("stereo-" + node.stereotype);
  const ring = node.status ? renderDiffRing(node) : "";
  const badge = node.status ? renderDiffBadge(node.status, node.x + node.w, node.y, 7) : "";
  const extras = (node.role ? ' data-role="' + esc(node.role) + '"' : "") +
    (node.stereotype ? ' data-stereotype="' + esc(node.stereotype) + '"' : "") +
    (meta.meta ? ' data-meta="' + esc(meta.meta) + '"' : "") +
    (meta.search ? ' data-search="' + esc(meta.search) + '"' : "");

  return '<g class="' + classes.join(" ") +
    '" data-node-id="' + esc(node.id) +
    '" data-label="' + esc(node.label) +
    '" data-kind="' + esc(node.kind) + '"' + extras +
    ' tabindex="0" role="button" aria-label="' + esc(aria) + '">' +
    render(node) + ring + badge + "</g>";
}

function renderLifelines(scene) {
  const lines = [];
  scene.nodes.forEach((node) => {
    if (node.shape !== "participant") return;
    const cardH = participantCardHeight(node);
    if (node.h <= cardH + 10) return;
    const cx = node.x + node.w / 2;
    lines.push('<line class="lifeline k-' + node.kind + '" data-node-id="' + esc(node.id) +
      '" x1="' + fixed(cx) + '" y1="' + fixed(node.y + cardH + 6) +
      '" x2="' + fixed(cx) + '" y2="' + fixed(node.y + node.h - 4) + '"/>');
  });
  return lines.join("");
}

/* ---- edge rendering --------------------------------------------------- */

function roundedPath(points, radius) {
  const pts = points.map((point) => ({ x: num(point.x), y: num(point.y) }));
  if (!pts.length) return "";
  if (pts.length === 1) return "M" + fixed(pts[0].x) + " " + fixed(pts[0].y);
  let d = "M" + fixed(pts[0].x) + " " + fixed(pts[0].y);
  for (let i = 1; i < pts.length; i += 1) {
    const point = pts[i];
    if (i < pts.length - 1) {
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const v1x = point.x - prev.x;
      const v1y = point.y - prev.y;
      const v2x = next.x - point.x;
      const v2y = next.y - point.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 0.01 || l2 < 0.01 || Math.abs(v1x * v2y - v1y * v2x) < 0.5) {
        d += " L" + fixed(point.x) + " " + fixed(point.y);
        continue;
      }
      const r = Math.min(radius, l1 / 2, l2 / 2);
      const ax = point.x - (v1x / l1) * r;
      const ay = point.y - (v1y / l1) * r;
      const bx = point.x + (v2x / l2) * r;
      const by = point.y + (v2y / l2) * r;
      d += " L" + fixed(ax) + " " + fixed(ay) +
        " Q" + fixed(point.x) + " " + fixed(point.y) + " " + fixed(bx) + " " + fixed(by);
    } else {
      d += " L" + fixed(point.x) + " " + fixed(point.y);
    }
  }
  return d;
}

function midpoint(points) {
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 0) {
      segments.push({ a, b, length });
      total += length;
    }
  }
  if (!total) return { x: points[0].x, y: points[0].y, horizontal: true };
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const t = remaining / segment.length;
      return {
        x: segment.a.x + (segment.b.x - segment.a.x) * t,
        y: segment.a.y + (segment.b.y - segment.a.y) * t,
        horizontal: Math.abs(segment.b.x - segment.a.x) >= Math.abs(segment.b.y - segment.a.y)
      };
    }
    remaining -= segment.length;
  }
  const last = segments[segments.length - 1];
  return { x: last.b.x, y: last.b.y, horizontal: true };
}

function markerId(kind, start) {
  return "ar-" + kind + (start ? "-s" : "");
}

function renderEdgeBadge(edge) {
  let cx;
  let cy;
  if (edge.labelBox) {
    cx = edge.labelBox.x + edge.labelBox.w + 11;
    cy = edge.labelBox.y + edge.labelBox.h / 2;
  } else {
    const mid = midpoint(edge.points);
    if (mid.horizontal) {
      cx = mid.x;
      cy = mid.y - 13;
    } else {
      cx = mid.x + 13;
      cy = mid.y;
    }
  }
  return renderDiffBadge(edge.status, cx, cy, 6);
}

function renderEdge(edge) {
  const kind = edge.kind;
  const forcedDash = edge.dashed && kind !== "return" && kind !== "async" && kind !== "data";
  const classes = ["edge", "k-" + kind];
  if (forcedDash) classes.push("forced-dash");
  if (edge.status) classes.push("st-" + edge.status);

  const d = roundedPath(edge.points, 8);
  let markerAttrs = "";
  if (CLASS_EDGE_KINDS.indexOf(kind) >= 0) {
    if (kind === "composition") {
      markerAttrs = ' marker-start="url(#' + markerId(kind, true) + ')"';
    } else if (kind !== "association") {
      markerAttrs = ' marker-end="url(#' + markerId(kind, false) + ')"';
    }
  } else {
    if (edge.arrow === "end" || edge.arrow === "both") {
      markerAttrs += ' marker-end="url(#' + markerId(kind, false) + ')"';
    }
    if (edge.arrow === "start" || edge.arrow === "both") {
      markerAttrs += ' marker-start="url(#' + markerId(kind, true) + ')"';
    }
  }

  let out = '<g class="' + classes.join(" ") + '" data-edge-id="' + esc(edge.id) +
    '" data-from="' + esc(edge.from) + '" data-to="' + esc(edge.to) +
    '" data-label="' + esc(edge.label) + '" data-kind="' + kind +
    (edge.card ? '" data-card="' + esc(edge.card) : "") +
    '" aria-hidden="true">' +
    '<path class="edge-line" d="' + d + '"' + markerAttrs + "/>";

  if (edge.card) out += renderCardinality(edge);

  if (edge.label) {
    let box = edge.labelBox;
    if (!box) {
      const mid = midpoint(edge.points);
      const width = Math.max(34, textWidth(edge.label, 11) + 14);
      const height = 18;
      const x = mid.horizontal ? mid.x - width / 2 : mid.x + 8;
      const y = mid.horizontal ? mid.y - height - 5 : mid.y - height / 2;
      box = { x, y, w: width, h: height };
    }
    // Full label, no trimming: the halo grows to the text, never the text to the halo.
    const haloW = Math.max(box.w, textWidth(edge.label, 11) + 12);
    const haloH = Math.max(box.h, 18);
    const cx = box.x + box.w / 2;
    const haloX = cx - haloW / 2;
    const haloY = box.y + box.h / 2 - haloH / 2;
    const base = haloY + haloH / 2 + 4;
    out += '<g class="edge-label-group">' +
      '<rect class="edge-halo" x="' + fixed(haloX) + '" y="' + fixed(haloY) +
      '" width="' + fixed(haloW) + '" height="' + fixed(haloH) + '" rx="2"/>' +
      '<text class="edge-label" text-anchor="middle"><tspan x="' + fixed(cx) + '" y="' + fixed(base) + '">' +
      esc(edge.label) + "</tspan></text></g>";
  }

  if (edge.status) out += renderEdgeBadge(edge);

  out += "</g>";
  return out;
}

const MARKER_OPEN = { cls: "arrow-open", d: "M8.4 1.4 1.6 5 8.4 8.6", box: "0 0 10 10", refX: 9, refY: 5, size: 9 };
const MARKER_FILLED = { cls: "arrow-fill", d: "M9 5 1.2 1.2 1.2 8.8Z", box: "0 0 10 10", refX: 9, refY: 5, size: 9 };

function markerSpec(kind) {
  if (kind === "extends" || kind === "implements") {
    const hollow = { cls: "arrow-hollow", d: "M11 6 L1 1.4 L1 10.6Z", box: "0 0 12 12", refX: 11, refY: 6, size: 11 };
    return { end: hollow, start: hollow };
  }
  if (kind === "composition") {
    // the diamond sits outside the whole class: forward orientation, tip on the
    // box border, body along the line (never hidden behind the node)
    return {
      end: null,
      start: {
        cls: "arrow-diamond", d: "M1 6 L6 1 L11 6 L6 11Z", box: "0 0 12 12",
        refX: 1, refY: 6, size: 11, orient: "auto"
      }
    };
  }
  if (kind === "association") return { end: null, start: null };
  if (kind === "dependency") return { end: MARKER_OPEN, start: null };
  if (kind === "return") return { end: MARKER_OPEN, start: MARKER_OPEN };
  return { end: MARKER_FILLED, start: MARKER_FILLED };
}

function markerDefs(kinds) {
  const defs = [];
  kinds.forEach((kind) => {
    const spec = markerSpec(kind);
    [["end", false], ["start", true]].forEach((pair) => {
      const item = spec[pair[0]];
      if (!item) return;
      const orient = item.orient || (pair[1] ? "auto-start-reverse" : "auto");
      defs.push('<marker id="' + markerId(kind, pair[1]) + '" class="k-' + kind +
        '" viewBox="' + item.box + '" refX="' + item.refX + '" refY="' + item.refY +
        '" markerWidth="' + item.size + '" markerHeight="' + item.size +
        '" markerUnits="userSpaceOnUse" orient="' + orient +
        '"><path class="' + item.cls + '" d="' + item.d + '"/></marker>');
    });
  });
  return defs.join("");
}

/* ERD cardinality pills sit inside the edge, one near each end. */
function cardinalityPill(value, cx, cy) {
  const text = String(value);
  const w = Math.max(18, textWidth(text, 11) + 12);
  const h = 15;
  return '<g class="card-pill"><rect class="card-pill-box" x="' + fixed(cx - w / 2) +
    '" y="' + fixed(cy - h / 2) + '" width="' + fixed(w) + '" height="' + h + '" rx="7.5"/>' +
    '<text class="card-pill-text" text-anchor="middle"><tspan x="' + fixed(cx) +
    '" y="' + fixed(cy + 4) + '">' + esc(text) + "</tspan></text></g>";
}

function renderCardinality(edge) {
  const parts = String(edge.card).split(":");
  const near = parts.length > 1 ? parts[1] : parts[0];
  const far = parts[0];
  const points = edge.points;
  if (points.length < 2) return "";
  const endpoint = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const offset = Math.min(20, len / 2);
    return { x: a.x + (dx / len) * offset, y: a.y + (dy / len) * offset };
  };
  const start = endpoint(points[0], points[1]);
  const end = endpoint(points[points.length - 1], points[points.length - 2]);
  let out = "";
  if (far) out += cardinalityPill(far, start.x, start.y);
  if (near) out += cardinalityPill(near, end.x, end.y);
  return out;
}

/* ---- group / legend / meta -------------------------------------------- */

function renderGroup(group, type) {
  const label = group.label ? group.label.toUpperCase() : "";
  if (type === "dataflow" && group.kind === "zone") {
    const headH = Math.min(26, group.h);
    return '<g class="group stage-col">' +
      '<rect class="group-box stage-band" x="' + fixed(group.x) + '" y="' + fixed(group.y) +
      '" width="' + fixed(group.w) + '" height="' + fixed(group.h) + '" rx="6"/>' +
      '<path class="stage-group-head" d="' + headerBand(group.x, group.y, group.w, headH) + '"/>' +
      '<line class="table-rule" x1="' + fixed(group.x) + '" y1="' + fixed(group.y + headH) +
      '" x2="' + fixed(group.x + group.w) + '" y2="' + fixed(group.y + headH) + '"/>' +
      '<text class="group-label stage-group-label" text-anchor="middle">' +
      '<tspan x="' + fixed(group.x + group.w / 2) + '" y="' + fixed(group.y + headH / 2 + 4) + '">' +
      esc(label) + "</tspan></text></g>";
  }
  if (group.kind === "fragment") {
    const tabWidth = Math.max(64, textWidth(label, 11) + label.length * 0.9 + 26);
    const tabHeight = 20;
    const tab = "M" + fixed(group.x + 6) + " " + fixed(group.y) +
      "H" + fixed(group.x + tabWidth - 6) +
      "Q" + fixed(group.x + tabWidth) + " " + fixed(group.y) +
      " " + fixed(group.x + tabWidth) + " " + fixed(group.y + 6) +
      "V" + fixed(group.y + tabHeight) +
      "H" + fixed(group.x) +
      "V" + fixed(group.y + 6) +
      "Q" + fixed(group.x) + " " + fixed(group.y) + " " + fixed(group.x + 6) + " " + fixed(group.y) + "Z";
    return '<g class="group fragment">' +
      '<rect class="group-box" x="' + fixed(group.x) + '" y="' + fixed(group.y) +
      '" width="' + fixed(group.w) + '" height="' + fixed(group.h) + '" rx="6"/>' +
      '<path class="frag-tab" d="' + tab + '"/>' +
      '<text class="frag-label"><tspan x="' + fixed(group.x + 10) + '" y="' + fixed(group.y + 14) + '">' +
      esc(label) + "</tspan></text></g>";
  }
  let out = '<g class="group ' + group.kind + '">' +
    '<rect class="group-box" x="' + fixed(group.x) + '" y="' + fixed(group.y) +
    '" width="' + fixed(group.w) + '" height="' + fixed(group.h) + '" rx="6"/>';
  if (label) {
    out += '<text class="group-label"><tspan x="' + fixed(group.x + 12) + '" y="' + fixed(group.y + 16) + '">' +
      esc(label) + "</tspan></text>";
  }
  return out + "</g>";
}

function legendArrow(item) {
  if (!item) return "";
  if (item.cls === "arrow-open") return '<path class="arrow-open" d="M22.6 1.6 27.8 5 22.6 8.4"/>';
  if (item.cls === "arrow-hollow") return '<path class="arrow-hollow" d="M28 5 L21.6 1.5 L21.6 8.5Z"/>';
  if (item.cls === "arrow-diamond") return '<path class="arrow-diamond" d="M2 5 L6 1.6 L10 5 L6 8.4Z"/>';
  return '<path class="arrow-fill" d="M28 5 21.6 1.4 21.6 8.6Z"/>';
}

function renderLegend(legend) {
  if (!legend.length) return "";
  const items = legend.map((entry) => {
    const spec = markerSpec(entry.kind);
    const startHead = spec.start && !spec.end ? legendArrow(spec.start) : "";
    const endHead = spec.end ? legendArrow(spec.end) : "";
    return '<button type="button" class="legend-item legend-btn" data-kind="' + esc(entry.kind) +
      '" aria-pressed="true" aria-label="' + esc(entry.label + " edges, click to hide") +
      '"><svg class="legend-sw k-' + entry.kind +
      '" viewBox="0 0 30 10" width="30" height="10" aria-hidden="true" focusable="false">' +
      '<line class="edge-line" x1="' + (startHead ? 11 : 1) + '" y1="5" x2="21" y2="5"/>' +
      startHead + endHead + "</svg>" +
      '<span class="legend-label">' + esc(entry.label) + "</span></button>";
  }).join("");
  return '<span class="legend-eyebrow">Legend</span>' +
    '<span class="legend-rule" aria-hidden="true"></span>' + items +
    '<button type="button" class="legend-reset" id="legend-reset" hidden title="Show every edge kind again">' +
    "reset filters</button>";
}

/* Diff legend: the three statuses as outline swatches with their badge glyph. */
function renderDiffLegend(diff) {
  if (!diff) return "";
  const items = DIFF_STATUSES.map((status) => (
    '<span class="legend-item diff-item"><span class="diff-swatch swatch-' + status +
    '" aria-hidden="true">' + DIFF_BADGES[status] + "</span>" +
    '<span class="legend-label">' + DIFF_WORDS[status].charAt(0).toUpperCase() +
    DIFF_WORDS[status].slice(1) + "</span></span>"
  )).join("");
  return '<span class="legend-eyebrow">Diff</span>' +
    '<span class="legend-rule" aria-hidden="true"></span>' + items;
}

function renderNotes(notes) {
  return notes.map((note) => '<p class="note">' + esc(note) + "</p>").join("");
}

function renderMeta(scene) {
  const item = (count, pair) => '<span class="meta-item"><span class="meta-n">' + count +
    "</span> " + esc(pair[count === 1 ? 0 : 1]) + "</span>";
  const parts = [item(scene.nodes.length, WORDS.node)];
  parts.push('<span class="meta-div" aria-hidden="true"></span>');
  parts.push(item(scene.edges.length, WORDS.edge));
  if (scene.groups.length) {
    parts.push('<span class="meta-div" aria-hidden="true"></span>');
    parts.push(item(scene.groups.length, WORDS.group));
  }
  return parts.join("");
}

/* Header diff chips: +n −n ~n plus the base→head scope, straight from scene.diff. */
function renderDiffSummary(diff) {
  if (!diff) return "";
  const chip = (status) => (
    '<span class="diff-chip chip-' + status + '" title="' + diff[status] + " " +
    DIFF_WORDS[status] + '">' + DIFF_BADGES[status] + diff[status] + "</span>"
  );
  const scope = diff.base || diff.head
    ? '<span class="diff-scope">' + esc((diff.base || "?") + " → " + (diff.head || "?")) + "</span>"
    : "";
  return '<div class="diff-summary diff-chips" role="group" aria-label="' + esc(
    diff.added + " added, " + diff.removed + " removed, " + diff.changed + " changed"
  ) + '"><span class="diff-eyebrow">Diff</span>' + scope +
    chip("added") + chip("removed") + chip("changed") + "</div>";
}

function canvasMeta(scene) {
  return fixed(scene.width) + " × " + fixed(scene.height) + " px · scene v1";
}

function sceneAria(scene) {
  return scene.title + ". " + scene.type + " diagram, " +
    plural(scene.nodes.length, WORDS.node) + ", " +
    plural(scene.edges.length, ["connection", "connections"]) +
    ". Tab steps through nodes; ? lists keys; / searches; 0 resets the view.";
}

/* Source IR for the page: use the caller's IR when the CLI passes one, else
   rebuild a faithful v1.1 IR from the scene (scene = IR + positions). The
   browser uses it for search, the inspector, route tracing, Copy JSON and
   Copy as Mermaid — no CLI round-trip, no network. */
function deriveIr(scene, normalized) {
  const node = (item) => {
    const out = { id: item.id, label: item.label };
    if (item.sublabel) out.sublabel = item.sublabel;
    out.kind = item.kind;
    if (item.group) out.group = item.group;
    if (item.status) out.status = item.status;
    if (item.shape === "entity" && item.rows.length) {
      out.attributes = item.rows.map((row) => {
        const attr = { name: row.label, type: row.right };
        if (row.mark) attr.key = row.mark;
        return attr;
      });
    } else if (item.shape === "class" && (item.members.length || item.rows.length)) {
      out.members = item.members.length ? item.members : item.rows.map((row) => row.label);
    }
    if (item.stereotype) out.stereotype = item.stereotype;
    if (item.at != null) out.at = item.at;
    if (item.lane) out.lane = item.lane;
    if (item.stage) out.stage = item.stage;
    if (item.bar) {
      out.start = item.bar.start;
      out.duration = item.bar.duration;
    }
    return out;
  };
  const edge = (item) => {
    const out = { from: item.from, to: item.to };
    if (item.label) out.label = item.label;
    out.kind = item.kind;
    if (item.card) out.cardinality = item.card;
    if (item.status) out.status = item.status;
    return out;
  };
  const raw = scene && typeof scene === "object" ? scene : {};
  const ir = { title: normalized.title };
  if (normalized.subtitle) ir.subtitle = normalized.subtitle;
  ir.type = normalized.type;
  if (raw.direction === "TB" || raw.direction === "LR") ir.direction = raw.direction;
  ir.nodes = normalized.nodes.map(node);
  ir.edges = normalized.edges.map(edge);
  if (normalized.groups.length) {
    ir.groups = normalized.groups.map((group) => ({
      id: group.id,
      label: group.label,
      kind: group.kind,
      nodes: normalized.nodes.filter((item) => item.group === group.id).map((item) => item.id)
    }));
  }
  if (normalized.walkthrough.length) {
    ir.walkthrough = normalized.walkthrough.map((step) => ({
      title: step.title, text: step.text, focus: step.focus
    }));
  }
  if (normalized.notes.length) ir.notes = normalized.notes;
  return ir;
}


function themeLabel(mode) {
  return "Theme: " + THEME_NAMES[mode] + ", switch to " + THEME_NAMES[NEXT_THEME[mode]];
}

/* ---- walkthrough bar -------------------------------------------------- */

function renderTourbar(scene) {
  const steps = scene.walkthrough;
  if (!steps.length) return "";
  const total = steps.length;
  const first = steps[0];
  const dots = steps.map((step, index) => {
    const current = index === 0;
    return '<button type="button" class="tour-dot' + (current ? " is-current" : "") +
      '" data-step="' + index + '" aria-label="Step ' + (index + 1) + ": " + esc(step.title) + '"' +
      (current ? ' aria-current="step"' : "") + "></button>";
  }).join("");
  return '<section class="tourbar" id="tourbar" aria-label="Walkthrough">' +
    '<div class="tour-nav">' +
      '<button type="button" class="tour-btn" id="tour-prev" aria-label="Previous step" title="Previous step" disabled>‹</button>' +
      '<span class="tour-count" id="tour-count">1 / ' + total + "</span>" +
      '<button type="button" class="tour-btn" id="tour-next" aria-label="Next step" title="Next step">›</button>' +
    "</div>" +
    '<div class="tour-copy">' +
      '<p class="tour-title" id="tour-title">' + esc(first.title) + "</p>" +
      '<p class="tour-text" id="tour-text">' + esc(first.text) + "</p>" +
    "</div>" +
    '<div class="tour-dots" id="tour-dots" role="group" aria-label="Walkthrough steps">' + dots + "</div>" +
    '<button type="button" class="tour-exit" id="tour-exit" aria-label="Start tour" title="Start tour">' +
      '<svg class="ico-play" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path class="tour-glyph-fill" d="M3.6 2.1 9.5 6 3.6 9.9Z"/></svg>' +
      '<svg class="ico-close" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path class="tour-glyph-line" d="M2.8 2.8l6.4 6.4M9.2 2.8 2.8 9.2"/></svg>' +
      '<span id="tour-exit-label">Start tour</span>' +
    "</button>" +
  "</section>";
}

/* ---- axis + lanes (timeline / waterfall / dataflow) ------------------- */

function renderLanes(lanes, scene) {
  return lanes.map((lane, index) => {
    const alt = index % 2 === 1;
    const parts = ['<g class="lane' + (alt ? " is-alt" : "") + '">'];
    parts.push('<rect class="lane-bg" x="0" y="' + fixed(lane.y) + '" width="' + fixed(scene.width) +
      '" height="' + fixed(lane.h) + '"/>');
    parts.push('<line class="lane-rule" x1="0" y1="' + fixed(lane.y) +
      '" x2="' + fixed(scene.width) + '" y2="' + fixed(lane.y) + '"/>');
    if (index === lanes.length - 1) {
      parts.push('<line class="lane-rule" x1="0" y1="' + fixed(lane.y + lane.h) +
        '" x2="' + fixed(scene.width) + '" y2="' + fixed(lane.y + lane.h) + '"/>');
    }
    if (lane.label) {
      parts.push('<text class="lane-label"><tspan x="16" y="' + fixed(lane.y + 16) + '">' +
        esc(lane.label.toUpperCase()) + "</tspan></text>");
    }
    parts.push("</g>");
    return parts.join("");
  }).join("");
}

function renderAxis(axis) {
  if (!axis) return "";
  const y = axis.y;
  const parts = ['<g class="axis axis-' + axis.kind + '">'];
  parts.push('<line class="axis-line" x1="' + fixed(axis.x0) + '" y1="' + fixed(y) +
    '" x2="' + fixed(axis.x1) + '" y2="' + fixed(y) + '"/>');
  axis.ticks.forEach((tick) => {
    parts.push('<line class="axis-tick" x1="' + fixed(tick.x) + '" y1="' + fixed(y - 4) +
      '" x2="' + fixed(tick.x) + '" y2="' + fixed(y + 4) + '"/>');
    if (tick.label) {
      parts.push('<text class="axis-label" text-anchor="middle"><tspan x="' + fixed(tick.x) +
        '" y="' + fixed(y + 17) + '">' + esc(tick.label) + "</tspan></text>");
    }
  });
  parts.push("</g>");
  return parts.join("");
}

/* ---- diagram ---------------------------------------------------------- */

function renderDiagram(scene) {
  const graph = buildGraph(scene);
  const markerKinds = EDGE_KINDS.filter((kind) => scene.edges.some((edge) => edge.kind === kind));
  // width/height carry the scene's natural pixel size; the viewer fits it to the
  // canvas in JS (never upscaling), so boxes are never stretched.
  return '<svg id="diagram" class="diagram" role="img" aria-label="' + esc(sceneAria(scene)) +
    '" width="' + fixed(scene.width) + '" height="' + fixed(scene.height) +
    '" data-scene-width="' + fixed(scene.width) + '" data-scene-height="' + fixed(scene.height) +
    '" data-slug="' + esc(scene.slug) + '" data-type="' + esc(scene.type) +
    '" viewBox="0 0 ' + fixed(scene.width) + " " + fixed(scene.height) + '" preserveAspectRatio="xMidYMid meet">' +
    "<defs>" + markerDefs(markerKinds) + "</defs>" +
    '<g class="lay-lanes" aria-hidden="true">' + renderLanes(scene.lanes, scene) + "</g>" +
    '<g class="lay-groups" aria-hidden="true">' + scene.groups.map((group) => renderGroup(group, scene.type)).join("") + "</g>" +
    '<g class="lay-lifelines" aria-hidden="true">' + renderLifelines(scene) + "</g>" +
    '<g class="lay-axis" aria-hidden="true">' + renderAxis(scene.axis) + "</g>" +
    '<g class="lay-edges" aria-hidden="true">' + scene.edges.map(renderEdge).join("") + "</g>" +
    '<g class="lay-nodes">' + scene.nodes.map((node) => renderNode(node, graph)).join("") + "</g>" +
    "</svg>";
}

/* ---- public API ------------------------------------------------------- */

/**
 * Compose a scene v1/v2 object into a complete, standalone HTML document.
 *
 * @param {{scene: object, options?: {mode?: "light"|"dark"|"auto"}}} input
 * @returns {string} complete HTML (inline CSS, SVG and JS; no network)
 */
export function compose(input) {
  const args = input || {};
  const scene = args.scene;
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    throw new TypeError("naqsha compose(): a scene object is required");
  }
  const requestedMode = args.options && args.options.mode;
  const mode = MODES.indexOf(requestedMode) >= 0 ? requestedMode : "auto";
  const normalized = normalizeScene(scene);

  const config = {
    tour: normalized.walkthrough,
    slug: normalized.slug,
    type: normalized.type,
    width: normalized.width,
    height: normalized.height
  };
  const ir = args.ir && typeof args.ir === "object" && !Array.isArray(args.ir)
    ? args.ir
    : deriveIr(scene, normalized);

  const replacements = {
    MODE: mode,
    TITLE: esc(normalized.title),
    SUBTITLE: normalized.subtitle ? '<p class="doc-sub">' + esc(normalized.subtitle) + "</p>" : "",
    TYPE: esc(normalized.type),
    THEME_LABEL: esc(themeLabel(mode)),
    META: renderMeta(normalized),
    DIFF_SUMMARY: renderDiffSummary(normalized.diff),
    CANVAS_META: esc(canvasMeta(normalized)),
    TOURBAR: renderTourbar(normalized),
    BODY: renderDiagram(normalized),
    LEGEND: renderLegend(normalized.legend) + renderDiffLegend(normalized.diff),
    NOTES: renderNotes(normalized.notes),
    FOOTER_HINT: normalized.walkthrough.length
      ? "? keys · / search · r route · f focus · t tour · 0 reset"
      : "? keys · / search · r route · f focus · 0 reset",
    IR_JSON: jsJson(ir),
    CONFIG: "<script>window.__NAQSHA = " + jsJson(config) + ";</script>",
    STYLE: STYLE_MIN,
    SCRIPT: SCRIPT_MIN
  };

  return TEMPLATE.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
  ));
}
