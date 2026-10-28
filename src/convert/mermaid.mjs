/**
 * Naqsha — Mermaid ingest (owner: convert).
 *
 * `convertMermaid(text, {type = "auto"})` parses the two dialects people
 * actually paste into an agent: `flowchart`/`graph` and `sequenceDiagram`, and
 * returns Naqsha IR v1 plus a line-numbered warnings/errors list.
 *
 * Promise: when `ok` is true the IR passes `src/validate/index.mjs` unmodified
 * (no `fix` pass needed). The parser is deliberately tolerant — unknown or
 * cosmetic Mermaid syntax becomes a warning, never an exception. Fatal errors
 * only happen when there is nothing diagram-shaped to convert.
 *
 * Zero dependencies, deterministic (same text -> byte-identical IR).
 *
 * Dialect coverage
 *   flowchart/graph : TD|TB|LR|RL|BT, rect/diamond/circle/stadium/subroutine/
 *                     cylinder(store)/hexagon/flag/rounded shapes, quoted
 *                     labels, edges -->, ---, -.->, ==> (pipe label or
 *                     `-- label -->`), chains A --> B --> C, fan-out
 *                     `A --> B & C`, `subgraph … end` -> boundary group.
 *   sequenceDiagram : participant/actor declarations or implicit order,
 *                     messages ->>, -->>, ->, -->, -x, --x, -), <--> , Note
 *                     over/right of/left of -> IR notes, loop/alt/opt/else/end
 *                     -> fragment group over the participants used.
 *
 * Deliberately unsupported (warning, never fatal): classDef/class/style/
 * linkStyle/click/callback, `direction` inside a subgraph, `%%{init}%%`
 * config, par/critical/break/rect blocks, activation shortcuts (ignored
 * silently), new `A@{shape:…}` node syntax. Line limit overflow (>40 nodes /
 * >80 edges) is truncated with a warning so the IR stays valid.
 */

const SUPPORTED_TYPES = ["architecture", "workflow", "sequence", "erd", "class"];
const NODE_MAX = 40;
const EDGE_MAX = 80;
const LABEL_MAX = 80; // validator hard limit for node/group labels
const GROUP_LABEL_MAX = 80;
const NOTE_MAX = 140;
const NOTES_MAX = 4;
const TITLE_MAX = 80;
const ID_MAX = 32;

const FLOW_UNSUPPORTED = new Set([
  "classdef",
  "class",
  "style",
  "linkstyle",
  "click",
  "callback",
  "acctitle",
  "accdescr",
  "acctitle:",
  "accdescr:",
  "default",
  "title",
  "direction",
]);

const SEQ_BLOCK_TYPES = new Set(["loop", "alt", "opt", "par", "critical", "break", "rect"]);

const SECURITY_LABEL = /(auth|jwt|verif|token|tls|oauth|sso|login|credential|secret|permission|rbac|acl)/i;
const DATA_LABEL = /(read|write|quer|store|fetch|select|insert|update|\bdb\b|database|cache|persist|load|save|index)/i;

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (text) => Array.from(text);
const textLength = (text) => chars(text).length;
const stripQuotes = (text) => {
  let value = String(text ?? "").trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  return value;
};

