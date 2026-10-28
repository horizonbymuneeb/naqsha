// Naqsha IR v1 validator — hand-rolled, zero dependencies.
//
// The product promise is "an agent repairs its JSON in one round", so every
// error carries a stable `code`, a JSON `path` and a concrete `hint` that says
// exactly what to change. Shape (src/CONTRACT.md §1):
//   validate(ir) -> { ok, errors: [{code,message,path,hint}], warnings: [{code,message,path}] }
//
// Never throws on bad input: garbage in -> errors out.

export const DIAGRAM_TYPES = Object.freeze([
  "architecture", "workflow", "sequence",
  "erd", "class", "tree", "timeline", "waterfall", "dataflow", "lifecycle",
]);
export const CLASS_EDGE_KINDS = Object.freeze(["extends", "implements", "association", "composition", "dependency"]);
export const CARDINALITIES = Object.freeze(["1:1", "1:n", "n:m"]);
export const ATTRIBUTE_KEYS = Object.freeze(["pk", "fk", "unique"]);
export const STEREOTYPES = Object.freeze(["interface", "abstract", "class"]);
export const DIRECTIONS = Object.freeze(["TB", "LR"]);
export const NODE_KINDS = Object.freeze([
  "service", "datastore", "actor", "external", "queue", "compute", "security", "state", "note",
]);
export const EDGE_KINDS = Object.freeze(["main", "return", "async", "security", "message", "data"]);
export const GROUP_KINDS = Object.freeze(["zone", "boundary", "fragment"]);
export const STATUSES = Object.freeze(["added", "removed", "changed"]);
const WALKTHROUGH_LIMITS = Object.freeze({ steps: 10, titleMin: 1, titleMax: 60, textMin: 1, textMax: 220, focusMin: 1, focusMax: 6 });
export const ID_PATTERN = "^[a-z][a-z0-9-]{0,31}$";

export const LIMITS = Object.freeze({
  titleMin: 1,
  titleMax: 80,
  subtitleMax: 120,
  nodesMin: 1,
  nodesMax: 40,
  edgesMax: 80,
  notesMax: 4,
  noteMax: 140,
  nodeLabelMax: 80,
  groupLabelMax: 80,
  // Soft limits: crossing them only produces a warning, never a rejection.
  nodeLabelSoft: 40,
  sublabelSoft: 80,
  edgeLabelSoft: 32,
});

const ID_RE = new RegExp(ID_PATTERN);
const ROOT_KEYS = Object.freeze(["title", "subtitle", "type", "direction", "nodes", "edges", "groups", "notes", "walkthrough"]);
const NODE_KEYS = Object.freeze(["id", "label", "sublabel", "kind", "group", "status",
  "attributes", "members", "stereotype", "stage", "at", "start", "duration", "lane", "role"]);
const EDGE_KEYS = Object.freeze(["from", "to", "label", "kind", "status", "cardinality"]);
const GROUP_KEYS = Object.freeze(["id", "label", "kind", "nodes"]);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (str) => Array.from(str).length;
const typeName = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function suggestKey(key, allowed) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 2 ? best : null;
}

function unknownKeyHint(key, allowed, where) {
  const near = suggestKey(key, allowed);
  const rename = near ? `, or rename it to "${near}"` : "";
  return `remove "${key}"${rename} — ${where} supports only: ${allowed.join(", ")}`;
}

