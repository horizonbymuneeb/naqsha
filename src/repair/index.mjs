/**
 * Naqsha — self-healing IR repair (owner: convert).
 *
 * `repair(ir)` takes the sloppy JSON an agent wrote and returns a cleaned-up
 * IR v1.1 plus a change log: `{ir, changes: [{code, path, note}]}`.
 *
 * Guarantees
 *   - deterministic: same input -> byte-identical output, no clock/randomness
 *   - idempotent: repair(repair(x).ir).changes is empty
 *   - conservative: never deletes a node or edge (exact duplicate edges are the
 *     only deletion), only renames ids / drops malformed or unknown keys.
 *
 * Repairs
 *   - unknown keys at every level (root, node, edge, group, walkthrough step)
 *   - missing/invalid node `kind` (keyword inference, else `service`)
 *   - id normalization: `"Web App"` -> `web-app`, digit prefix -> `n-…`,
 *     duplicate ids -> `-2`, `-3`, max 32 chars
 *   - edge/group/node references rewritten to the normalized ids (also resolves
 *     references written as a node label)
 *   - duplicate edges dropped (validator identity is from|to|label)
 *   - missing/invalid edge `kind` inferred from the label, else `main`
 *   - missing `title` derived from the diagram type; over-long text truncated
 *   - group ids/labels normalized, invalid group kind -> `zone`, empty groups
 *     dropped, a node kept in at most one group
 *   - missing `type` inferred (`sequence` when fragment groups exist, else
 *     `workflow`); direction TD/BT -> TB, RL -> LR
 *   - IR v1.1 `walkthrough` preserved and normalized
 */

import { CLASS_EDGE_KINDS, CARDINALITIES, DIAGRAM_TYPES } from "../validate/index.mjs";

/** Types whose node/edge `kind` is required (the v1.0 graph types). */
const GRAPH_TYPES = ["architecture", "workflow", "sequence"];
const TYPES = DIAGRAM_TYPES.filter((type) => type !== "sequence").concat("sequence");
const NODE_KINDS = ["service", "datastore", "actor", "external", "queue", "compute", "security", "state", "note"];
const EDGE_KINDS = ["main", "return", "async", "security", "message", "data"];
const GROUP_KINDS = ["zone", "boundary", "fragment"];
const LOCALES = ["en", "ur", "ar", "zh"];

const TITLE_MAX = 80;
const SUBTITLE_MAX = 120;
const LABEL_MAX = 80;
const GROUP_LABEL_MAX = 80;
const NOTE_MAX = 140;
const NOTES_MAX = 4;
const ID_MAX = 32;
const WALK_MAX = 10;
const WALK_TITLE_MAX = 60;
const WALK_TEXT_MAX = 220;
const FOCUS_MAX = 6;
const CHANGES_MAX = 100;

const ROOT_KEYS = ["title", "subtitle", "type", "direction", "locale", "nodes", "edges", "groups", "notes", "walkthrough"];
const NODE_KEYS = [
  "id", "label", "sublabel", "kind", "group",
  "attributes", "members", "stereotype", "stage", "at", "start", "duration", "lane", "role",
];
const EDGE_KEYS = ["from", "to", "label", "kind", "cardinality"];
const GROUP_KEYS = ["id", "label", "kind", "nodes"];
const STEP_KEYS = ["title", "text", "focus"];

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (text) => Array.from(text);
const textLength = (text) => chars(text).length;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function truncate(text, max) {
  const list = chars(text);
  if (list.length <= max) return { text, truncated: false };
  return { text: `${list.slice(0, Math.max(1, max - 3)).join("")}...`, truncated: true };
}

function normalizeId(raw) {
  let value = String(raw ?? "").trim().toLowerCase();
  value = value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!value) value = "node";
  if (/^[0-9]/.test(value)) value = `n-${value}`;
  if (textLength(value) > ID_MAX) value = value.slice(0, ID_MAX).replace(/-+$/g, "");
  if (!value) value = "node";
  return value;
}

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

