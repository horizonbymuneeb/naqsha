// Structural lint for a Naqsha IR document.
//
// `validate` answers "is this a legal diagram?" — `lint` answers "is this a *good*
// diagram?". Findings are advisory except for the ones that make a diagram
// meaningless (duplicate ids, edges that point at nothing, no nodes at all).
//
// Zero dependencies. Exit-code friendly: ok === false only when there is an error.

const DEFAULT_MAX_NODES = 40;
const DIRECTED_TYPES = new Set(["workflow", "sequence", "dataflow", "tree"]);
const CYCLE_TYPES = new Set(["workflow", "sequence"]);

const finding = (code, severity, message, at, hint) => ({ code, severity, message, path: at, hint });

function findByIds(nodes) {
  const ids = new Map();
  for (const [index, node] of nodes.entries()) {
    const id = node && typeof node.id === "string" ? node.id : null;
    if (id === null) continue;
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(index);
  }
  return ids;
}

function edgeEndpoints(edge, index) {
  const from = edge && typeof edge.from === "string" ? edge.from : null;
  const to = edge && typeof edge.to === "string" ? edge.to : null;
  return { from, to, index };
}

/** Reachable-from-roots set for directed graphs (roots = in-degree 0). */
function reachable(nodes, edges) {
  const outgoing = new Map();
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
    if (indegree.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  // A graph with no roots is fully cyclic: everything is "reachable" for our purpose.
  if (seen.size === 0) return new Set(nodes.map((n) => n.id));
  return seen;
}

/** Nodes that participate in at least one cycle (Tarjan-lite via DFS colours). */
function cyclicNodes(nodes, edges) {
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const state = new Map(); // 0 = unvisited, 1 = in stack, 2 = done
  const inCycle = new Set();
  const stack = [];

  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of outgoing.get(id) || []) {
      const s = state.get(next) || 0;
      if (s === 0) {
        visit(next);
      } else if (s === 1) {
        const start = stack.lastIndexOf(next);
        for (const member of stack.slice(start)) inCycle.add(member);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const node of nodes) {
    if ((state.get(node.id) || 0) === 0) visit(node.id);
  }
  return inCycle;
}

/**
 * Lint an IR document.
 *
 * @param {object} ir parsed IR (already validated, or not — lint is tolerant)
 * @param {{maxNodes?: number}} [options]
 * @returns {{ok: boolean, errors: object[], warnings: object[], stats: object}}
 */
export function lint(ir, options = {}) {
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : DEFAULT_MAX_NODES;
  const errors = [];
  const warnings = [];

  const nodes = Array.isArray(ir && ir.nodes) ? ir.nodes.filter((n) => n && typeof n === "object") : [];
  const edges = Array.isArray(ir && ir.edges) ? ir.edges.filter((e) => e && typeof e === "object") : [];
  const type = ir && typeof ir.type === "string" ? ir.type : "architecture";

  if (nodes.length === 0) {
    errors.push(finding("lint/empty-graph", "error", "the diagram has no nodes", "nodes", "add at least one node: { \"id\": \"a\", \"label\": \"A\" }"));
  }

  const byId = findByIds(nodes);
  for (const [id, indexes] of byId.entries()) {
    if (indexes.length > 1) {
      errors.push(
        finding(
          "lint/duplicate-id",
          "error",
          `node id "${id}" is used ${indexes.length} times`,
          `nodes[${indexes.join("], nodes[")}]`,
          "ids must be unique — edges and links resolve by id",
        ),
      );
    }
  }

  const known = new Set(byId.keys());
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const [index, edge] of edges.entries()) {
    const { from, to } = edgeEndpoints(edge, index);
    if (from === null || to === null) {
      errors.push(finding("lint/edge-shape", "error", `edge ${index} needs string "from" and "to"`, `edges[${index}]`, 'use { "from": "a", "to": "b" }'));
      continue;
    }
    if (!known.has(from)) {
      errors.push(finding("lint/dangling-edge", "error", `edge ${index} starts at unknown node "${from}"`, `edges[${index}].from`, "every edge endpoint must be a node id"));
    }
    if (!known.has(to)) {
      errors.push(finding("lint/dangling-edge", "error", `edge ${index} ends at unknown node "${to}"`, `edges[${index}].to`, "every edge endpoint must be a node id"));
    }
    if (from === to) {
      warnings.push(finding("lint/self-loop", "warning", `node "${from}" has an edge to itself`, `edges[${index}]`, "self loops are usually a modelling mistake; remove it or add a note"));
    }
    if (degree.has(from)) degree.set(from, degree.get(from) + 1);
    if (degree.has(to)) degree.set(to, degree.get(to) + 1);
  }

  const labelledEdges = edges.filter((e) => typeof e.label === "string" && e.label.trim() !== "").length;
  const labelEdges = labelledEdges > 0;

  for (const [index, node] of nodes.entries()) {
    const id = node.id;
    const label = typeof node.label === "string" ? node.label.trim() : "";
    if (label === "") {
      warnings.push(finding("lint/unlabeled-node", "warning", `node "${id}" has no label`, `nodes[${index}].label`, "labels are what a reader sees; the id stays internal"));
    } else if (label === id && /^[a-z0-9_-]+$/i.test(id)) {
      warnings.push(finding("lint/label-is-id", "warning", `node "${id}" uses its id as the label`, `nodes[${index}].label`, "write a human label: \"Web App\" rather than \"web_app\""));
    }
  }

  if (labelEdges) {
    for (const [index, edge] of edges.entries()) {
      const label = typeof edge.label === "string" ? edge.label.trim() : "";
      if (label === "") {
        warnings.push(finding("lint/unlabeled-edge", "warning", `edge ${index} (${edge.from} → ${edge.to}) has no label`, `edges[${index}].label`, "when some edges are labelled, all of them should be"));
      }
    }
  }

  if (edges.length > 0) {
    for (const [index, node] of nodes.entries()) {
      if ((degree.get(node.id) || 0) === 0) {
        warnings.push(finding("lint/orphan-node", "warning", `node "${node.id}" is not connected to anything`, `nodes[${index}]`, "connect it with an edge or remove it"));
      }
    }
  }

  if (DIRECTED_TYPES.has(type) && nodes.length > 1 && edges.length > 0) {
    const fromSet = new Set(edges.map((e) => e.from));
    const reach = reachable(nodes.filter((n) => fromSet.has(n.id) || degree.get(n.id) > 0), edges);
    for (const [index, node] of nodes.entries()) {
      if (!reach.has(node.id) && (degree.get(node.id) || 0) > 0) {
        warnings.push(finding("lint/unreachable-node", "warning", `node "${node.id}" cannot be reached from any entry node`, `nodes[${index}]`, "add an edge from a root node, or remove it"));
      }
    }
  }

  if (CYCLE_TYPES.has(type) && edges.length > 0) {
    const cyclic = cyclicNodes(nodes.filter((n) => known.has(n.id)), edges.filter((e) => known.has(e.from) && known.has(e.to)));
    for (const id of cyclic) {
      warnings.push(finding("lint/cycle", "warning", `node "${id}" is part of a cycle`, "nodes", "workflow and sequence diagrams read top-to-bottom; a cycle usually means two edges point the wrong way"));
    }
  }

  if (nodes.length > maxNodes) {
    warnings.push(
      finding("lint/too-many-nodes", "warning", `${nodes.length} nodes is more than ${maxNodes}; the diagram will be hard to read`, "nodes", "split it into two diagrams, or raise the limit with --max-nodes"),
    );
  }

  const stats = {
    type,
    nodes: nodes.length,
    edges: edges.length,
    errors: errors.length,
    warnings: warnings.length,
  };

  return { ok: errors.length === 0, errors, warnings, stats };
}

export default lint;