function decodeEntities(text) {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** Human label cleanup: strip quotes, <br>, other inline HTML, entities. */
function cleanLabel(raw) {
  let value = stripQuotes(raw);
  value = value.replace(/\\"/g, '"');
  value = value.replace(/<br\s*\/?>/gi, ", ");
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  value = decodeEntities(value);
  return value.replace(/\s+/g, " ").trim();
}

/** Normalize one id the same way `repair()` does (lowercase kebab). */
function normalizeId(raw) {
  let value = String(raw ?? "").trim().toLowerCase();
  value = value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!value) value = "node";
  if (/^[0-9]/.test(value)) value = `n-${value}`;
  if (textLength(value) > ID_MAX) value = value.slice(0, ID_MAX).replace(/-+$/g, "");
  if (!value) value = "node";
  return value;
}

/** Assign a unique normalized id, appending -2, -3 … when needed. */
function uniqueId(raw, used) {
  const base = normalizeId(raw);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, ID_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function truncateChars(text, max) {
  const list = chars(text);
  if (list.length <= max) return { text, truncated: false };
  return { text: `${list.slice(0, Math.max(1, max - 3)).join("")}...`, truncated: true };
}

/** `web-app` / `Web App` -> words separated by spaces, lowercased. */
function wordsOf(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Brief-mandated kind inference (shared shape with repair()). */
function inferKind(text) {
  const phrase = wordsOf(text);
  if (!phrase) return "service";
  const words = phrase.split(" ");
  const includes = (list) => list.some((item) => words.includes(item));
  if (includes(["db", "database", "datastore", "store", "cache", "redis", "postgres", "postgresql", "mysql", "mongo", "mongodb", "sql", "ledger", "warehouse", "bucket", "storage"])) return "datastore";
  if (includes(["user", "actor", "human", "person", "customer", "client", "browser", "admin", "operator", "visitor"])) return "actor";
  if (includes(["gateway", "auth", "jwt", "oauth", "token", "verify", "verification", "tls", "security", "waf", "iam", "firewall", "policy"])) return "security";
  if (includes(["queue", "broker", "kafka", "rabbit", "rabbitmq", "sqs", "pubsub", "bus", "stream", "topic", "nats"])) return "queue";
  if (includes(["worker", "job", "compute", "runner", "lambda", "container", "pod", "cron", "batch", "processor"])) return "compute";
  return "service";
}

/** Edge kind from the arrow spelling, then security/data label keywords. */
function classifyEdge(baseKind, label, { keywords }) {
  if (keywords && label) {
    if (baseKind !== "return" && SECURITY_LABEL.test(label)) return "security";
    if (baseKind !== "return" && DATA_LABEL.test(label)) return "data";
  }
  return baseKind;
}

/* ------------------------------------------------------------------------- */
/* Statement splitting (shared by both dialects)                             */
/* ------------------------------------------------------------------------- */

/**
 * Split Mermaid source into statements with 1-based line numbers.
 * `;` and newlines separate statements at bracket/quote depth 0. Whole-line
 * `%%` comments are dropped; `%%{…}%%` config blobs are reported as junk so
 * the caller can warn about them.
 */
function splitStatements(text) {
  const lines = text.split(/\r?\n/);
  const statements = [];
  const junk = [];
  let buffer = "";
  let bufferLine = 1;
  let depth = 0;
  let quote = false;
  let i = 0;

  const push = () => {
    const trimmed = buffer.trim();
    if (trimmed) statements.push({ text: trimmed, line: bufferLine });
    buffer = "";
    depth = 0;
    quote = false;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmedStart = line.trim();
    if (buffer.trim() === "" && /^%%/.test(trimmedStart)) {
      if (trimmedStart.startsWith("%%{")) junk.push({ text: trimmedStart, line: i + 1 });
      i += 1;
      continue;
    }
    if (buffer === "") bufferLine = i + 1;
    let start = 0;
    for (let pos = 0; pos < line.length; pos += 1) {
      const ch = line[pos];
      if (quote) {
        if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') {
        quote = true;
        continue;
      }
      if (ch === "[" || ch === "{" || ch === "(") depth += 1;
      else if (ch === "]" || ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) {
        buffer += line.slice(start, pos);
        push();
        start = pos + 1;
        bufferLine = i + 1;
      }
    }
    buffer += line.slice(start);
    if (depth === 0 && !quote) {
      push();
    } else {
      buffer += "\n";
    }
    i += 1;
  }
  push();
  return { statements, junk };
}

/** Pull YAML-ish front matter off the top: title/subtitle supported. */
function takeFrontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return { body: text, lineOffset: 0, meta: {}, ignored: [] };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { body: text, lineOffset: 0, meta: {}, ignored: [] };
  const meta = {};
  const ignored = [];
  for (let i = 1; i < end; i += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i].trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = stripQuotes(match[2]);
    if (key === "title" || key === "subtitle") meta[key] = value;
    else ignored.push(key);
  }
  const body = lines.slice(end + 1).join("\n");
  // Keep original 1-based line numbers: the first body line is `end + 2`.
  return { body, lineOffset: end + 1, meta, ignored };
}

/* ------------------------------------------------------------------------- */
/* Flowchart scanning                                                        */
/* ------------------------------------------------------------------------- */

const BARE_LINKS = ["<-->", "<==>", "-.->", "-.-", "-->", "---", "--x", "--o", "==>", "===", "--", "-.", "=="];
const LINK_START = new Set(["-", "=", "<"]);

function skipBalanced(text, start) {
  const open = text[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : ")";
  let depth = 0;
  let quote = false;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '"') quote = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = true;
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return text.length;
}

/** Match a link at `text[i]`; returns {token, inlineLabel?, length} or null. */
function findLinkAt(text, i) {
  if (!LINK_START.has(text[i])) return null;
  const rest = text.slice(i);
  if (rest.startsWith("<-->")) return { token: "<-->", length: 4, bidirectional: true };
  if (rest.startsWith("<==>")) return { token: "<==>", length: 4, bidirectional: true };
  let match = /^(--)\s+([\s\S]+?)\s+(-->|---|--x|--o)/.exec(rest);
  if (match) return { token: match[3], inlineLabel: match[2], length: match[0].length };
  match = /^(-\.)\s+([\s\S]+?)\s+(\.->|\.-)/.exec(rest);
  if (match) return { token: match[3], inlineLabel: match[2], length: match[0].length };
  match = /^(==)\s+([\s\S]+?)\s+(==>|===)/.exec(rest);
  if (match) return { token: match[3], inlineLabel: match[2], length: match[0].length };
  for (const token of BARE_LINKS) {
    if (!rest.startsWith(token)) continue;
    const pipe = /^\s*\|([^|]*)\|/.exec(rest.slice(token.length));
    if (pipe) return { token, inlineLabel: pipe[1], length: token.length + pipe[0].length };
    return { token, length: token.length };
  }
  return null;
}

/** Split `A --> B & C` into node-chunks and links, respecting label brackets. */
function tokenizeChain(text) {
  const tokens = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    const chunk = buffer.trim();
    if (chunk) tokens.push({ type: "node", text: chunk });
    buffer = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipQuote(text, i);
      buffer += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") {
      const end = skipBalanced(text, i);
      buffer += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "<" || ch === "-" || ch === "=") {
      const link = findLinkAt(text, i);
      if (link) {
        flush();
        tokens.push({ type: "link", ...link, offset: i });
        i += link.length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return tokens;
}

function skipQuote(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  return text.length;
}

/** Split `A & B` at depth 0. */
function splitNodeGroup(chunk) {
  const parts = [];
  let buffer = "";
  let depth = 0;
  let quote = false;
  for (const ch of chunk) {
    if (quote) {
      buffer += ch;
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      buffer += ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "&" && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/** Parse one node reference like `A`, `A[Label]`, `A{Decision}`, `A[(Store)]`. */
function parseNodeReference(chunk, line, warn) {
  let text = chunk.trim();
  if (!text) return null;
  const classIndex = text.indexOf(":::");
  if (classIndex > 0) {
    warn("convert/unsupported", `class attachment "${text.slice(classIndex)}" ignored (classes are not in IR v1)`, line);
    text = text.slice(0, classIndex).trim();
  }
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)([\s\S]*)$/.exec(text);
  if (!match) {
    warn("convert/unsupported", `could not parse node reference "${truncateForMessage(chunk)}"`, line);
    return null;
  }
  const rawId = match[1];
  let rest = match[2].trim();
  let shape = "rect";
  let label = null;
  const inner = (prefix, suffix) => rest.slice(prefix.length, rest.length - suffix.length);
  if (!rest) {
    shape = "rect";
  } else if (rest.startsWith("@{") && rest.endsWith("}")) {
    warn("convert/unsupported", `new node-shape syntax "${truncateForMessage(rest)}" not supported, label falls back to id`, line);
    label = null;
  } else if (rest.startsWith("(((") && rest.endsWith(")))")) {
    shape = "circle";
    label = inner("(((", ")))");
  } else if (rest.startsWith("((") && rest.endsWith("))")) {
    shape = "circle";
    label = inner("((", "))");
  } else if (rest.startsWith("([") && rest.endsWith("])")) {
    shape = "stadium";
    label = inner("([", "])");
  } else if (rest.startsWith("[[") && rest.endsWith("]]")) {
    shape = "subroutine";
    label = inner("[[", "]]");
  } else if (rest.startsWith("[(") && rest.endsWith(")]")) {
    shape = "store";
    label = inner("[(", ")]");
  } else if (rest.startsWith("{{") && rest.endsWith("}}")) {
    shape = "hexagon";
    label = inner("{{", "}}");
  } else if (rest.startsWith("[") && rest.endsWith("]")) {
    shape = "rect";
    label = inner("[", "]");
  } else if (rest.startsWith("{") && rest.endsWith("}")) {
    shape = "diamond";
    label = inner("{", "}");
  } else if (rest.startsWith(">") && rest.endsWith("]")) {
    shape = "flag";
    label = inner(">", "]");
  } else if (rest.startsWith("(") && rest.endsWith(")")) {
    shape = "rounded";
    label = inner("(", ")");
  } else {
    warn("convert/shape-unsupported", `unknown shape syntax "${truncateForMessage(rest)}" for node "${rawId}", treated as a plain box`, line);
  }
  return { rawId, shape, label: label === null ? null : cleanLabel(label), line };
}

function truncateForMessage(text) {
  const list = chars(String(text));
  return list.length > 48 ? `${list.slice(0, 45).join("")}...` : list.join("");
}

/** Mermaid shape -> IR node kind (store/diamond/pill shapes win over words). */
function kindForShape(shape, labelText) {
  if (shape === "diamond") return "state";
  if (shape === "store") return "datastore";
  if (shape === "circle" || shape === "stadium") return "state";
  if (shape === "hexagon" || shape === "flag") return "external";
  return inferKind(labelText);
}

/* ------------------------------------------------------------------------- */
/* Flowchart parser                                                          */
/* ------------------------------------------------------------------------- */

function parseFlowchart(statements, warnings) {
  const warn = (code, message, line) => warnings.push({ code, message, line });
  const nodes = [];
  const nodeByRawId = new Map();
  const usedIds = new Set();
  const edges = [];
  const frames = [];
  const allFrames = [];
  const frameMembership = new Map(); // node id -> frame
  let subgraphCount = 0;

  const registerNode = (ref) => {
    if (!ref) return null;
    const existing = nodeByRawId.get(ref.rawId);
    if (existing) {
      // A bare reference followed by a real declaration: upgrade the label.
      if (ref.label && existing.implicit && ref.label !== existing.label) {
        existing.label = ref.label;
        existing.kind = kindForShape(ref.shape, ref.label || ref.rawId);
        existing.implicit = false;
      } else if (ref.label && !existing.implicit && ref.label !== existing.label) {
        warn("convert/node-redefined", `node "${ref.rawId}" redefined with label "${truncateForMessage(ref.label)}"; keeping the first label`, ref.line);
      }
      return existing;
    }
    const id = uniqueId(ref.rawId, usedIds);
    const rawLabel = ref.label && ref.label.trim() ? ref.label : ref.rawId;
    const limited = truncateChars(rawLabel, LABEL_MAX);
    if (limited.truncated) warn("convert/label-truncated", `node label for "${ref.rawId}" was longer than ${LABEL_MAX} characters and was shortened`, ref.line);
    const kind = kindForShape(ref.shape, ref.label || ref.rawId);
    const node = { id, rawId: ref.rawId, label: limited.text, kind, line: ref.line, implicit: !ref.label, group: null };
    nodes.push(node);
    nodeByRawId.set(ref.rawId, node);
    if (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frameMembership.has(node.id)) {
        frameMembership.set(node.id, frame);
        frame.members.push(node.id);
      }
    }
    return node;
  };

  const addEdge = (from, to, link, line) => {
    if (!from || !to) return;
    if (from.id === to.id) {
      warn("convert/self-edge", `self-edge on "${from.rawId}" dropped (IR v1 has no self-edges)`, line);
      return;
    }
    const label = link.inlineLabel ? cleanLabel(link.inlineLabel) : "";
    if (link.token.endsWith("o")) warn("convert/unsupported", `circle-endpoint link "${link.token}" drawn as a normal arrow`, line);
    const baseKind = kindForLinkToken(link.token);
    const kind = classifyEdge(baseKind, label, { keywords: true });
    if (link.bidirectional) warn("convert/bidirectional", `bidirectional link on line ${line} kept as one direction (${from.rawId} → ${to.rawId})`, line);
    edges.push({ from: from.id, to: to.id, label, kind, line });
  };

  for (const statement of statements) {
    const text = statement.text.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const firstWord = lower.split(/[\s;]/)[0];

    if (/^subgraph\b/i.test(text)) {
      const header = parseSubgraphHeader(text.slice("subgraph".length), statement.line, warn);
      subgraphCount += 1;
      if (frames.length > 0) {
        warn("convert/nested-subgraph", "nested subgraph flattened into its parent group (IR v1 groups cannot nest)", statement.line);
      }
      const frame = { id: header.id, label: header.label, line: statement.line, members: [], nested: frames.length > 0 };
      frames.push(frame);
      allFrames.push(frame);
      continue;
    }
    if (lower === "end" || lower === "end;") {
      if (frames.length === 0) {
        warn("convert/unexpected-end", '"end" without an open subgraph ignored', statement.line);
      } else {
        frames.pop();
      }
      continue;
    }
    if (/^direction\b/i.test(text)) {
      warn("convert/group-direction", '`direction` is only allowed on the diagram header; ignored here', statement.line);
      continue;
    }
    if (FLOW_UNSUPPORTED.has(firstWord)) {
      warn("convert/unsupported", `directive "${firstWord}" is not representable in IR v1; ignored`, statement.line);
      continue;
    }
    if (firstWord === "flowchart" || firstWord === "graph") {
      warn("convert/unsupported", "a second diagram header was ignored", statement.line);
      continue;
    }

    const tokens = tokenizeChain(text);
    if (tokens.every((token) => token.type === "node")) {
      for (const token of tokens) {
        for (const chunk of splitNodeGroup(token.text)) {
          registerNode(parseNodeReference(chunk, statement.line, warn));
        }
      }
      continue;
    }

    let previous = null;
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.type === "node") {
        previous = splitNodeGroup(token.text)
          .map((chunk) => registerNode(parseNodeReference(chunk, statement.line, warn)))
          .filter(Boolean);
        index += 1;
        continue;
      }
      const next = tokens[index + 1];
      if (!previous || previous.length === 0) {
        warn("convert/unsupported", `link without a source node ignored on line ${statement.line}`, statement.line);
        index += 1;
        continue;
      }
      if (!next || next.type !== "node") {
        warn("convert/unsupported", `link without a target node ignored on line ${statement.line}`, statement.line);
        index += 1;
        continue;
      }
      const targets = splitNodeGroup(next.text)
        .map((chunk) => registerNode(parseNodeReference(chunk, statement.line, warn)))
        .filter(Boolean);
      for (const from of previous) for (const to of targets) addEdge(from, to, token, statement.line);
      previous = targets;
      index += 2;
    }
  }
  if (frames.length > 0) warn("convert/unexpected-end", `${frames.length} subgraph block(s) were not closed; closed at end of input`, statements.length > 0 ? statements[statements.length - 1].line : 1);

  return { nodes, edges, frames: allFrames, subgraphCount };
}

function parseSubgraphHeader(rest, line, warn) {
  let text = rest.trim();
  if (!text) {
    warn("convert/empty-subgraph", `subgraph without a name on line ${line}; group will be skipped`, line);
    return { id: "group", label: "Group" };
  }
  let id = "";
  let label = "";
  const bracketed = /^([^\s\[]+)\s*\[\s*([\s\S]*?)\s*\]$/.exec(text);
  if (bracketed) {
    id = bracketed[1];
    label = cleanLabel(bracketed[2]);
  } else {
    text = stripQuotes(text);
    id = text.split(/\s+/)[0];
    label = text;
  }
  if (!label) label = id;
  return { id, label };
}

function kindForLinkToken(token) {
  if (token.includes("x")) return "return";
  if (token === "-.->" || token === "-.-" || token === "-.") return "async";
  if (token === "---" || token === "--") return "message";
  return "main";
}

/* ------------------------------------------------------------------------- */
/* Sequence parser                                                           */
/* ------------------------------------------------------------------------- */

// Participants may contain single dashes (`user-svc`, `db-2`) but a dash that
// starts the arrow (`A-->>B`) belongs to the arrow, not the id.
const SEQ_ID = "[A-Za-z0-9_][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*";
const SEQ_MESSAGE = new RegExp(`^(${SEQ_ID})\\s*(-->>|->>|-->|->|--x|-x|--\\)|-\\))\\s*([+-]?)\\s*(${SEQ_ID})\\s*([+-]?)\\s*(?::\\s*([\\s\\S]*))?$`);
const SEQ_PARTICIPANT = new RegExp(`^(participant|actor)\\s+(${SEQ_ID})(?:\\s+as\\s+([\\s\\S]+))?$`, "i");
const SEQ_NOTE = /^note\s+(over|right of|left of)\s+([^:]+):\s*([\s\S]+)$/i;
const SEQ_TITLE = /^title\s+([\s\S]+)$/i;

function kindForSequenceArrow(token) {
  if (token.endsWith("x")) return "return";
  if (token === "->>") return "main";
  if (token === "-->>") return "return";
  if (token === "->" || token === "-->") return "message";
  return "async";
}

function parseSequence(statements, warnings, metaTitle) {
  const warn = (code, message, line) => warnings.push({ code, message, line });
  const participants = [];
  const byRef = new Map(); // lowercased raw ref -> participant
  const usedIds = new Set();
  const edges = [];
  const notes = [];
  const frames = [];
  const grouped = new Set(); // node ids already claimed by a fragment group
  const groups = [];
  let title = metaTitle || "";
  let blockCount = 0;

  const registerParticipant = (rawRef, { label = null, kind = null, line } = {}) => {
    const key = String(rawRef).toLowerCase();
    const existing = byRef.get(key);
    if (existing) {
      if (label && !existing.explicitLabel) {
        existing.label = label;
        existing.explicitLabel = true;
        if (kind) existing.kind = kind;
      }
      return existing;
    }
    const id = uniqueId(rawRef, usedIds);
    const rawLabel = label && label.trim() ? label : String(rawRef);
    const limited = truncateChars(rawLabel, LABEL_MAX);
    if (limited.truncated) warn("convert/label-truncated", `participant label for "${rawRef}" was longer than ${LABEL_MAX} characters and was shortened`, line);
    const record = {
      id,
      label: limited.text,
      kind: kind || inferKind(label || rawRef),
      explicitLabel: Boolean(label),
      line,
    };
    participants.push(record);
    byRef.set(key, record);
    return record;
  };

  const addNote = (text, line) => {
    const cleaned = cleanLabel(text);
    if (!cleaned) return;
    if (notes.length >= NOTES_MAX) {
      warn("convert/note-dropped", `more than ${NOTES_MAX} notes; extra note on line ${line} dropped`, line);
      return;
    }
    const limited = truncateChars(cleaned, NOTE_MAX);
    if (limited.truncated) warn("convert/note-truncated", `note on line ${line} was longer than ${NOTE_MAX} characters and was shortened`, line);
    notes.push(limited.text);
  };

  const openFrame = (type, label, line) => {
    const frame = { type, label, line, members: [], nested: frames.length > 0 };
    if (frame.nested) warn("convert/nested-fragment", `nested ${type} block flattened into its parent fragment (IR v1 fragments cannot nest)`, line);
    frames.push(frame);
  };

  const closeFrame = (line) => {
    if (frames.length === 0) {
      warn("convert/unexpected-end", '"end" without an open block ignored', line);
      return;
    }
    const frame = frames.pop();
    blockCount += 1;
    if (frame.nested) return; // members were already added to the parent
    const members = frame.members.filter((id) => !grouped.has(id));
    const shared = frame.members.length - members.length;
    if (members.length === 0) {
      if (frame.members.length > 0) {
        warn("convert/fragment-overlap", `${frame.type} fragment on line ${frame.line} shares all participants with an earlier fragment; group omitted`, frame.line);
      } else {
        warn("convert/empty-fragment", `${frame.type} fragment on line ${frame.line} has no messages; group omitted`, frame.line);
      }
      return;
    }
    for (const id of members) grouped.add(id);
    const baseLabel = frame.label ? `${frame.type}: ${frame.label}` : frame.type;
    const limited = truncateChars(baseLabel, GROUP_LABEL_MAX);
    if (limited.truncated) warn("convert/label-truncated", `fragment label on line ${frame.line} was shortened`, frame.line);
    const id = uniqueId(`${frame.type}-${groups.length + 1}`, new Set());
    groups.push({ id, label: limited.text, kind: "fragment", nodes: members });
    if (shared > 0) {
      warn("convert/fragment-overlap", `${shared} participant(s) already belonged to an earlier fragment; assigned to the first fragment`, frame.line);
    }
  };

  for (const statement of statements) {
    const text = statement.text.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/);
    const head = words[0];

    const participantMatch = SEQ_PARTICIPANT.exec(text);
    if (participantMatch) {
      const role = participantMatch[1].toLowerCase();
      const rawRef = participantMatch[2];
      const label = participantMatch[3] ? cleanLabel(participantMatch[3]) : null;
      registerParticipant(rawRef, { label, kind: role === "actor" ? "actor" : inferKind(label || rawRef), line: statement.line });
      continue;
    }

    const noteMatch = SEQ_NOTE.exec(text);
    if (noteMatch) {
      addNote(noteMatch[3], statement.line);
      continue;
    }

    const titleMatch = SEQ_TITLE.exec(text);
    if (titleMatch && !metaTitle) {
      title = cleanLabel(titleMatch[1]);
      continue;
    }

    if (/^autonumber\b/i.test(text)) {
      warn("convert/unsupported", "autonumber is cosmetic and has no IR equivalent; ignored", statement.line);
      continue;
    }
    if (/^(activate|deactivate)\b/i.test(text)) continue; // cosmetic; silent
    if (/^(par|and|critical|option|break|rect)\b/i.test(text)) {
      warn("convert/unsupported", `${head} block is not supported; converted to a plain ${head === "par" ? "parallel" : head} fragment`, statement.line);
      if (head === "rect") continue;
      if (head === "and" || head === "option") continue;
      openFrame(head === "par" ? "loop" : "opt", text.slice(head.length).trim(), statement.line);
      continue;
    }

    if (head === "else") {
      if (frames.length === 0) {
        warn("convert/unexpected-end", '"else" without an open alt block ignored', statement.line);
        continue;
      }
      const frame = frames[frames.length - 1];
      const branch = text.slice("else".length).trim();
      if (branch) frame.label = frame.label ? `${frame.label} / ${branch}` : branch;
      continue;
    }
    if (head === "end") {
      closeFrame(statement.line);
      continue;
    }
    if (SEQ_BLOCK_TYPES.has(head)) {
      openFrame(head, text.slice(head.length).trim(), statement.line);
      continue;
    }
    if (head === "note") {
      warn("convert/unsupported", "unsupported note form; ignored", statement.line);
      continue;
    }
    if (/^%%/.test(lower)) continue;

    const messageMatch = SEQ_MESSAGE.exec(text);
    if (messageMatch) {
      const fromRef = messageMatch[1];
      const arrow = messageMatch[2];
      const toRef = messageMatch[4];
      const label = messageMatch[6] ? cleanLabel(messageMatch[6]) : "";
      let from = byRef.get(fromRef.toLowerCase());
      let to = byRef.get(toRef.toLowerCase());
      if (!from) from = registerParticipant(fromRef, { line: statement.line });
      if (!to) to = registerParticipant(toRef, { line: statement.line });
      if (from.id === to.id) {
        warn("convert/self-edge", `self-message on "${fromRef}" dropped (IR v1 has no self-edges)`, statement.line);
        continue;
      }
      const baseKind = kindForSequenceArrow(arrow);
      const kind = classifyEdge(baseKind, label, { keywords: true });
      edges.push({ from: from.id, to: to.id, label, kind, line: statement.line });
      for (const frame of frames) if (!frame.members.includes(from.id)) frame.members.push(from.id);
      for (const frame of frames) if (!frame.members.includes(to.id)) frame.members.push(to.id);
      continue;
    }

    warn("convert/unsupported", `unrecognized sequence statement "${truncateForMessage(text)}" ignored`, statement.line);
  }

  if (frames.length > 0) {
    warn("convert/unexpected-end", `${frames.length} block(s) were not closed; closed at end of input`, statements.length > 0 ? statements[statements.length - 1].line : 1);
    while (frames.length > 0) closeFrame(statements.length > 0 ? statements[statements.length - 1].line : 1);
  }

  return { participants, edges, groups, notes, title };
}

/* ------------------------------------------------------------------------- */
/* ER diagram (erDiagram)                                                    */
/* ------------------------------------------------------------------------- */

const ER_ENTITY_HEADER = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*(?:\[\s*"([\s\S]*?)"\s*\])?\s*$/;
const ER_ATTRIBUTE = /^([A-Za-z_][A-Za-z0-9_-]*(?:\([^)]*\))?(?:\[\])*)\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?(?=$|[\s,;])/i;
const ER_RELATION = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*))\s+([|o{}]{2})(?:--|\.\.)([|o{}]{2})\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*))\s*(?::\s*([\s\S]*))?$/;