function wordsOf(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Brief-mandated node-kind inference: keywords, else `service`. */
function inferKind(text) {
  const words = wordsOf(text).split(" ").filter(Boolean);
  if (words.length === 0) return "service";
  const includes = (list) => list.some((item) => words.includes(item));
  if (includes(["db", "database", "datastore", "store", "cache", "redis", "postgres", "postgresql", "mysql", "mongo", "mongodb", "sql", "ledger", "warehouse", "bucket", "storage"])) return "datastore";
  if (includes(["user", "actor", "human", "person", "customer", "client", "browser", "admin", "operator", "visitor"])) return "actor";
  if (includes(["gateway", "auth", "jwt", "oauth", "token", "verify", "verification", "tls", "security", "waf", "iam", "firewall", "policy"])) return "security";
  if (includes(["queue", "broker", "kafka", "rabbit", "rabbitmq", "sqs", "pubsub", "bus", "stream", "topic", "nats"])) return "queue";
  if (includes(["worker", "job", "compute", "runner", "lambda", "container", "pod", "cron", "batch", "processor"])) return "compute";
  return "service";
}

function inferEdgeKind(label) {
  const words = ` ${wordsOf(label)} `;
  if (/( auth | jwt | verif | token | tls | oauth | login | credential | secret | permission )/.test(words)) return "security";
  if (/( read | write | quer | store | fetch | select | insert | update | db | database | cache | persist | load | save | index )/.test(words)) return "data";
  if (/( response | reply | result | return | rows | miss | hit | ack )/.test(words)) return "return";
  if (/( async | event | emit | publish | fire | notify | enqueue )/.test(words)) return "async";
  return "main";
}

function humanize(raw) {
  const phrase = wordsOf(raw);
  if (!phrase) return "Group";
  return phrase
    .split(" ")
    .slice(0, 8)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function defaultTitle(type) {
  const name = String(type || "workflow");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} diagram`;
}

function shown(value) {
  if (typeof value === "string") return truncate(value, 40).text;
  try {
    return truncate(JSON.stringify(value), 40).text;
  } catch {
    return String(value);
  }
}

/**
 * Repair a Naqsha IR object.
 *
 * @param {unknown} input
 * @returns {{ir: object, changes: Array<{code:string, path:string, note:string}>}}
 */
export function repair(input) {
  const changes = [];
  const note = (code, path, message) => {
    if (changes.length < CHANGES_MAX) changes.push({ code, path, note: message });
  };

  let source = input;
  if (!isObj(source)) {
    note("repair/invalid-root", "$", "IR root must be a JSON object; started from an empty object");
    source = {};
  }

  for (const key of Object.keys(source)) {
    if (!ROOT_KEYS.includes(key)) note("repair/unknown-key", key, `unknown top-level key "${key}" dropped (IR v1 accepts: ${ROOT_KEYS.join(", ")})`);
  }

  /* ---- type ------------------------------------------------------------ */
  const rawType = typeof source.type === "string" ? source.type.trim() : "";
  const declaredType = TYPES.includes(rawType) ? rawType : null;
  const sourceGroups = Array.isArray(source.groups) ? source.groups : [];
  const hasFragment = sourceGroups.some((group) => isObj(group) && group.kind === "fragment");
  let type = declaredType;
  if (!type) {
    type = hasFragment ? "sequence" : "workflow";
    note(
      "repair/type-inferred",
      "type",
      has(source, "type")
        ? `invalid type ${JSON.stringify(shown(source.type))}; inferred "${type}"`
        : `missing type; inferred "${type}" (${hasFragment ? "fragment groups imply a sequence" : "plain node/edge graph defaults to workflow"})`,
    );
  }

  /* ---- direction ------------------------------------------------------- */
  let direction = null;
  if (type === "sequence") {
    if (has(source, "direction")) note("repair/direction-dropped", "direction", "sequence diagrams have no direction; dropped");
  } else if (has(source, "direction")) {
    const raw = typeof source.direction === "string" ? source.direction.trim().toUpperCase() : "";
    if (raw === "TB" || raw === "TD" || raw === "BT") {
      direction = "TB";
      if (raw !== "TB") note("repair/direction-mapped", "direction", `direction "${raw}" mapped to "TB"`);
    } else if (raw === "LR" || raw === "RL") {
      direction = "LR";
      if (raw !== "LR") note("repair/direction-mapped", "direction", `direction "${raw}" mapped to "LR"`);
    } else {
      note("repair/direction-dropped", "direction", `invalid direction ${JSON.stringify(shown(source.direction))} dropped (TB or LR)`);
    }
  }

  /* ---- nodes ----------------------------------------------------------- */
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : [];
  if (has(source, "nodes") && !Array.isArray(source.nodes)) note("repair/nodes-type", "nodes", `"nodes" must be an array; treated as empty`);

  const usedIds = new Set();
  const nodeRefs = new Map(); // any spelling of a node id/label -> normalized id
  const labelRefs = new Map();
  const rawGroupOfNode = new Map(); // normalized node id -> declared group (raw)
  const nodes = [];
  const nodeIndexById = new Map();

  sourceNodes.forEach((raw, index) => {
    const path = `nodes[${index}]`;
    if (!isObj(raw)) {
      note("repair/node-dropped", path, "node is not an object; removed");
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!NODE_KEYS.includes(key)) note("repair/unknown-key", `${path}.${key}`, `unknown node key "${key}" dropped`);
    }
    const rawId = typeof raw.id === "string" ? raw.id.trim() : typeof raw.id === "number" ? String(raw.id) : "";
    const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
    const ref = rawId || rawLabel || `node-${index + 1}`;
    const id = uniqueId(ref, usedIds);

    let label = rawLabel;
    if (!label) {
      label = rawId || `Node ${index + 1}`;
      note("repair/node-label", `${path}.label`, `missing label; derived "${truncate(label, LABEL_MAX).text}"`);
    }
    const limited = truncate(label, LABEL_MAX);
    if (limited.truncated) note("repair/node-label", `${path}.label`, `label longer than ${LABEL_MAX} characters shortened`);
    label = limited.text;

    let kind;
    if (typeof raw.kind === "string" && NODE_KINDS.includes(raw.kind)) {
      kind = raw.kind;
    } else if (!GRAPH_TYPES.includes(type)) {
      // The v1.2 types draw shape from the diagram type, not from node.kind.
      if (has(raw, "kind")) note("repair/node-kind", `${path}.kind`, `unknown node kind ${JSON.stringify(shown(raw.kind))}; dropped (this type derives shape from the node's role)`);
    } else {
      kind = inferKind(`${rawId} ${rawLabel}`);
      note(
        "repair/node-kind",
        `${path}.kind`,
        has(raw, "kind") ? `unknown node kind ${JSON.stringify(shown(raw.kind))}; inferred "${kind}"` : `missing node kind; inferred "${kind}"`,
      );
    }

    const node = { id, label };
    const sublabel = typeof raw.sublabel === "string" ? raw.sublabel.trim() : "";
    if (sublabel) node.sublabel = sublabel;
    if (kind) node.kind = kind;

    // v1.2 per-type node fields are passed through; the validator owns their rules.
    if (Array.isArray(raw.attributes)) node.attributes = raw.attributes.filter((attribute) => isObj(attribute));
    if (Array.isArray(raw.members)) node.members = raw.members.filter((member) => typeof member === "string");
    if (typeof raw.stereotype === "string" && raw.stereotype.trim()) node.stereotype = raw.stereotype.trim();
    if (typeof raw.stage === "string" && raw.stage.trim()) node.stage = raw.stage.trim();
    if (typeof raw.at === "string" || typeof raw.at === "number") node.at = raw.at;
    if (typeof raw.start === "number" && Number.isFinite(raw.start)) node.start = raw.start;
    if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) node.duration = raw.duration;
    if (typeof raw.lane === "string" && raw.lane.trim()) node.lane = raw.lane.trim();
    if (typeof raw.role === "string" && raw.role.trim()) node.role = raw.role.trim();

    if (typeof raw.group === "string" && raw.group.trim()) rawGroupOfNode.set(id, raw.group.trim());
    else if (has(raw, "group") && raw.group !== undefined && raw.group !== null && raw.group !== "") {
      note("repair/node-group", `${path}.group`, "node group must be a non-empty string; dropped");
    }

    nodes.push(node);
    nodeIndexById.set(id, index);

    if (rawId) {
      const spellings = [rawId, rawId.toLowerCase(), normalizeId(rawId)];
      for (const spelling of spellings) if (spelling && !nodeRefs.has(spelling)) nodeRefs.set(spelling, id);
    }
    if (rawLabel) {
      for (const spelling of [rawLabel, rawLabel.toLowerCase(), normalizeId(rawLabel)]) {
        if (spelling && !labelRefs.has(spelling)) labelRefs.set(spelling, id);
      }
    }
    if (!nodeRefs.has(id)) nodeRefs.set(id, id);
  });

  const resolveNodeRef = (value) => {
    if (typeof value === "number") value = String(value);
    if (typeof value !== "string" || !value.trim()) return null;
    const raw = value.trim();
    if (nodeRefs.has(raw)) return nodeRefs.get(raw);
    const lower = raw.toLowerCase();
    if (nodeRefs.has(lower)) return nodeRefs.get(lower);
    const normalized = normalizeId(raw);
    if (nodeRefs.has(normalized)) return nodeRefs.get(normalized);
    if (labelRefs.has(raw)) return labelRefs.get(raw);
    if (labelRefs.has(lower)) return labelRefs.get(lower);
    if (nodeIdsSet.has(normalized)) return normalized;
    return null;
  };
  const nodeIdsSet = new Set(nodes.map((node) => node.id));

  /**
   * Resolve an edge endpoint. A known node wins; otherwise the spelling is
   * normalized in place (one-time, so repair stays idempotent) and the node
   * still has to be added or the reference fixed — the validator says so.
   */
  const resolveEndpoint = (value, path) => {
    if (typeof value === "number") value = String(value);
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    const resolved = resolveNodeRef(trimmed);
    if (resolved) return resolved;
    const normalized = normalizeId(trimmed);
    if (normalized !== trimmed) {
      note("repair/dangling-ref", path, `edge endpoint ${JSON.stringify(shown(trimmed))} does not match any node; normalized to "${normalized}" (add that node or fix the reference)`);
    }
    return normalized;
  };

  /* ---- groups ---------------------------------------------------------- */
  const usedGroupIds = new Set();
  const groupRefs = new Map();
  const groups = [];
  const groupById = new Map();
  const membership = new Map(); // node id -> group id (from group.nodes)

  sourceGroups.forEach((raw, index) => {
    const path = `groups[${index}]`;
    if (!isObj(raw)) {
      note("repair/group-dropped", path, "group is not an object; removed");
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!GROUP_KEYS.includes(key)) note("repair/unknown-key", `${path}.${key}`, `unknown group key "${key}" dropped`);
    }
    const rawId = typeof raw.id === "string" ? raw.id.trim() : typeof raw.id === "number" ? String(raw.id) : "";
    const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
    const ref = rawId || rawLabel || `group-${index + 1}`;
    const id = uniqueId(ref, usedGroupIds);

    let label = rawLabel;
    if (!label) {
      label = humanize(rawId || id);
      note("repair/group-label", `${path}.label`, `missing group label; derived "${truncate(label, GROUP_LABEL_MAX).text}"`);
    }
    const limited = truncate(label, GROUP_LABEL_MAX);
    if (limited.truncated) note("repair/group-label", `${path}.label`, `group label longer than ${GROUP_LABEL_MAX} characters shortened`);
    label = limited.text;

    let kind = "zone";
    if (typeof raw.kind === "string" && GROUP_KINDS.includes(raw.kind)) {
      kind = raw.kind;
      if (kind === "fragment" && type !== "sequence") {
        kind = "boundary";
        note("repair/group-kind", `${path}.kind`, `fragment groups only exist in sequence diagrams; "${id}" changed to "boundary"`);
      }
    } else if (has(raw, "kind")) {
      note("repair/group-kind", `${path}.kind`, `unknown group kind ${JSON.stringify(shown(raw.kind))}; using "zone"`);
    }

    const members = [];
    const memberSeen = new Set();
    const rawMembers = Array.isArray(raw.nodes) ? raw.nodes : [];
    if (has(raw, "nodes") && !Array.isArray(raw.nodes)) note("repair/group-members", `${path}.nodes`, `group "nodes" must be an array; group dropped`);
    for (const member of rawMembers) {
      const resolved = resolveNodeRef(member);
      if (!resolved) {
        note("repair/group-dangling", `${path}.nodes`, `group references unknown node ${JSON.stringify(shown(member))}; entry dropped`);
        continue;
      }
      if (memberSeen.has(resolved)) continue;
      if (membership.has(resolved)) {
        note("repair/group-duplicate-node", `${path}.nodes`, `node "${resolved}" already belongs to group "${membership.get(resolved)}"; entry dropped`);
        continue;
      }
      memberSeen.add(resolved);
      membership.set(resolved, id);
      members.push(resolved);
    }
    const group = { id, label, kind, nodes: members };
    groups.push(group);
    groupById.set(id, group);
    const spellings = [ref, ref.toLowerCase(), normalizeId(ref), id, rawLabel, rawId];
    for (const spelling of spellings) if (spelling && !groupRefs.has(spelling)) groupRefs.set(spelling, id);
  });

  // node.group: keep it only when it resolves to a group that lists the node.
  for (const node of nodes) {
    const rawGroup = rawGroupOfNode.get(node.id);
    if (!rawGroup) continue;
    let target = groupRefs.get(rawGroup);
    if (!target) target = groupRefs.get(rawGroup.toLowerCase());
    if (!target) target = groupRefs.get(normalizeId(rawGroup));
    if (!target) target = groupById.has(normalizeId(rawGroup)) ? normalizeId(rawGroup) : null;
    if (!target) {
      note("repair/node-group", `nodes[${nodeIndexById.get(node.id)}].group`, `node "${node.id}" points at unknown group ${JSON.stringify(shown(rawGroup))}; dropped`);
      continue;
    }
    const listed = membership.get(node.id);
    if (listed === target) {
      node.group = target;
    } else if (listed) {
      note("repair/node-group", `nodes[${nodeIndexById.get(node.id)}].group`, `node "${node.id}" declares group "${target}" but is listed in "${listed}"; group field dropped`);
    } else {
      const group = groupById.get(target);
      group.nodes.push(node.id);
      membership.set(node.id, target);
      node.group = target;
      note("repair/node-group", `nodes[${nodeIndexById.get(node.id)}].group`, `node "${node.id}" added to group "${target}" (declared via node.group)`);
    }
  }

  // Groups nothing joined stay invalid; drop them now (after node.group had a
  // chance to declare membership for a group that was authored empty).
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.nodes.length > 0) continue;
    groups.splice(index, 1);
    groupById.delete(group.id);
    note("repair/group-dropped", `groups[${index}]`, `group "${group.id}" has no valid members; removed`);
  }

  /* ---- edges ----------------------------------------------------------- */
  const sourceEdges = Array.isArray(source.edges) ? source.edges : [];
  if (has(source, "edges") && !Array.isArray(source.edges)) note("repair/edges-type", "edges", `"edges" must be an array; treated as empty`);
  const edges = [];
  const edgeKeys = new Set();

  sourceEdges.forEach((raw, index) => {
    const path = `edges[${index}]`;
    if (!isObj(raw)) {
      note("repair/edge-dropped", path, "edge is not an object; removed");
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!EDGE_KEYS.includes(key)) note("repair/unknown-key", `${path}.${key}`, `unknown edge key "${key}" dropped`);
    }
    const finalFrom = resolveEndpoint(raw.from, `${path}.from`);
    const finalTo = resolveEndpoint(raw.to, `${path}.to`);

    const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
    if (has(raw, "label") && typeof raw.label !== "string") note("repair/edge-label", `${path}.label`, "edge label must be a string; dropped");

    let kind = null;
    if (typeof raw.kind === "string" && EDGE_KINDS.includes(raw.kind)) {
      kind = raw.kind;
    } else if (!GRAPH_TYPES.includes(type)) {
      if (typeof raw.kind === "string" && type === "class" && CLASS_EDGE_KINDS.includes(raw.kind)) {
        kind = raw.kind;
      } else if (has(raw, "kind")) {
        note("repair/edge-kind", `${path}.kind`, `unknown edge kind ${JSON.stringify(shown(raw.kind))}; dropped (this type derives the stroke from the relation)`);
      }
    } else {
      kind = inferEdgeKind(rawLabel);
      note(
        "repair/edge-kind",
        `${path}.kind`,
        has(raw, "kind") ? `unknown edge kind ${JSON.stringify(shown(raw.kind))}; inferred "${kind}"` : `missing edge kind; inferred "${kind}"`,
      );
    }

    const key = `${finalFrom}\u0000${finalTo}\u0000${rawLabel}`;
    if (edgeKeys.has(key)) {
      note("repair/duplicate-edge", path, `duplicate edge "${finalFrom}" → "${finalTo}"${rawLabel ? ` "${rawLabel}"` : ""} dropped`);
      return;
    }
    edgeKeys.add(key);
    const edge = { from: finalFrom, to: finalTo };
    if (rawLabel) edge.label = rawLabel;
    if (kind) edge.kind = kind;
    if (typeof raw.cardinality === "string" && CARDINALITIES.includes(raw.cardinality)) edge.cardinality = raw.cardinality;
    else if (has(raw, "cardinality")) note("repair/cardinality", `${path}.cardinality`, `unknown cardinality ${JSON.stringify(shown(raw.cardinality))}; dropped (1:1, 1:n, n:m)`);
    edges.push(edge);
  });

  /* ---- notes ----------------------------------------------------------- */
  let notesOut = null;
  if (has(source, "notes")) {
    if (!Array.isArray(source.notes)) {
      note("repair/notes-type", "notes", `"notes" must be an array of strings; dropped`);
    } else {
      const list = [];
      source.notes.forEach((raw, index) => {
        if (typeof raw !== "string") {
          note("repair/note-dropped", `notes[${index}]`, "note must be a string; removed");
          return;
        }
        const cleaned = raw.trim();
        if (!cleaned) return;
        if (list.length >= NOTES_MAX) {
          note("repair/note-dropped", `notes[${index}]`, `more than ${NOTES_MAX} notes; removed`);
          return;
        }
        const limited = truncate(cleaned, NOTE_MAX);
        if (limited.truncated) note("repair/note-length", `notes[${index}]`, `note longer than ${NOTE_MAX} characters shortened`);
        list.push(limited.text);
      });
      if (list.length > 0) notesOut = list;
    }
  }

  /* ---- title / subtitle ------------------------------------------------ */
  let title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title) {
    title = defaultTitle(type);
    note("repair/title", "title", has(source, "title") ? `invalid title; derived "${title}"` : `missing title; derived "${title}"`);
  }
  const limitedTitle = truncate(title, TITLE_MAX);
  if (limitedTitle.truncated) note("repair/title", "title", `title longer than ${TITLE_MAX} characters shortened`);
  title = limitedTitle.text;

  let subtitle = null;
  if (has(source, "subtitle")) {
    if (typeof source.subtitle !== "string") {
      note("repair/subtitle", "subtitle", `"subtitle" must be a string; dropped`);
    } else {
      const cleaned = source.subtitle.trim();
      if (cleaned) {
        const limited = truncate(cleaned, SUBTITLE_MAX);
        if (limited.truncated) note("repair/subtitle", "subtitle", `subtitle longer than ${SUBTITLE_MAX} characters shortened`);
        subtitle = limited.text;
      }
    }
  }

  /* ---- locale ---------------------------------------------------------- */
  let locale = null;
  if (has(source, "locale")) {
    if (typeof source.locale === "string" && LOCALES.includes(source.locale)) {
      locale = source.locale;
    } else {
      note("repair/locale", "locale", `unknown locale ${JSON.stringify(shown(source.locale))}; dropped (use ${LOCALES.join(", ")})`);
    }
  }

  /* ---- walkthrough ----------------------------------------------------- */
  let walkthrough = null;
  if (has(source, "walkthrough")) {
    if (!Array.isArray(source.walkthrough)) {
      note("repair/walkthrough-type", "walkthrough", `"walkthrough" must be an array; dropped`);
    } else {
      const steps = [];
      source.walkthrough.forEach((raw, index) => {
        const path = `walkthrough[${index}]`;
        if (!isObj(raw)) {
          note("repair/walkthrough-step", path, "walkthrough step is not an object; removed");
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!STEP_KEYS.includes(key)) note("repair/unknown-key", `${path}.${key}`, `unknown walkthrough key "${key}" dropped`);
        }
        if (steps.length >= WALK_MAX) {
          note("repair/walkthrough-step", path, `more than ${WALK_MAX} walkthrough steps; removed`);
          return;
        }
        const stepTitle = truncate(String(typeof raw.title === "string" ? raw.title.trim() : ""), WALK_TITLE_MAX).text;
        const stepText = truncate(String(typeof raw.text === "string" ? raw.text.trim() : ""), WALK_TEXT_MAX).text;
        const focus = [];
        const seenFocus = new Set();
        if (Array.isArray(raw.focus)) {
          for (const item of raw.focus) {
            const resolved = resolveNodeRef(item);
            if (!resolved || seenFocus.has(resolved)) continue;
            seenFocus.add(resolved);
            focus.push(resolved);
            if (focus.length >= FOCUS_MAX) break;
          }
        }
        if (!stepTitle || !stepText || focus.length === 0) {
          note("repair/walkthrough-step", path, "walkthrough step needs a title, text and at least one existing focus node; removed");
          return;
        }
        steps.push({ title: stepTitle, text: stepText, focus });
      });
      if (steps.length > 0) walkthrough = steps;
    }
  }

  /* ---- assemble -------------------------------------------------------- */
  const ir = { title };
  if (subtitle) ir.subtitle = subtitle;
  ir.type = type;
  if (direction) ir.direction = direction;
  if (locale) ir.locale = locale;
  ir.nodes = nodes;
  if (edges.length > 0 || has(source, "edges")) ir.edges = edges;
  if (groups.length > 0) ir.groups = groups;
  if (notesOut) ir.notes = notesOut;
  if (walkthrough) ir.walkthrough = walkthrough;

  return { ir, changes };
}

export default repair;