/** Quote a value for a hint without letting weird input break the message. */
function shown(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Validate author-facing Naqsha IR v1.
 * @param {unknown} ir parsed JSON value
 * @returns {{ok: boolean, errors: Array<{code:string,message:string,path:string,hint:string}>, warnings: Array<{code:string,message:string,path:string}>}}
 */
export function validate(ir) {
  const errors = [];
  const warnings = [];

  /** @param {string} code @param {string} message @param {string} path @param {string} hint */
  const add = (code, message, path, hint) => {
    errors.push({ code, message, path, hint });
  };
  /** @param {string} code @param {string} message @param {string} path */
  const warn = (code, message, path) => {
    warnings.push({ code, message, path });
  };

  if (!isObj(ir)) {
    const what = Array.isArray(ir) ? "a JSON array" : `a JSON ${typeName(ir)}`;
    add(
      "ir/type",
      `diagram IR must be a JSON object, got ${what}`,
      "$",
      'wrap the diagram in an object: {"title": "...", "type": "architecture", "nodes": [{ "id": "web", "label": "Web App", "kind": "service" }]}',
    );
    return { ok: false, errors, warnings };
  }

  // ---- root keys (strict: typos become unknown-key errors) ----------------
  for (const key of Object.keys(ir)) {
    if (!ROOT_KEYS.includes(key)) {
      add("ir/unknown-key", `unknown top-level key "${key}"`, key, unknownKeyHint(key, ROOT_KEYS, "the diagram root"));
    }
  }

  // ---- title -------------------------------------------------------------
  if (!has(ir, "title")) {
    add("ir/required", 'missing required key "title"', "title", 'add "title": "Checkout service map" (1..80 characters, human readable)');
  } else if (typeof ir.title !== "string") {
    add("ir/type", `"title" must be a string, got ${typeName(ir.title)}`, "title", 'use a string: "title": "Checkout service map"');
  } else {
    const length = chars(ir.title.trim());
    if (length < LIMITS.titleMin) {
      add("ir/title-length", "title is empty", "title", 'write a short human title, 1..80 characters, e.g. "Checkout service map"');
    } else if (length > LIMITS.titleMax) {
      add(
        "ir/title-length",
        `title is ${length} characters, maximum is ${LIMITS.titleMax}`,
        "title",
        `shorten "title" to at most ${LIMITS.titleMax} characters (currently ${length})`,
      );
    }
  }

  // ---- subtitle ----------------------------------------------------------
  if (has(ir, "subtitle")) {
    if (typeof ir.subtitle !== "string") {
      add("ir/type", `"subtitle" must be a string, got ${typeName(ir.subtitle)}`, "subtitle", 'use a string, e.g. "subtitle": "production, 2026-10"');
    } else {
      const length = chars(ir.subtitle.trim());
      if (length > LIMITS.subtitleMax) {
        add(
          "ir/subtitle-length",
          `subtitle is ${length} characters, maximum is ${LIMITS.subtitleMax}`,
          "subtitle",
          `shorten "subtitle" to at most ${LIMITS.subtitleMax} characters (currently ${length})`,
        );
      }
    }
  }

  // ---- type --------------------------------------------------------------
  let diagramType = null;
  if (!has(ir, "type")) {
    add("ir/required", 'missing required key "type"', "type", `add "type": "architecture" — one of: ${DIAGRAM_TYPES.join(", ")}`);
  } else if (typeof ir.type !== "string") {
    add("ir/type", `"type" must be a string, got ${typeName(ir.type)}`, "type", `use one of: ${DIAGRAM_TYPES.join(", ")}`);
  } else if (!DIAGRAM_TYPES.includes(ir.type)) {
    add(
      "ir/unknown-type",
      `unknown diagram type "${shown(ir.type)}"`,
      "type",
      `use one of: ${DIAGRAM_TYPES.join(", ")} (sequence = participants + messages, workflow = steps, architecture = services, erd = tables, class = types, tree = hierarchy, timeline = dated events, waterfall = spans in time, dataflow = pipeline stages, lifecycle = states)`,
    );
  } else {
    diagramType = ir.type;
  }

  // ---- direction ---------------------------------------------------------
  if (has(ir, "direction")) {
    if (typeof ir.direction !== "string") {
      add("ir/type", `"direction" must be a string, got ${typeName(ir.direction)}`, "direction", 'use "TB" (top-to-bottom) or "LR" (left-to-right), or omit it');
    } else if (!DIRECTIONS.includes(ir.direction)) {
      add(
        "ir/unknown-direction",
        `unknown direction "${shown(ir.direction)}"`,
        "direction",
        'use "TB" (top-to-bottom) or "LR" (left-to-right), or omit it to default to "TB"',
      );
    } else if (diagramType === "sequence") {
      warn("ir/direction-ignored", `direction "${ir.direction}" is ignored for sequence diagrams`, "direction");
    }
  }

  // ---- nodes -------------------------------------------------------------
  /** @type {Set<string>} */
  const nodeIds = new Set();
  /** node id -> declared group id (from node.group) */
  const nodeGroupOf = new Map();
  /** node id -> index in nodes array (for paths) */
  const nodeIndexById = new Map();

  if (!has(ir, "nodes")) {
    add("ir/required", 'missing required key "nodes"', "nodes", 'add "nodes": [{ "id": "web", "label": "Web App", "kind": "service" }] (1..40 nodes)');
  } else if (!Array.isArray(ir.nodes)) {
    add("ir/type", `"nodes" must be an array, got ${typeName(ir.nodes)}`, "nodes", 'use an array of node objects: "nodes": [{ "id": "web", "label": "Web App", "kind": "service" }]');
  } else {
    if (ir.nodes.length < LIMITS.nodesMin) {
      add("ir/nodes-count", "nodes is empty, a diagram needs at least 1 node", "nodes", 'add at least one node: { "id": "web", "label": "Web App", "kind": "service" }');
    } else if (ir.nodes.length > LIMITS.nodesMax) {
      add(
        "ir/nodes-count",
        `too many nodes: ${ir.nodes.length}, maximum is ${LIMITS.nodesMax}`,
        "nodes",
        `remove or merge ${ir.nodes.length - LIMITS.nodesMax} node(s), or split the diagram in two (max ${LIMITS.nodesMax} nodes)`,
      );
    }

    ir.nodes.forEach((node, index) => {
      const path = `nodes[${index}]`;
      if (!isObj(node)) {
        add("ir/type", `node ${index} must be an object, got ${typeName(node)}`, path, 'each node looks like { "id": "web", "label": "Web App", "kind": "service" }');
        return;
      }

      for (const key of Object.keys(node)) {
        if (!NODE_KEYS.includes(key)) {
          add("ir/unknown-key", `unknown node key "${key}"`, `${path}.${key}`, unknownKeyHint(key, NODE_KEYS, "a node"));
        }
      }

      // id
      if (!has(node, "id")) {
        add("ir/required", "node is missing its \"id\"", `${path}.id`, `add a unique lowercase id, e.g. "id": "node-${index + 1}"`);
      } else if (typeof node.id !== "string") {
        add("ir/type", `node id must be a string, got ${typeName(node.id)}`, `${path}.id`, `use a lowercase string id, e.g. "id": "node-${index + 1}"`);
      } else {
        if (!ID_RE.test(node.id)) {
          add(
            "ir/node-id-format",
            `node id "${shown(node.id)}" does not match ${ID_PATTERN}`,
            `${path}.id`,
            'use lowercase kebab-case: start with a letter, then a-z, 0-9 or "-", max 32 characters — e.g. "api-gateway"',
          );
        }
        if (node.id.length > 0) {
          if (nodeIds.has(node.id)) {
            add(
              "ir/duplicate-id",
              `duplicate node id "${node.id}"`,
              `${path}.id`,
              `node "${node.id}" is already defined; give every node a unique id (this is occurrence ${nodeIndexById.has(node.id) ? "2 or more" : "2"})`,
            );
          } else {
            nodeIds.add(node.id);
            nodeIndexById.set(node.id, index);
          }
        }
      }

      // label
      if (!has(node, "label")) {
        add("ir/required", 'node is missing its "label"', `${path}.label`, `add a human label, e.g. "label": "${node.id && typeof node.id === "string" ? node.id : "Web App"}"`);
      } else if (typeof node.label !== "string") {
        add("ir/type", `node label must be a string, got ${typeName(node.label)}`, `${path}.label`, 'use a short human string, e.g. "label": "Web App"');
      } else {
        const length = chars(node.label.trim());
        if (length === 0) {
          add("ir/label-length", "node label is empty", `${path}.label`, 'write a short human label, 1..80 characters, e.g. "label": "Web App"');
        } else if (length > LIMITS.nodeLabelMax) {
          add(
            "ir/label-length",
            `node label is ${length} characters, maximum is ${LIMITS.nodeLabelMax}`,
            `${path}.label`,
            `shorten "label" to at most ${LIMITS.nodeLabelMax} characters (currently ${length}); move detail into "sublabel"`,
          );
        } else if (length > LIMITS.nodeLabelSoft) {
          warn(
            "ir/node-label-long",
            `node label is ${length} characters; labels over ${LIMITS.nodeLabelSoft} may wrap or clip in the card`,
            `${path}.label`,
          );
        }
      }

      // sublabel
      if (has(node, "sublabel")) {
        if (typeof node.sublabel !== "string") {
          add("ir/type", `node sublabel must be a string, got ${typeName(node.sublabel)}`, `${path}.sublabel`, 'use a short string, e.g. "sublabel": "React, edge-cached"');
        } else {
          const length = chars(node.sublabel.trim());
          if (length > LIMITS.sublabelSoft) {
            warn(
              "ir/sublabel-long",
              `sublabel is ${length} characters; sublabels over ${LIMITS.sublabelSoft} may clip`,
              `${path}.sublabel`,
            );
          }
        }
      }

      // kind (required for the legacy types; v1.2 types have sensible defaults)
      if (!has(node, "kind")) {
        if (diagramType === null || ["architecture", "workflow", "sequence"].includes(diagramType)) {
          add("ir/required", 'node is missing its "kind"', `${path}.kind`, `add "kind": "service" — one of: ${NODE_KINDS.join(", ")}`);
        }
      } else if (typeof node.kind !== "string") {
        add("ir/type", `node kind must be a string, got ${typeName(node.kind)}`, `${path}.kind`, `use one of: ${NODE_KINDS.join(", ")}`);
      } else if (!NODE_KINDS.includes(node.kind)) {
        add(
          "ir/unknown-kind",
          `unknown node kind "${shown(node.kind)}"`,
          `${path}.kind`,
          `use one of: ${NODE_KINDS.join(", ")} (service = app/API, datastore = db/cache, actor = human, external = third party, queue = broker, compute = worker, security = auth/gateway, state = step/status, note = annotation)`,
        );
      }

      // status (v1.0 diff artifacts)
      if (has(node, "status")) {
        if (typeof node.status !== "string") {
          add("ir/type", `node status must be a string, got ${typeName(node.status)}`, `${path}.status`, `use one of: ${STATUSES.join(", ")}`);
        } else if (!STATUSES.includes(node.status)) {
          add("ir/unknown-kind", `unknown node status "${shown(node.status)}"`, `${path}.status`, `use one of: ${STATUSES.join(", ")} (added/removed/changed; omit it for unchanged nodes)`);
        }
      }

      // group (cross-checked after groups are parsed)
      if (has(node, "group")) {
        if (typeof node.group !== "string") {
          add("ir/type", `node group must be a string, got ${typeName(node.group)}`, `${path}.group`, 'use the id of a declared group, e.g. "group": "edge"');
        } else if (node.group.length > 0 && typeof node.id === "string" && node.id.length > 0) {
          nodeGroupOf.set(node.id, node.group);
        }
      }
    });
  }

  // ---- edges -------------------------------------------------------------
  /** @type {Set<string>} */
  const edgeKeys = new Set();
  if (has(ir, "edges")) {
    if (!Array.isArray(ir.edges)) {
      add("ir/type", `"edges" must be an array, got ${typeName(ir.edges)}`, "edges", 'use an array of edge objects: "edges": [{ "from": "web", "to": "api", "kind": "main" }]');
    } else {
      if (ir.edges.length > LIMITS.edgesMax) {
        add(
          "ir/edges-count",
          `too many edges: ${ir.edges.length}, maximum is ${LIMITS.edgesMax}`,
          "edges",
          `remove ${ir.edges.length - LIMITS.edgesMax} edge(s) or split the diagram (max ${LIMITS.edgesMax} edges)`,
        );
      }
      const knownIds = [...nodeIds];
      const idPreview = knownIds.length === 0
        ? "(no nodes declared)"
        : knownIds.slice(0, 8).join(", ") + (knownIds.length > 8 ? ", ..." : "");

      ir.edges.forEach((edge, index) => {
        const path = `edges[${index}]`;
        if (!isObj(edge)) {
          add("ir/type", `edge ${index} must be an object, got ${typeName(edge)}`, path, 'each edge looks like { "from": "web", "to": "api", "label": "GET /cart", "kind": "main" }');
          return;
        }

        for (const key of Object.keys(edge)) {
          if (!EDGE_KEYS.includes(key)) {
            add("ir/unknown-key", `unknown edge key "${key}"`, `${path}.${key}`, unknownKeyHint(key, EDGE_KEYS, "an edge"));
          }
        }

        let from = null;
        let to = null;
        for (const key of ["from", "to"]) {
          if (!has(edge, key)) {
            add("ir/required", `edge is missing "${key}"`, `${path}.${key}`, `add "${key}": "<node-id>" referencing a node defined in "nodes"`);
          } else if (typeof edge[key] !== "string") {
            add("ir/type", `edge "${key}" must be a string, got ${typeName(edge[key])}`, `${path}.${key}`, 'use a node id string, e.g. "from": "web"');
          } else if (edge[key].length === 0) {
            add("ir/dangling-ref", `edge "${key}" is empty`, `${path}.${key}`, `set "${key}" to an existing node id, e.g. ${knownIds[0] ? `"${knownIds[0]}"` : '"web"'}`);
          } else if (!nodeIds.has(edge[key])) {
            add(
              "ir/dangling-ref",
              `edge "${key}" references unknown node "${shown(edge[key])}"`,
              `${path}.${key}`,
              `add a node with id "${edge[key]}" to "nodes", or point "${key}" at an existing id — existing nodes: ${idPreview}`,
            );
          } else if (key === "from") {
            from = edge.from;
          } else {
            to = edge.to;
          }
        }
        if (from !== null && to === null && typeof edge.to === "string" && nodeIds.has(edge.to)) to = edge.to;
        if (from !== null && to !== null && from === to) {
          add(
            "ir/self-edge",
            `edge points from "${from}" to itself`,
            path,
            "self-edges are not supported; remove the edge, or route it through an intermediate node",
          );
        }

        if (!has(edge, "kind")) {
          // v1.2 types default their relation kind (association/main/transition)
          if (diagramType === null || ["architecture", "workflow", "sequence"].includes(diagramType)) {
            add("ir/required", 'edge is missing its "kind"', `${path}.kind`, `add "kind": "main" — one of: ${EDGE_KINDS.join(", ")}`);
          }
        } else if (typeof edge.kind !== "string") {
          add("ir/type", `edge kind must be a string, got ${typeName(edge.kind)}`, `${path}.kind`, `use one of: ${EDGE_KINDS.join(", ")}`);
        } else if (!EDGE_KINDS.includes(edge.kind) && !(diagramType === "class" && CLASS_EDGE_KINDS.includes(edge.kind))) {
          add(
            "ir/unknown-kind",
            `unknown edge kind "${shown(edge.kind)}"`,
            `${path}.kind`,
            `use one of: ${EDGE_KINDS.join(", ")} (main = request, return = response, async = fire-and-forget, security = auth, message = sequence message, data = db/cache I/O)`,
          );
        }

        if (has(edge, "label")) {
          if (typeof edge.label !== "string") {
            add("ir/type", `edge label must be a string, got ${typeName(edge.label)}`, `${path}.label`, 'use a short string, e.g. "label": "GET /cart", or omit the label');
          } else {
            const length = chars(edge.label.trim());
            if (length > LIMITS.edgeLabelSoft) {
              warn(
                "ir/edge-label-long",
                `edge label is ${length} characters; long labels may overlap the diagram (soft limit ${LIMITS.edgeLabelSoft})`,
                `${path}.label`,
              );
            }
          }
        }

        if (from !== null && to !== null) {
          const label = typeof edge.label === "string" ? edge.label.trim() : "";
          const edgeKey = `${from}\u0000${to}\u0000${label}`;
          if (edgeKeys.has(edgeKey)) {
            add(
              "ir/duplicate-edge",
              `duplicate edge "${from}" → "${to}"${label ? ` with label "${label}"` : ""}`,
              path,
              'remove the duplicate edge, or change its label so every (from, to, label) triple is unique',
            );
          } else {
            edgeKeys.add(edgeKey);
          }
        }
      });
    }
  }

  // ---- groups ------------------------------------------------------------
  /** @type {Set<string>} */
  const groupIds = new Set();
  /** node id -> group id it is listed in (from group.nodes) */
  const memberOf = new Map();

  if (has(ir, "groups")) {
    if (!Array.isArray(ir.groups)) {
      add("ir/type", `"groups" must be an array, got ${typeName(ir.groups)}`, "groups", 'use an array of group objects: "groups": [{ "id": "edge", "label": "Edge", "kind": "zone", "nodes": ["web"] }]');
    } else {
      ir.groups.forEach((group, index) => {
        const path = `groups[${index}]`;
        if (!isObj(group)) {
          add("ir/type", `group ${index} must be an object, got ${typeName(group)}`, path, 'each group looks like { "id": "edge", "label": "Edge", "kind": "zone", "nodes": ["web"] }');
          return;
        }

        for (const key of Object.keys(group)) {
          if (!GROUP_KEYS.includes(key)) {
            add("ir/unknown-key", `unknown group key "${key}"`, `${path}.${key}`, unknownKeyHint(key, GROUP_KEYS, "a group"));
          }
        }

        // id
        if (!has(group, "id")) {
          add("ir/required", 'group is missing its "id"', `${path}.id`, `add a unique lowercase id, e.g. "id": "group-${index + 1}"`);
        } else if (typeof group.id !== "string") {
          add("ir/type", `group id must be a string, got ${typeName(group.id)}`, `${path}.id`, `use a lowercase string id, e.g. "id": "group-${index + 1}"`);
        } else {
          if (!ID_RE.test(group.id)) {
            add(
              "ir/group-id-format",
              `group id "${shown(group.id)}" does not match ${ID_PATTERN}`,
              `${path}.id`,
              'use lowercase kebab-case: start with a letter, then a-z, 0-9 or "-", max 32 characters — e.g. "edge"',
            );
          }
          if (group.id.length > 0) {
            if (groupIds.has(group.id)) {
              add("ir/duplicate-id", `duplicate group id "${group.id}"`, `${path}.id`, `group "${group.id}" is already defined; give every group a unique id`);
            } else {
              groupIds.add(group.id);
            }
          }
        }

        // kind (optional, defaults to "zone" in the scene)
        let groupKind = "zone";
        if (has(group, "kind")) {
          if (typeof group.kind !== "string") {
            add("ir/type", `group kind must be a string, got ${typeName(group.kind)}`, `${path}.kind`, `use one of: ${GROUP_KINDS.join(", ")}`);
          } else if (!GROUP_KINDS.includes(group.kind)) {
            add("ir/unknown-kind", `unknown group kind "${shown(group.kind)}"`, `${path}.kind`, `use one of: ${GROUP_KINDS.join(", ")} (zone/boundary = box around nodes, fragment = loop/alt band in a sequence)`);
          } else {
            groupKind = group.kind;
            if (group.kind === "fragment" && diagramType !== null && diagramType !== "sequence") {
              add(
                "ir/fragment-non-sequence",
                `group "${group.id ?? index}" has kind "fragment" but the diagram type is "${diagramType}"`,
                `${path}.kind`,
                'fragment bands only exist in sequence diagrams; use kind "zone" or "boundary" here, or change "type" to "sequence"',
              );
            }
          }
        }

        // label
        if (!has(group, "label")) {
          add("ir/required", 'group is missing its "label"', `${path}.label`, `add a short human label, e.g. "label": "Edge / CDN"`);
        } else if (typeof group.label !== "string") {
          add("ir/type", `group label must be a string, got ${typeName(group.label)}`, `${path}.label`, 'use a short human string, e.g. "label": "Edge / CDN"');
        } else {
          const length = chars(group.label.trim());
          if (length === 0) {
            add("ir/label-length", "group label is empty", `${path}.label`, 'write a short group label, 1..80 characters, e.g. "label": "Edge / CDN"');
          } else if (length > LIMITS.groupLabelMax) {
            add(
              "ir/label-length",
              `group label is ${length} characters, maximum is ${LIMITS.groupLabelMax}`,
              `${path}.label`,
              `shorten the group label to at most ${LIMITS.groupLabelMax} characters (currently ${length})`,
            );
          }
        }

        // nodes membership
        const fragment = groupKind === "fragment";
        if (!has(group, "nodes")) {
          add("ir/required", 'group is missing its "nodes" list', `${path}.nodes`, 'add at least one node id: "nodes": ["web"]');
        } else if (!Array.isArray(group.nodes)) {
          add("ir/type", `group "nodes" must be an array, got ${typeName(group.nodes)}`, `${path}.nodes`, 'use an array of node ids, e.g. "nodes": ["web", "api"]');
        } else {
          if (group.nodes.length === 0) {
            add("ir/group-empty", "group has an empty \"nodes\" list", `${path}.nodes`, 'add at least one node id, or remove the group entirely: "nodes": ["web"]');
          }
          group.nodes.forEach((nodeId, memberIndex) => {
            const memberPath = `${path}.nodes[${memberIndex}]`;
            if (typeof nodeId !== "string") {
              add("ir/type", `group node reference must be a string, got ${typeName(nodeId)}`, memberPath, 'use a node id string, e.g. "web"');
              return;
            }
            if (!nodeIds.has(nodeId)) {
              add(
                "ir/group-subset",
                `group references unknown node "${shown(nodeId)}"`,
                memberPath,
                `add a node with id "${nodeId}", or use one of the nodes that exist — group members must come from "nodes"`,
              );
              return;
            }
            if (fragment) {
              // Fragment groups in a sequence may only reference participants.
              // In a sequence every node is a participant by contract, so the
              // subset check above is the whole rule; nothing extra to reject.
            }
            const previousGroup = memberOf.get(nodeId);
            if (previousGroup !== undefined) {
              add(
                "ir/group-duplicate-node",
                previousGroup === group.id
                  ? `node "${nodeId}" is listed twice in group "${group.id}"`
                  : `node "${nodeId}" is already in group "${previousGroup}"`,
                memberPath,
                'a node may belong to at most one group; remove it from one of the groups',
              );
            } else {
              memberOf.set(nodeId, group.id);
            }
          });
        }
      });
    }
  }

  // ---- node.group <-> group.nodes consistency (soft: helps catch drift) --
  for (const [nodeId, declaredGroup] of nodeGroupOf) {
    const nodePath = `nodes[${nodeIndexById.get(nodeId)}].group`;
    if (!groupIds.has(declaredGroup)) {
      const available = groupIds.size === 0 ? "(no groups declared)" : [...groupIds].join(", ");
      add(
        "ir/unknown-group",
        `node "${nodeId}" belongs to unknown group "${shown(declaredGroup)}"`,
        nodePath,
        `add a group with id "${declaredGroup}" to "groups", or point "group" at a declared group — available groups: ${available}`,
      );
      continue;
    }
    if (memberOf.has(nodeId) && memberOf.get(nodeId) !== declaredGroup) {
      warn(
        "ir/group-mismatch",
        `node "${nodeId}" declares group "${declaredGroup}" but is listed in group "${memberOf.get(nodeId)}"`,
        nodePath,
      );
    } else if (!memberOf.has(nodeId)) {
      warn(
        "ir/group-mismatch",
        `node "${nodeId}" declares group "${declaredGroup}" but group "${declaredGroup}".nodes does not list it`,
        nodePath,
      );
    }
  }

  // ---- walkthrough (v1.0) -----------------------------------------------
  if (has(ir, "walkthrough")) {
    if (!Array.isArray(ir.walkthrough)) {
      add("ir/type", `"walkthrough" must be an array of steps, got ${typeName(ir.walkthrough)}`, "walkthrough", 'use an array of steps: {"title": "...", "text": "...", "focus": ["node-id"]}');
    } else {
      if (ir.walkthrough.length === 0) {
        add("ir/walkthrough-count", "walkthrough is empty", "walkthrough", "remove the walkthrough key or add at least one step");
      } else if (ir.walkthrough.length > WALKTHROUGH_LIMITS.steps) {
        add("ir/walkthrough-count", `too many walkthrough steps: ${ir.walkthrough.length}, maximum is ${WALKTHROUGH_LIMITS.steps}`, "walkthrough", `keep the ${WALKTHROUGH_LIMITS.steps} steps that matter most; a longer tour stops being a tour`);
      }
      ir.walkthrough.forEach((step, index) => {
        const stepPath = `walkthrough[${index}]`;
        if (step === null || typeof step !== "object" || Array.isArray(step)) {
          add("ir/type", `walkthrough step ${index} must be an object`, stepPath, 'each step is {"title": "...", "text": "...", "focus": ["node-id"]}');
          return;
        }
        for (const key of Object.keys(step)) {
          if (!["title", "text", "focus"].includes(key)) {
            add("ir/unknown-key", `unknown walkthrough key "${key}"`, `${stepPath}.${key}`, 'a walkthrough step accepts only "title", "text" and "focus"');
          }
        }
        if (typeof step.title !== "string" || chars(step.title.trim()) < WALKTHROUGH_LIMITS.titleMin) {
          add("ir/walkthrough-text", `walkthrough step ${index} needs a short "title"`, `${stepPath}.title`, 'add "title": "Request arrives" (1..60 characters)');
        } else if (chars(step.title.trim()) > WALKTHROUGH_LIMITS.titleMax) {
          add("ir/walkthrough-text", `walkthrough title is ${chars(step.title.trim())} characters, maximum is ${WALKTHROUGH_LIMITS.titleMax}`, `${stepPath}.title`, "shorten the step title");
        }
        if (typeof step.text !== "string" || chars(step.text.trim()) < WALKTHROUGH_LIMITS.textMin) {
          add("ir/walkthrough-text", `walkthrough step ${index} needs "text"`, `${stepPath}.text`, 'add "text": "The agent writes a typed candidate and runs the CLI." (1..220 characters)');
        } else if (chars(step.text.trim()) > WALKTHROUGH_LIMITS.textMax) {
          add("ir/walkthrough-text", `walkthrough text is ${chars(step.text.trim())} characters, maximum is ${WALKTHROUGH_LIMITS.textMax}`, `${stepPath}.text`, "shorten the step text");
        }
        if (!Array.isArray(step.focus)) {
          add("ir/walkthrough-focus", `walkthrough step ${index} needs a "focus" array of node ids`, `${stepPath}.focus`, 'list the nodes this step is about: "focus": ["agent", "cli"]');
        } else if (step.focus.length < WALKTHROUGH_LIMITS.focusMin || step.focus.length > WALKTHROUGH_LIMITS.focusMax) {
          add("ir/walkthrough-focus", `walkthrough step ${index} focuses ${step.focus.length} node(s), expected ${WALKTHROUGH_LIMITS.focusMin}..${WALKTHROUGH_LIMITS.focusMax}`, `${stepPath}.focus`, "focus 1..6 nodes per step");
        } else {
          step.focus.forEach((id, focusIndex) => {
            if (typeof id !== "string" || !nodeIds.has(id)) {
              add("ir/walkthrough-focus", `walkthrough step ${index} focuses unknown node ${shown(id)}`, `${stepPath}.focus[${focusIndex}]`, `use a node id that exists in "nodes" (known ids: ${[...nodeIds].slice(0, 8).join(", ")})`);
            }
          });
        }
      });
    }
  }

  // ---- per-type rules (v1.2) --------------------------------------------
  if (diagramType !== null && has(ir, "nodes") && Array.isArray(ir.nodes)) {
    const nodeList = ir.nodes.filter((n) => n && typeof n === "object" && !Array.isArray(n));
    const byId = new Map();
    nodeList.forEach((n) => { if (typeof n.id === "string") byId.set(n.id, n); });

    if (diagramType === "erd") {
      nodeList.forEach((node, index) => {
        const path = `nodes[${index}]`;
        if (!has(node, "attributes")) {
          add("ir/erd-attributes", `entity "${shown(node.id)}" has no attributes`, `${path}.attributes`, 'add "attributes": [{"name": "id", "type": "uuid", "key": "pk"}] (1..12 rows) — an ERD table without columns is not a table');
          return;
        }
        if (!Array.isArray(node.attributes)) {
          add("ir/type", '"attributes" must be an array', `${path}.attributes`, "use an array of column objects");
          return;
        }
        if (node.attributes.length < 1 || node.attributes.length > 12) {
          add("ir/erd-attributes", `entity "${shown(node.id)}" has ${node.attributes.length} attribute(s), expected 1..12`, `${path}.attributes`, "keep 1..12 of the columns that matter; ERDs of 40 columns do not read");
        }
        node.attributes.forEach((attr, ai) => {
          const apath = `${path}.attributes[${ai}]`;
          if (attr === null || typeof attr !== "object" || Array.isArray(attr)) {
            add("ir/type", `attribute ${ai} must be an object`, apath, 'use {"name": "id", "type": "uuid", "key": "pk"}');
            return;
          }
          if (typeof attr.name !== "string" || !attr.name.trim()) add("ir/erd-attributes", `attribute ${ai} needs a "name"`, `${apath}.name`, 'add "name": "customer_id"');
          if (typeof attr.type !== "string" || !attr.type.trim()) add("ir/erd-attributes", `attribute ${ai} needs a "type"`, `${apath}.type`, 'add a SQL-ish type, e.g. "uuid", "text", "timestamptz", "int4"');
          if (has(attr, "key") && attr.key !== null && !ATTRIBUTE_KEYS.includes(attr.key)) {
            add("ir/unknown-kind", `unknown attribute key "${shown(attr.key)}"`, `${apath}.key`, `use one of: ${ATTRIBUTE_KEYS.join(", ")} or omit it`);
          }
          if (has(attr, "ref")) {
            const ref = attr.ref;
            if (typeof ref !== "string" || !/^[a-z][a-z0-9-]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
              add("ir/erd-ref", `attribute ${ai} ref must be "entity.attribute"`, `${apath}.ref`, 'write the target as "customers.id"');
            } else {
              const [entityId, column] = ref.split(".");
              const target = byId.get(entityId);
              if (!target) add("ir/erd-ref", `attribute ${ai} references unknown entity "${entityId}"`, `${apath}.ref`, "reference an entity declared in this diagram");
              else if (!Array.isArray(target.attributes) || !target.attributes.some((a) => a && a.name === column)) {
                add("ir/erd-ref", `attribute ${ai} references unknown column "${entityId}.${column}"`, `${apath}.ref`, "reference a column declared in that entity");
              }
            }
          }
        });
      });
      (Array.isArray(ir.edges) ? ir.edges : []).forEach((edge, ei) => {
        if (!edge || typeof edge !== "object") return;
        if (!has(edge, "cardinality")) {
          add("ir/erd-cardinality", `relationship ${ei} needs a cardinality`, `edges[${ei}].cardinality`, `add "cardinality": "1:n" — one of ${CARDINALITIES.join(", ")}`);
        } else if (!CARDINALITIES.includes(edge.cardinality)) {
          add("ir/unknown-kind", `unknown cardinality "${shown(edge.cardinality)}"`, `edges[${ei}].cardinality`, `use one of: ${CARDINALITIES.join(", ")}`);
        }
      });
    }

    if (diagramType === "class") {
      nodeList.forEach((node, index) => {
        const path = `nodes[${index}]`;
        if (has(node, "members")) {
          if (!Array.isArray(node.members)) add("ir/type", '"members" must be an array of strings', `${path}.members`, 'use ["+ charge(): Receipt", "- retry: int"]');
          else {
            if (node.members.length > 12) add("ir/class-members", `class "${shown(node.id)}" has ${node.members.length} members, maximum is 12`, `${path}.members`, "keep the 12 members that explain the type");
            node.members.forEach((member, mi) => {
              if (typeof member !== "string") add("ir/type", `member ${mi} must be a string`, `${path}.members[${mi}]`, 'write members as strings, e.g. "+ charge(amount): Receipt"');
              else if (chars(member.trim()) > 60) add("ir/class-members", `member ${mi} is ${chars(member.trim())} characters, maximum is 60`, `${path}.members[${mi}]`, "shorten the signature to the part that matters");
            });
          }
        }
        if (has(node, "stereotype") && !STEREOTYPES.includes(node.stereotype)) {
          add("ir/unknown-kind", `unknown stereotype "${shown(node.stereotype)}"`, `${path}.stereotype`, `use one of: ${STEREOTYPES.join(", ")} or omit it`);
        }
      });
      (Array.isArray(ir.edges) ? ir.edges : []).forEach((edge, ei) => {
        const kind = edge && edge.kind;
        if (kind !== undefined && kind !== null && !CLASS_EDGE_KINDS.includes(kind) && !EDGE_KINDS.includes(kind)) {
          add("ir/unknown-kind", `unknown class relation "${shown(kind)}"`, `edges[${ei}].kind`, `use one of: ${CLASS_EDGE_KINDS.join(", ")} (default is association)`);
        }
      });
    }

    if (diagramType === "tree") {
      const incoming = new Map(nodeList.map((n) => [n.id, 0]));
      (Array.isArray(ir.edges) ? ir.edges : []).forEach((edge) => {
        if (edge && typeof edge.to === "string" && incoming.has(edge.to)) incoming.set(edge.to, incoming.get(edge.to) + 1);
      });
      const roots = nodeList.filter((n) => incoming.get(n.id) === 0);
      const multi = nodeList.filter((n) => incoming.get(n.id) > 1);
      if (multi.length) add("ir/tree-parents", `tree nodes with more than one parent: ${multi.map((n) => shown(n.id)).join(", ")}`, "edges", "a tree needs exactly one parent per node; use \"architecture\" or \"workflow\" for a general graph");
      if (roots.length !== 1) add("ir/tree-root", `tree needs exactly one root, found ${roots.length}`, "edges", roots.length === 0 ? "the graph has a cycle — remove one parent edge" : `keep exactly one root (${roots.map((n) => shown(n.id)).join(", ")} have no parent)`);
      // cycle + reachability
      const adjacency = new Map(nodeList.map((n) => [n.id, []]));
      (Array.isArray(ir.edges) ? ir.edges : []).forEach((edge) => { if (edge && adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to); });
      if (roots.length === 1) {
        const seen = new Set([roots[0].id]);
        const queue = [roots[0].id];
        while (queue.length) { const id = queue.shift(); for (const next of adjacency.get(id) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
        const unreachable = nodeList.filter((n) => !seen.has(n.id)).map((n) => shown(n.id));
        if (unreachable.length) add("ir/tree-reachable", `tree nodes not reachable from the root: ${unreachable.join(", ")}`, "edges", "connect every node to the root, or remove the orphan");
      }
    }

    if (diagramType === "timeline") {
      if (nodeList.length < 2) add("ir/timeline-events", `timeline needs at least 2 events, got ${nodeList.length}`, "nodes", "a timeline of one event is a sentence");
      nodeList.forEach((node, index) => {
        const path = `nodes[${index}]`;
        if (!has(node, "at")) add("ir/timeline-at", `event "${shown(node.id)}" has no "at"`, `${path}.at`, 'add "at": "2026-03-01" (ISO date) or a number');
        else if (typeof node.at === "number") { if (!Number.isFinite(node.at)) add("ir/timeline-at", `event "${shown(node.id)}" has a non-finite "at"`, `${path}.at`, "use a finite number"); }
        else if (typeof node.at === "string") { if (!/^\d{4}-\d{2}-\d{2}/.test(node.at) || Number.isNaN(Date.parse(node.at))) add("ir/timeline-at", `event "${shown(node.id)}" has an invalid date "${shown(node.at)}"`, `${path}.at`, 'use an ISO date like "2026-03-01"; every event needs one'); }
        else add("ir/type", `"at" must be a date string or a number, got ${typeName(node.at)}`, `${path}.at`, 'use "at": "2026-03-01" or "at": 3.5');
      });
    }

    if (diagramType === "waterfall") {
      nodeList.forEach((node, index) => {
        const path = `nodes[${index}]`;
        if (!has(node, "start") || typeof node.start !== "number" || !Number.isFinite(node.start) || node.start < 0) {
          add("ir/waterfall-span", `span "${shown(node.id)}" needs a numeric "start" >= 0`, `${path}.start`, 'add "start": 0 (the beginning of the run)');
        }
        if (!has(node, "duration") || typeof node.duration !== "number" || !Number.isFinite(node.duration) || node.duration <= 0) {
          add("ir/waterfall-span", `span "${shown(node.id)}" needs a numeric "duration" > 0`, `${path}.duration`, 'add "duration": 120 (same unit as start, e.g. ms)');
        }
      });
    }
  }

  // ---- notes -------------------------------------------------------------
  if (has(ir, "notes")) {
    if (!Array.isArray(ir.notes)) {
      add("ir/type", `"notes" must be an array of strings, got ${typeName(ir.notes)}`, "notes", 'use an array, e.g. "notes": ["Cache-miss path is the slow path."]');
    } else {
      if (ir.notes.length > LIMITS.notesMax) {
        add(
          "ir/notes-count",
          `too many notes: ${ir.notes.length}, maximum is ${LIMITS.notesMax}`,
          "notes",
          `keep the ${LIMITS.notesMax} most useful notes and delete ${ir.notes.length - LIMITS.notesMax}`,
        );
      }
      ir.notes.forEach((note, index) => {
        const path = `notes[${index}]`;
        if (typeof note !== "string") {
          add("ir/type", `note ${index} must be a string, got ${typeName(note)}`, path, 'each note is a plain string, e.g. "Cache-miss path is the slow path."');
          return;
        }
        const length = chars(note.trim());
        if (length > LIMITS.noteMax) {
          add(
            "ir/note-length",
            `note is ${length} characters, maximum is ${LIMITS.noteMax}`,
            path,
            `shorten the note to at most ${LIMITS.noteMax} characters (currently ${length})`,
          );
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