/**
 * Line-level splitter for the v1.2 dialects. Cardinality tokens (`o{`, `}|`)
 * contain braces, so the generic statement splitter cannot be reused here.
 * Entity/class bodies are collected as one statement with `inner` lines (each
 * carrying its own line number for warnings); every other non-blank line is a
 * one-line statement. The diagram header line is skipped.
 */
const isErBlockHeader = (text) => /^(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\[\s*"[^"]*"\s*\])?\s*\{/.test(text);
const isClassBlockHeader = (text) => /^class\s+/i.test(text) && text.indexOf("{") >= 0;

function splitBodyStatements(body, isBlockHeader) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let started = false;
  let block = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const text = raw.trim();
    if (block) {
      if (/^}\s*(?:;|%%.*)?\s*$/.test(text)) {
        block.unclosed = false;
        out.push(block);
        block = null;
        continue;
      }
      block.inner.push({ text: raw, line });
      continue;
    }
    if (!text) continue;
    if (/^%%/.test(text)) continue;
    if (!started) {
      started = true;
      continue;
    }
    const openAt = text.indexOf("{");
    if (isBlockHeader(text) && openAt >= 0) {
      const closeAt = text.lastIndexOf("}");
      if (closeAt > openAt) {
        out.push({ text: text.slice(0, openAt).trim(), line, inner: [{ text: text.slice(openAt + 1, closeAt), line }], unclosed: false });
      } else {
        block = { text: text.slice(0, openAt).trim(), line, inner: [], unclosed: true };
      }
      continue;
    }
    out.push({ text: text.replace(/;\s*$/, "").trim(), line, inner: null, unclosed: false });
  }
  if (block) out.push(block);
  return out;
}


/** `direction LR` / `direction TB` inside a v1.2 diagram body. */
function parseDiagramDirection(word, line, warnings) {
  const value = String(word || "").trim().toUpperCase();
  if (value === "TB" || value === "TD") return "TB";
  if (value === "LR") return "LR";
  if (value === "BT") {
    warnings.push({ code: "convert/direction-mapped", message: '"BT" mapped to "TB" (IR only has TB/LR)', line });
    return "TB";
  }
  if (value === "RL") {
    warnings.push({ code: "convert/direction-mapped", message: '"RL" mapped to "LR" (IR only has TB/LR)', line });
    return "LR";
  }
  warnings.push({ code: "convert/unknown-direction", message: `unknown direction "${truncateForMessage(value)}"; defaulting to "TB"`, line });
  return "TB";
}

/** `ENTITY`, `"Entity Name"` or `ENTITY["Entity label"]`. */
function parseErEntityRef(text, line, warnings) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const match = ER_ENTITY_HEADER.exec(raw);
  if (!match) {
    warnings.push({ code: "convert/unsupported", message: `could not parse ER entity name "${truncateForMessage(raw)}"`, line });
    const token = raw.split(/\s+/)[0];
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(token)) return null;
    return { rawId: token, label: token, alias: false };
  }
  const quoted = match[1];
  const plain = match[2];
  const rawId = quoted || plain;
  const label = match[3] !== undefined ? cleanLabel(match[3]) : cleanLabel(rawId);
  return { rawId, label: label || rawId, alias: match[3] !== undefined };
}

function erRefFromToken(token) {
  const raw = String(token || "").trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  return { rawId: raw, label: raw, alias: false };
}

function makeErAttribute(match, line, warnings) {
  const type = match[1];
  const name = match[2];
  const keys = match[3] ? match[3].split(",").map((key) => key.trim().toUpperCase()) : [];
  const key = keys.includes("PK") ? "pk" : keys.includes("FK") ? "fk" : keys.includes("UK") ? "unique" : null;
  const attr = { name, type };
  if (key) attr.key = key;
  const comment = (match[4] || "").trim();
  if (comment) {
    const ref = /^([A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*)$/.exec(comment);
    if (ref) attr.refRaw = ref[1];
    else warnings.push({ code: "convert/erd-comment", message: `attribute comment "${truncateForMessage(comment)}" is not an "entity.column" reference; dropped`, line });
  }
  return attr;
}

/** Scan the inside of an entity block; tolerates several attributes per line. */
function scanErAttributes(innerLines, warnings) {
  const attributes = [];
  for (const entry of innerLines) {
    let text = entry.text;
    const commentAt = text.indexOf("%%");
    if (commentAt >= 0) text = text.slice(0, commentAt);
    text = text.trim().replace(/;$/, "").trim();
    let rest = text;
    let guard = 0;
    while (rest && guard < 24) {
      guard += 1;
      const match = ER_ATTRIBUTE.exec(rest);
      if (!match) break;
      attributes.push(makeErAttribute(match, entry.line, warnings));
      rest = rest.slice(match[0].length).trim().replace(/^[;, ]\s*/, "");
    }
    if (!rest) continue;
    if (/^[}\s]*$/.test(rest)) continue;
    const single = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(rest);
    if (single) {
      attributes.push({ name: single[1], type: "text" });
      warnings.push({ code: "convert/erd-attribute", message: `attribute "${single[1]}" has no type; used "text"`, line: entry.line });
      continue;
    }
    warnings.push({ code: "convert/unsupported", message: `unrecognized ER attribute text "${truncateForMessage(rest)}"`, line: entry.line });
  }
  return attributes;
}

function parseErDiagram(statements, warnings) {
  const entities = [];
  const byKey = new Map();
  const usedIds = new Set();
  const edges = [];
  let direction = null;

  const registerEntity = (ref, line, declared) => {
    if (!ref) return null;
    const key = normalizeId(ref.rawId);
    let entity = byKey.get(key);
    if (!entity) {
      entity = {
        id: uniqueId(key, usedIds),
        key,
        label: ref.label || ref.rawId,
        labelExplicit: Boolean(ref.alias),
        attributes: [],
        declared: false,
        line,
      };
      entities.push(entity);
      byKey.set(key, entity);
    } else if (ref.label && ref.label !== entity.label) {
      if (ref.alias && !entity.labelExplicit) {
        entity.label = ref.label;
        entity.labelExplicit = true;
      } else if (ref.alias) {
        warnings.push({ code: "convert/node-redefined", message: `ER entity "${ref.rawId}" redeclared as "${truncateForMessage(ref.label)}"; keeping the first label`, line });
      }
    }
    if (declared) {
      if (entity.declared) warnings.push({ code: "convert/unsupported", message: `ER entity "${ref.rawId}" is declared more than once; attributes are merged`, line });
      entity.declared = true;
    }
    return entity;
  };

  const addAttributes = (entity, attributes, line) => {
    for (const attr of attributes) {
      if (entity.attributes.length >= 12) {
        warnings.push({ code: "convert/erd-attributes", message: `entity "${entity.label}" has more than 12 attributes; extra column "${attr.name}" dropped`, line });
        continue;
      }
      entity.attributes.push(attr);
    }
  };

  for (const statement of statements) {
    const line = statement.line;
    if (statement.unclosed) {
      warnings.push({ code: "convert/unsupported", message: "an ER entity block was not closed; attributes were still read", line });
    }
    if (statement.inner) {
      const ref = parseErEntityRef(statement.text, line, warnings);
      if (!ref) continue;
      const entity = registerEntity(ref, line, true);
      addAttributes(entity, scanErAttributes(statement.inner, warnings), line);
      continue;
    }

    const text = statement.text.trim();
    if (!text) continue;
    if (/^direction\b/i.test(text)) {
      direction = parseDiagramDirection(text.split(/\s+/)[1], line, warnings);
      continue;
    }
    if (/^%%/.test(text)) continue;

    const relation = ER_RELATION.exec(text);
    if (relation) {
      const left = erRefFromToken(relation[1] || relation[2]);
      const right = erRefFromToken(relation[5] || relation[6]);
      const leftMany = /[{}]/.test(relation[3]);
      const rightMany = /[{}]/.test(relation[4]);
      const label = cleanLabel(relation[7] || "");
      const leftEntity = registerEntity(left, line, false);
      const rightEntity = registerEntity(right, line, false);
      if (!leftEntity || !rightEntity) continue;
      let from = leftEntity;
      let to = rightEntity;
      let cardinality;
      if (leftMany && rightMany) cardinality = "n:m";
      else if (!leftMany && rightMany) cardinality = "1:n";
      else if (leftMany && !rightMany) {
        cardinality = "1:n";
        from = rightEntity;
        to = leftEntity;
        warnings.push({ code: "convert/erd-direction", message: `relationship "${leftEntity.label}" - "${rightEntity.label}" reads many-to-one; emitted as 1:n from the "one" side`, line });
      } else cardinality = "1:1";
      if (from.id === to.id) {
        warnings.push({ code: "convert/self-edge", message: `self-relationship on "${from.label}" dropped (IR has no self-edges)`, line });
        continue;
      }
      edges.push({ from: from.id, to: to.id, label, cardinality, line });
      continue;
    }

    const simple = parseErEntityRef(text, line, warnings);
    if (simple && /^(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_-]*)(?:\s*\[\s*"[^"]*"\s*\])?$/.test(text)) {
      registerEntity(simple, line, true);
      continue;
    }
    if (/^(title|acctitle|accdescr|classdef|style|linkstyle|click|callback|subgraph|end)\b/i.test(text)) {
      warnings.push({ code: "convert/unsupported", message: `"${text.split(/\s+/)[0]}" is not representable in ER IR; ignored`, line });
      continue;
    }
    warnings.push({ code: "convert/unsupported", message: `unrecognized erDiagram statement "${truncateForMessage(text)}" ignored`, line });
  }
  return { entities, edges, direction };
}

function leftType(entity) {
  return entity ? entity.label : "?";
}

function finalizeErd(parsed, warnings) {
  const nodes = parsed.entities.map((entity) => {
    const attributes = entity.attributes.slice(0, 12).map((attr) => {
      const entry = { name: attr.name, type: attr.type };
      if (attr.key) entry.key = attr.key;
      return entry;
    });
    if (attributes.length === 0) {
      attributes.push({ name: "id", type: "uuid" });
      warnings.push({
        code: "convert/erd-entity",
        message: `ER entity "${entity.label}" has no attribute block; added a placeholder "id uuid" so the IR stays valid`,
        line: entity.line,
      });
    }
    return { id: entity.id, label: truncateChars(entity.label, LABEL_MAX).text, attributes };
  });

  // Resolve "entity.column" references now that every attribute is known.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byLabel = new Map();
  for (const entity of parsed.entities) {
    const label = normalizeId(entity.label);
    if (label && !byLabel.has(label)) byLabel.set(label, entity.id);
  }
  parsed.entities.forEach((entity, nodeIndex) => {
    entity.attributes.slice(0, 12).forEach((attr, attrIndex) => {
      if (!attr.refRaw) return;
      const [rawEntity, column] = attr.refRaw.split(".");
      const targetId = byId.has(normalizeId(rawEntity)) ? normalizeId(rawEntity) : byLabel.get(normalizeId(rawEntity));
      const target = targetId ? byId.get(targetId) : null;
      if (!target || !target.attributes.some((row) => row.name === column)) {
        warnings.push({ code: "convert/erd-ref", message: `reference "${attr.refRaw}" does not resolve to a declared entity column; dropped`, line: entity.line });
        return;
      }
      nodes[nodeIndex].attributes[attrIndex].ref = `${target.id}.${column}`;
    });
  });

  const edges = dedupeEdges(parsed.edges, warnings).map((edge) => {
    const entry = { from: edge.from, to: edge.to };
    if (edge.label) entry.label = edge.label;
    entry.cardinality = edge.cardinality;
    return entry;
  });
  const ir = { title: "", type: "erd", nodes, edges };
  if (parsed.direction) ir.direction = parsed.direction;
  clampNodes(ir, warnings);
  clampEdges(ir, warnings);
  return ir;
}

/* ------------------------------------------------------------------------- */
/* Class diagram (classDiagram)                                              */
/* ------------------------------------------------------------------------- */

const CLASS_RELATION = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:"([^"]*)"\s*)?(<\|--|<\|\.\.|--\|>|\.\.\|>|\*--|--\*|o--|--o|-->|<--|\.\.>|<\.\.|--|\.\.)\s*(?:"([^"]*)"\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*(?::\s*([\s\S]*))?$/;
const CLASS_RELATION_SPECS = {
  "<|--": { kind: "extends", reverse: true },
  "<|..": { kind: "implements", reverse: true },
  "--|>": { kind: "extends", reverse: false },
  "..|>": { kind: "implements", reverse: false },
  "*--": { kind: "composition", reverse: false },
  "--*": { kind: "composition", reverse: true },
  "o--": { kind: "association", reverse: false, aggregation: true },
  "--o": { kind: "association", reverse: true, aggregation: true },
  "-->": { kind: "association", reverse: false },
  "<--": { kind: "association", reverse: true },
  "..>": { kind: "dependency", reverse: false },
  "<..": { kind: "dependency", reverse: true },
  "--": { kind: "association", reverse: false },
  "..": { kind: "dependency", reverse: false },
};

function parseClassReference(text, line, warnings) {
  let raw = String(text || "").trim();
  if (!raw) return null;
  const styleIndex = raw.indexOf(":::");
  if (styleIndex >= 0) {
    warnings.push({ code: "convert/unsupported", message: `class style attachment "${truncateForMessage(raw.slice(styleIndex))}" ignored`, line });
    raw = raw.slice(0, styleIndex).trim();
  }
  let generics = "";
  const generic = /^([A-Za-z_][A-Za-z0-9_.]*)\s*~([\s\S]+?)~\s*$/.exec(raw);
  if (generic) {
    generics = `<${cleanLabel(generic[2])}>`;
    raw = generic[1];
  }
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\[\s*"([\s\S]*?)"\s*\])?\s*$/.exec(raw);
  if (!match) {
    warnings.push({ code: "convert/unsupported", message: `could not parse class name "${truncateForMessage(raw)}"`, line });
    const token = raw.split(/\s+/)[0].replace(/~[\s\S]*~$/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) return null;
    return { rawId: token, label: token + generics, alias: false };
  }
  const label = match[2] !== undefined ? `${cleanLabel(match[2])}${generics}` : `${cleanLabel(match[1])}${generics}`;
  return { rawId: match[1], label: label || match[1], alias: match[2] !== undefined };
}

function classRefFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const base = raw.replace(/~[\s\S]*~$/, "");
  return { rawId: base, label: raw, alias: false };
}

function setClassStereotype(node, raw, line, warnings) {
  const value = String(raw || "").trim().toLowerCase();
  if (["interface", "abstract", "class"].includes(value)) {
    if (node.stereotype && node.stereotype !== value) {
      warnings.push({ code: "convert/node-redefined", message: `class "${node.label}" has conflicting stereotypes; keeping "${node.stereotype}"`, line });
      return;
    }
    node.stereotype = value;
    return;
  }
  warnings.push({ code: "convert/unsupported", message: `stereotype "<<${raw}>>" has no IR equivalent (interface/abstract only); ignored`, line });
}

function addClassMember(node, text, line, warnings) {
  const member = String(text || "").trim();
  if (!member) return;
  if (node.members.length >= 12) {
    warnings.push({ code: "convert/class-members", message: `class "${node.label}" has more than 12 members; extra member dropped`, line });
    return;
  }
  const limited = truncateChars(member, 60);
  if (limited.truncated) warnings.push({ code: "convert/class-members", message: `member "${truncateForMessage(member)}" is longer than 60 characters and was shortened`, line });
  if (!node.members.includes(limited.text)) node.members.push(limited.text);
}

function scanClassBody(innerLines, node, warnings) {
  for (const entry of innerLines) {
    let text = entry.text;
    const commentAt = text.indexOf("%%");
    if (commentAt >= 0) text = text.slice(0, commentAt);
    text = text.trim();
    if (!text) continue;
    const stereotype = /^<<\s*([A-Za-z]+)\s*>>\s*$/.exec(text);
    if (stereotype) {
      setClassStereotype(node, stereotype[1], entry.line, warnings);
      continue;
    }
    addClassMember(node, text, entry.line, warnings);
  }
}

function parseClassDiagram(statements, warnings) {
  const classes = [];
  const byKey = new Map();
  const usedIds = new Set();
  const edges = [];
  let direction = null;

  const registerClass = (ref, line, declared) => {
    if (!ref) return null;
    const key = normalizeId(ref.rawId);
    let node = byKey.get(key);
    if (!node) {
      node = {
        id: uniqueId(key, usedIds),
        key,
        label: ref.label || ref.rawId,
        labelExplicit: Boolean(ref.alias),
        stereotype: null,
        members: [],
        declared: false,
        line,
      };
      classes.push(node);
      byKey.set(key, node);
    } else if (ref.label && ref.label !== node.label) {
      if (ref.alias && !node.labelExplicit) {
        node.label = ref.label;
        node.labelExplicit = true;
      } else if (ref.alias) {
        warnings.push({ code: "convert/node-redefined", message: `class "${ref.rawId}" redeclared as "${truncateForMessage(ref.label)}"; keeping the first label`, line });
      }
    }
    if (declared) node.declared = true;
    return node;
  };

  for (const statement of statements) {
    const line = statement.line;
    if (statement.unclosed) {
      warnings.push({ code: "convert/unsupported", message: "a class block was not closed; members were still read", line });
    }
    if (statement.inner) {
      const ref = parseClassReference(statement.text.replace(/^class\s+/i, ""), line, warnings);
      if (!ref) continue;
      const node = registerClass(ref, line, true);
      scanClassBody(statement.inner, node, warnings);
      continue;
    }

    const text = statement.text.trim();
    if (!text) continue;
    if (/^direction\b/i.test(text)) {
      direction = parseDiagramDirection(text.split(/\s+/)[1], line, warnings);
      continue;
    }
    if (/^%%/.test(text)) continue;

    if (/^class\s+/i.test(text)) {
      const ref = parseClassReference(text.replace(/^class\s+/i, ""), line, warnings);
      if (ref) registerClass(ref, line, true);
      continue;
    }

    const standaloneStereotype = /^<<\s*([A-Za-z]+)\s*>>\s*([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(text);
    if (standaloneStereotype) {
      const node = registerClass({ rawId: standaloneStereotype[2], label: standaloneStereotype[2], alias: false }, line, true);
      setClassStereotype(node, standaloneStereotype[1], line, warnings);
      continue;
    }

    const relation = CLASS_RELATION.exec(text);
    if (relation) {
      const spec = CLASS_RELATION_SPECS[relation[3]];
      const left = classRefFromToken(relation[1]);
      const right = classRefFromToken(relation[5]);
      const leftNode = registerClass(left, line, false);
      const rightNode = registerClass(right, line, false);
      if (!spec || !leftNode || !rightNode) {
        warnings.push({ code: "convert/unsupported", message: `unrecognized class relation "${truncateForMessage(text)}" ignored`, line });
        continue;
      }
      if (relation[2] || relation[4]) {
        warnings.push({ code: "convert/class-multiplicity", message: `class relation multiplicity ${JSON.stringify(relation[2] || relation[4])} has no IR field; dropped`, line });
      }
      if (spec.aggregation) {
        warnings.push({ code: "convert/class-aggregation", message: `aggregation "${relation[3]}" has no IR kind; mapped to "association"`, line });
      }
      const from = spec.reverse ? rightNode : leftNode;
      const to = spec.reverse ? leftNode : rightNode;
      if (from.id === to.id) {
        warnings.push({ code: "convert/self-edge", message: `self-relation on "${from.label}" dropped (IR has no self-edges)`, line });
        continue;
      }
      edges.push({ from: from.id, to: to.id, label: cleanLabel(relation[6] || ""), kind: spec.kind, line });
      continue;
    }

    const memberLine = /^([A-Za-z_][A-Za-z0-9_.]*)\s*:\s*([\s\S]+)$/.exec(text);
    if (memberLine) {
      const node = registerClass({ rawId: memberLine[1], label: memberLine[1], alias: false }, line, true);
      addClassMember(node, memberLine[2], line, warnings);
      continue;
    }
    if (/^(classdef|style|cssclass|linkstyle|click|callback|title|acctitle|accdescr|note)\b/i.test(text)) {
      warnings.push({ code: "convert/unsupported", message: `"${text.split(/\s+/)[0]}" is not representable in class IR; ignored`, line });
      continue;
    }
    warnings.push({ code: "convert/unsupported", message: `unrecognized classDiagram statement "${truncateForMessage(text)}" ignored`, line });
  }
  return { classes, edges, direction };
}

function finalizeClassDiagram(parsed, warnings) {
  const nodes = parsed.classes.map((cls) => {
    const node = { id: cls.id, label: truncateChars(cls.label, LABEL_MAX).text };
    if (cls.stereotype) node.stereotype = cls.stereotype;
    if (cls.members.length > 0) node.members = cls.members.slice(0, 12);
    return node;
  });
  const edges = dedupeEdges(parsed.edges, warnings).map((edge) => {
    const entry = { from: edge.from, to: edge.to };
    if (edge.label) entry.label = edge.label;
    entry.kind = edge.kind;
    return entry;
  });
  const ir = { title: "", type: "class", nodes, edges };
  if (parsed.direction) ir.direction = parsed.direction;
  clampNodes(ir, warnings);
  clampEdges(ir, warnings);
  return ir;
}

/* ------------------------------------------------------------------------- */
/* IR assembly                                                               */
/* ------------------------------------------------------------------------- */

function dedupeEdges(edges, warnings) {
  const seen = new Set();
  const kept = [];
  for (const edge of edges) {
    const label = String(edge.label || "").trim();
    const key = `${edge.from}\u0000${edge.to}\u0000${label}`;
    if (seen.has(key)) {
      warnings.push({ code: "convert/duplicate-edge", message: `duplicate edge "${edge.from}" → "${edge.to}"${label ? ` "${label}"` : ""} dropped`, line: edge.line || 1 });
      continue;
    }
    seen.add(key);
    kept.push({ ...edge, label });
  }
  return kept;
}

function dropSelfEdges(edges) {
  return edges.filter((edge) => edge.from !== edge.to);
}

function clampNodes(ir, warnings) {
  if (ir.nodes.length > NODE_MAX) {
    const dropped = ir.nodes.slice(NODE_MAX);
    const droppedIds = new Set(dropped.map((node) => node.id));
    warnings.push({ code: "convert/node-limit", message: `${ir.nodes.length} nodes found; IR v1 allows ${NODE_MAX} — the last ${dropped.length} were dropped`, line: 1 });
    ir.nodes = ir.nodes.slice(0, NODE_MAX);
    ir.edges = ir.edges.filter((edge) => !droppedIds.has(edge.from) && !droppedIds.has(edge.to));
    if (ir.groups) ir.groups = ir.groups.filter((group) => group.nodes.some((id) => !droppedIds.has(id)));
  }
}

function clampEdges(ir, warnings) {
  if (ir.edges.length > EDGE_MAX) {
    warnings.push({ code: "convert/edge-limit", message: `${ir.edges.length} edges found; IR v1 allows ${EDGE_MAX} — the last ${ir.edges.length - EDGE_MAX} were dropped`, line: 1 });
    ir.edges = ir.edges.slice(0, EDGE_MAX);
  }
}

function finalizeFlowchart(parsed, direction, type, warnings) {
  const nodes = parsed.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind }));
  const edges = dedupeEdges(dropSelfEdges(parsed.edges), warnings).map((edge) => {
    const entry = { from: edge.from, to: edge.to };
    if (edge.label) entry.label = edge.label;
    entry.kind = edge.kind;
    return entry;
  });

  // Boundary groups in declaration order; one node may only live in one.
  const groups = [];
  const groupIds = new Set();
  const claimed = new Set();
  for (const frame of parsed.frames) {
    const members = frame.members.filter((id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    });
    if (members.length === 0) {
      warnings.push({ code: "convert/empty-subgraph", message: `subgraph "${truncateForMessage(frame.label)}" has no members; group skipped`, line: frame.line });
      continue;
    }
    let id = uniqueId(frame.id, groupIds);
    if (textLength(id) > ID_MAX) id = id.slice(0, ID_MAX);
    let label = frame.label;
    const limited = truncateChars(label, GROUP_LABEL_MAX);
    if (limited.truncated) warnings.push({ code: "convert/label-truncated", message: `subgraph label "${truncateForMessage(label)}" shortened`, line: frame.line });
    label = limited.text;
    groups.push({ id, label, kind: "boundary", nodes: members });
  }
  const groupByNode = new Map();
  for (const group of groups) for (const id of group.nodes) groupByNode.set(id, group.id);
  for (const node of nodes) {
    if (groupByNode.has(node.id)) node.group = groupByNode.get(node.id);
  }

  const ir = { title: "", type, direction, nodes, edges };
  if (groups.length > 0) ir.groups = groups;
  clampNodes(ir, warnings);
  clampEdges(ir, warnings);
  if (ir.groups) ir.groups = ir.groups.map((group) => ({ ...group, nodes: group.nodes.filter((id) => ir.nodes.some((node) => node.id === id)) })).filter((group) => group.nodes.length > 0);
  return ir;
}

function finalizeSequence(parsed, warnings) {
  const nodes = parsed.participants.map((participant) => ({ id: participant.id, label: participant.label, kind: participant.kind }));
  const edges = [];
  const seen = new Set();
  for (const edge of parsed.edges) {
    const label = String(edge.label || "").trim();
    const key = `${edge.from}\u0000${edge.to}\u0000${label}`;
    if (seen.has(key)) {
      warnings.push({ code: "convert/duplicate-edge", message: `duplicate message "${edge.from}" → "${edge.to}"${label ? ` "${label}"` : ""} dropped`, line: edge.line || 1 });
      continue;
    }
    seen.add(key);
    const entry = { from: edge.from, to: edge.to };
    if (label) entry.label = label;
    entry.kind = edge.kind;
    edges.push(entry);
  }
  const ir = { title: "", type: "sequence", nodes, edges };
  if (parsed.groups.length > 0) ir.groups = parsed.groups.map((group) => ({ ...group }));
  if (parsed.notes.length > 0) ir.notes = parsed.notes;
  clampNodes(ir, warnings);
  clampEdges(ir, warnings);
  if (ir.groups) ir.groups = ir.groups.map((group) => ({ ...group, nodes: group.nodes.filter((id) => ir.nodes.some((node) => node.id === id)) })).filter((group) => group.nodes.length > 0);
  return ir;
}

const DEFAULT_TITLES = {
  "sequence": "Mermaid sequence",
  "flowchart": "Mermaid flowchart",
  "erd": "Mermaid ER diagram",
  "class": "Mermaid class diagram",
};

function deriveTitle(meta, dialect, parsed) {
  const raw = meta.title || (parsed && parsed.title) || "";
  if (raw) return truncateChars(cleanLabel(raw), TITLE_MAX).text;
  return DEFAULT_TITLES[dialect] || "Mermaid diagram";
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Convert Mermaid text into Naqsha IR v1.
 *
 * @param {string} text Mermaid source
 * @param {{type?: "auto"|"architecture"|"workflow"|"sequence"}} [options]
 * @returns {{ok: boolean, ir: object|null, warnings: Array<{code:string,message:string,line:number}>, errors: Array<{code:string,message:string,line:number}>}}
 */
export function convertMermaid(text, { type = "auto" } = {}) {
  const warnings = [];
  const errors = [];
  const fail = (code, message, line) => {
    errors.push({ code, message, line });
    return { ok: false, ir: null, warnings, errors };
  };

  if (typeof text !== "string") return fail("convert/input", "Mermaid input must be a string", 1);
  const source = text.replace(/^\uFEFF/, "");
  if (!source.trim()) return fail("convert/empty", "Mermaid input is empty", 1);
  if (type !== "auto" && !SUPPORTED_TYPES.includes(type)) {
    return fail("convert/bad-type", `unknown target type "${truncateForMessage(type)}" — use auto, architecture, workflow, sequence, erd or class`, 1);
  }

  const front = takeFrontMatter(source);
  const { statements, junk } = splitStatements(front.body);
  for (const item of junk) {
    warnings.push({ code: "convert/unsupported", message: "`%%{…}%%` config directive ignored (IR v1 has no Mermaid config)", line: item.line + front.lineOffset });
  }
  for (const key of front.ignored) {
    warnings.push({ code: "convert/unsupported", message: `front-matter key "${key}" ignored (only title/subtitle are mapped)`, line: 1 });
  }
  if (statements.length === 0) return fail("convert/no-diagram", "no Mermaid diagram found (expected flowchart/graph or sequenceDiagram)", 1);

  const shiftLine = (line) => line + front.lineOffset;
  const shifted = statements.map((statement) => ({ text: statement.text, line: shiftLine(statement.line) }));
  const header = shifted[0];
  let headerWord = header.text.toLowerCase().split(/[\s;]/)[0];
  if (headerWord.startsWith("flowchart-") || headerWord === "graph-") {
    warnings.push({ code: "convert/unsupported", message: `"${headerWord}" variant parsed as a plain flowchart`, line: header.line });
    headerWord = "flowchart";
  }

  const KNOWN_DIALECTS = ["flowchart", "graph", "sequencediagram", "erdiagram", "classdiagram"];
  if (!KNOWN_DIALECTS.includes(headerWord)) {
    const shownWord = header.text.split(/[\s;]/)[0] || headerWord;
    if (/^[a-z]+(diagram|chart|graph)$/i.test(headerWord) || ["gantt", "pie", "journey", "mindmap", "timeline", "gitgraph", "kanban", "block", "packet", "sankey", "architecture-beta", "quadrantchart", "xychart", "requirementdiagram", "statediagram", "statediagram-v2", "c4context"].includes(headerWord)) {
      return fail("convert/unsupported-diagram", `"${truncateForMessage(shownWord)}" is not supported yet — Naqsha converts flowchart/graph, sequenceDiagram, erDiagram and classDiagram`, header.line);
    }
    return fail("convert/unknown-diagram", `unrecognized diagram header "${truncateForMessage(header.text)}" (expected flowchart/graph, sequenceDiagram, erDiagram or classDiagram)`, header.line);
  }

  const isSequence = headerWord === "sequencediagram";
  const isErd = headerWord === "erdiagram";
  const isClass = headerWord === "classdiagram";
  const restStatements = shifted.slice(1);

  if (isErd || isClass) {
    const nativeType = isErd ? "erd" : "class";
    const dialectName = isErd ? "erDiagram" : "classDiagram";
    if (type !== "auto" && type !== nativeType) {
      warnings.push({
        code: "convert/type-mismatch",
        message: `${dialectName} can only produce "${nativeType}" IR (requested "${type}"); keeping "${nativeType}"`,
        line: header.line,
      });
    }
    const dialectStatements = splitBodyStatements(front.body, isErd ? isErBlockHeader : isClassBlockHeader).map((entry) => ({
      ...entry,
      line: shiftLine(entry.line),
      inner: entry.inner ? entry.inner.map((inner) => ({ ...inner, line: shiftLine(inner.line) })) : null,
    }));
    const parsed = isErd ? parseErDiagram(dialectStatements, warnings) : parseClassDiagram(dialectStatements, warnings);
    const nodeCount = isErd ? parsed.entities.length : parsed.classes.length;
    if (nodeCount === 0) {
      return fail("convert/no-nodes", `${dialectName} has no ${isErd ? "entities" : "classes"}`, header.line);
    }
    const ir = isErd ? finalizeErd(parsed, warnings) : finalizeClassDiagram(parsed, warnings);
    ir.title = deriveTitle(front.meta, nativeType, null);
    if (front.meta.subtitle) ir.subtitle = truncateChars(String(front.meta.subtitle), 120).text;
    return { ok: true, ir, warnings, errors };
  }

  if (isSequence) {
    if (type === "erd" || type === "class") {
      return fail("convert/type-mismatch", `a sequenceDiagram cannot become "${type}" IR — ${type === "erd" ? "entity attributes" : "class members"} are not present in messages`, header.line);
    }
    if (type !== "auto" && type !== "sequence") {
      warnings.push({ code: "convert/type-mismatch", message: `input is a sequenceDiagram but type "${type}" was requested; keeping the requested type`, line: header.line });
    }
    const parsed = parseSequence(restStatements, warnings, front.meta.title || "");
    if (parsed.participants.length === 0) {
      return fail("convert/no-nodes", "sequenceDiagram has no participants or messages", header.line);
    }
    let ir = finalizeSequence(parsed, warnings);
    const wanted = type === "auto" ? "sequence" : type;
    ir.title = deriveTitle(front.meta, "sequence", parsed);
    // Derive the final title first (deriveTitle may use front meta / sequence title).
    if (parsed.title && !front.meta.title) ir.title = truncateChars(parsed.title, TITLE_MAX).text;
    if (wanted !== "sequence") {
      ir.type = wanted;
      if (ir.groups) ir.groups = ir.groups.map((group) => ({ ...group, kind: "boundary" }));
    }
    ir.title = truncateChars(ir.title, TITLE_MAX).text;
    if (front.meta.subtitle) ir.subtitle = truncateChars(String(front.meta.subtitle), 120).text;
    return { ok: true, ir, warnings, errors };
  }

  // ---- flowchart / graph ----
  if (type === "erd" || type === "class") {
    return fail("convert/type-mismatch", `a flowchart cannot become "${type}" IR — ${type === "erd" ? "entity attributes" : "class members"} are not present in nodes and edges`, header.line);
  }
  const headerText = header.text.replace(/^\S+\s*/, "");
  let direction = "TB";
  const directionWord = (headerText.split(/[\s;]/)[0] || "").toUpperCase();
  if (directionWord) {
    if (directionWord === "TD" || directionWord === "TB") direction = "TB";
    else if (directionWord === "LR") direction = "LR";
    else if (directionWord === "RL") {
      direction = "LR";
      warnings.push({ code: "convert/direction-mapped", message: '"RL" mapped to "LR" (IR v1 only has TB/LR)', line: header.line });
    } else if (directionWord === "BT") {
      direction = "TB";
      warnings.push({ code: "convert/direction-mapped", message: '"BT" mapped to "TB" (IR v1 only has TB/LR)', line: header.line });
    } else {
      warnings.push({ code: "convert/unknown-direction", message: `unknown direction "${truncateForMessage(directionWord)}"; defaulting to "TB"`, line: header.line });
    }
  }
  const parsed = parseFlowchart(restStatements, warnings);
  if (parsed.nodes.length === 0) {
    return fail("convert/no-nodes", "flowchart has no nodes", header.line);
  }
  const autoType = parsed.subgraphCount >= 2 ? "architecture" : "workflow";
  const wanted = type === "auto" ? autoType : type;
  const ir = finalizeFlowchart(parsed, direction, wanted, warnings);
  if (wanted === "sequence") {
    // A flowchart forced into sequence: drop flowchart groups, they are not fragments.
    if (ir.groups) ir.groups = ir.groups.map((group) => ({ ...group, kind: "fragment" }));
    ir.direction = undefined;
  }
  ir.title = deriveTitle(front.meta, "flowchart", null);
  if (front.meta.subtitle) ir.subtitle = truncateChars(String(front.meta.subtitle), 120).text;
  if (ir.direction === undefined) delete ir.direction;
  return { ok: true, ir, warnings, errors };
}

export default convertMermaid;
