// Naqsha v1.0 — diagram diff + path tracing (owner: diff).
//
// Zero dependencies, deterministic, no I/O. Contract: src/CONTRACT.md
// §"v1.0 additions" (normative).
//
//   diff(irBase, irHead) -> { ir, summary, changes }
//   shortestPath(ir, fromId, toId) -> { ok, path, edges, hops, reason }
//
// The merged IR is a valid IR v1.1: nodes/edges carry `status` only for
// entities that changed relative to the base, groups come from head plus base
// groups that still hold removed members, and the head title/subtitle gain a
// " (diff)" marker.
//
// Determinism: merged entity order is base declaration order (all base
// entities, including removed ones, stay at their original slot) followed by
// added entities in head declaration order. `changes` follows the same order,
// nodes first then edges.

const DIFF_MARKER = " (diff)";
const MAX_CHANGES = 200;

/** Number of Unicode code points — matches the validator's own counting. */
const chars = (str) => Array.from(str).length;

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Normalize an optional scalar so "missing" and undefined compare equal. */
const opt = (value) => (value === undefined ? null : value);

/**
 * Edge identity for diffing: `from|to|label` (CONTRACT.md §diff rules).
 * A kind-only change is a `changed` edge, never remove+add, so the merged IR
 * can never contain two edges with the same (from,to,label).
 *
 * The label is trimmed because the validator itself compares trimmed labels
 * for its duplicate-edge rule; that keeps the merged IR valid even when a
 * whitespace-only label edit crosses the base/head boundary.
 */
function edgeIdentity(edge) {
  const label = typeof edge.label === "string" ? edge.label.trim() : "";
  return `${edge.from}|${edge.to}|${label}`;
}

/**
 * Edge key reported by shortestPath(): `from|to|kind|label`, using the edge's
 * declared orientation (not the traversal direction).
 */
function edgeTraceKey(edge) {
  const label = typeof edge.label === "string" ? edge.label : "";
  return `${edge.from}|${edge.to}|${edge.kind}|${label}`;
}

/** Copy a node into canonical key order; status (when any) goes last. */
function canonicalNode(node, status) {
  const out = { id: node.id, label: node.label };
  if (node.sublabel !== undefined) out.sublabel = node.sublabel;
  out.kind = node.kind;
  if (node.group !== undefined) out.group = node.group;
  if (status !== undefined) out.status = status;
  return out;
}

/** Copy an edge into canonical key order; status (when any) goes last. */
function canonicalEdge(edge, status) {
  const out = { from: edge.from, to: edge.to };
  if (edge.label !== undefined) out.label = edge.label;
  out.kind = edge.kind;
  if (status !== undefined) out.status = status;
  return out;
}

/**
 * Append the diff marker to the head subtitle, falling back to the head title
 * when the subtitle cannot take it (`" (diff)"` suffix allowed by contract).
 * Idempotent: never double-marks.
 */
function markHeadText(head, fallbackTitle) {
  const title =
    typeof head.title === "string" && head.title.trim().length > 0
      ? head.title
      : fallbackTitle !== undefined
        ? fallbackTitle
        : "Diagram";
  const subtitle = typeof head.subtitle === "string" ? head.subtitle : undefined;
  const alreadyMarked = (text) => text.trimEnd().endsWith(DIFF_MARKER.trim());

  if (subtitle !== undefined && subtitle.length > 0) {
    // Already marked -> leave both alone, otherwise a second pass would move
    // the marker up into the title.
    if (alreadyMarked(subtitle)) return { title, subtitle };
    if (chars(subtitle) + DIFF_MARKER.length <= 120) {
      return { title, subtitle: `${subtitle}${DIFF_MARKER}` };
    }
  }
  if (title.length > 0 && !alreadyMarked(title) && chars(title) + DIFF_MARKER.length <= 80) {
    return { title: `${title}${DIFF_MARKER}`, subtitle };
  }
  return { title, subtitle };
}

const DIAGRAM_TYPES = Object.freeze(["architecture", "workflow", "sequence"]);
const DIRECTIONS = Object.freeze(["TB", "LR"]);
const LOCALES = Object.freeze(["en", "ur", "ar", "zh"]);
const WALKTHROUGH_MAX_STEPS = 10;

/**
 * Copy the head walkthrough only when it is structurally valid *and* every
 * focus id still exists in the merged node set (a removed node would otherwise
 * fail validation).
 */
function sanitizeWalkthrough(walkthrough, mergedNodeIds) {
  if (!Array.isArray(walkthrough) || walkthrough.length === 0 || walkthrough.length > WALKTHROUGH_MAX_STEPS) {
    return undefined;
  }
  const steps = [];
  for (const step of walkthrough) {
    if (!isObj(step) || typeof step.title !== "string" || typeof step.text !== "string") return undefined;
    if (!Array.isArray(step.focus) || step.focus.length === 0 || step.focus.length > 6) return undefined;
    if (!step.focus.every((id) => typeof id === "string" && mergedNodeIds.has(id))) return undefined;
    steps.push({ title: step.title, text: step.text, focus: step.focus.slice() });
  }
  return steps;
}

/** Keep only notes that still satisfy the IR note rules (max 4, <=140 chars). */
function sanitizeNotes(notes) {
  if (!Array.isArray(notes)) return undefined;
  const clean = notes.filter((note) => typeof note === "string" && chars(note.trim()) <= 140).slice(0, 4);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Build a merged diff IR.
 *
 * @param {object} irBase base IR v1/v1.1 (read-only)
 * @param {object} irHead head IR v1/v1.1 (read-only)
 * @returns {{ir: object, summary: Record<string, number>, changes: Array<object>}}
 */
export function diff(irBase, irHead) {
  const base = isObj(irBase) ? irBase : {};
  const head = isObj(irHead) ? irHead : {};

  const baseNodes = Array.isArray(base.nodes) ? base.nodes.filter(isObj) : [];
  const headNodes = Array.isArray(head.nodes) ? head.nodes.filter(isObj) : [];
  const baseEdges = Array.isArray(base.edges) ? base.edges.filter(isObj) : [];
  const headEdges = Array.isArray(head.edges) ? head.edges.filter(isObj) : [];
  const headGroups = Array.isArray(head.groups) ? head.groups.filter(isObj) : [];
  const baseGroups = Array.isArray(base.groups) ? base.groups.filter(isObj) : [];

  const baseNodeById = new Map();
  for (const node of baseNodes) {
    if (typeof node.id === "string" && !baseNodeById.has(node.id)) baseNodeById.set(node.id, node);
  }
  const headNodeById = new Map();
  for (const node of headNodes) {
    if (typeof node.id === "string" && !headNodeById.has(node.id)) headNodeById.set(node.id, node);
  }

  /** @type {Array<{entity:string,id:string,status:string,before?:object,after?:object}>} */
  const changes = [];
  const summary = {
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedEdges: 0,
    removedEdges: 0,
    changedEdges: 0,
  };

  // ---- nodes: identity by id, order = base then added --------------------
  const mergedNodes = [];
  const removedNodeIds = new Set();

  for (const baseNode of baseNodes) {
    const id = baseNode.id;
    if (typeof id !== "string") continue;
    const headNode = headNodeById.get(id);
    if (headNode === undefined) {
      removedNodeIds.add(id);
      mergedNodes.push(canonicalNode(baseNode, "removed"));
      summary.removedNodes += 1;
      changes.push({ entity: "node", id, status: "removed", before: canonicalNode(baseNode) });
      continue;
    }
    const changed =
      opt(baseNode.label) !== opt(headNode.label) ||
      opt(baseNode.sublabel) !== opt(headNode.sublabel) ||
      opt(baseNode.kind) !== opt(headNode.kind);
    if (changed) {
      mergedNodes.push(canonicalNode(headNode, "changed"));
      summary.changedNodes += 1;
      changes.push({
        entity: "node",
        id,
        status: "changed",
        before: canonicalNode(baseNode),
        after: canonicalNode(headNode),
      });
    } else {
      mergedNodes.push(canonicalNode(headNode));
    }
  }

  for (const headNode of headNodes) {
    const id = headNode.id;
    if (typeof id !== "string" || baseNodeById.has(id)) continue;
    mergedNodes.push(canonicalNode(headNode, "added"));
    summary.addedNodes += 1;
    changes.push({ entity: "node", id, status: "added", after: canonicalNode(headNode) });
  }

  const mergedNodeIds = new Set();
  for (const node of mergedNodes) mergedNodeIds.add(node.id);

  // ---- edges: identity by from|to|label ----------------------------------
  const headEdgeByIdentity = new Map();
  for (const edge of headEdges) {
    if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    const identity = edgeIdentity(edge);
    if (!headEdgeByIdentity.has(identity)) headEdgeByIdentity.set(identity, edge);
  }
  const matchedHeadIdentities = new Set();

  /** @type {Array<{edge: object, status: string|undefined}>} */
  const mergedEdgeSlots = [];

  for (const baseEdge of baseEdges) {
    if (typeof baseEdge.from !== "string" || typeof baseEdge.to !== "string") continue;
    const identity = edgeIdentity(baseEdge);
    const headEdge = headEdgeByIdentity.get(identity);
    if (headEdge !== undefined && !matchedHeadIdentities.has(identity)) {
      matchedHeadIdentities.add(identity);
      if (opt(baseEdge.kind) !== opt(headEdge.kind)) {
        mergedEdgeSlots.push({ edge: headEdge, status: "changed" });
        summary.changedEdges += 1;
        changes.push({
          entity: "edge",
          id: identity,
          status: "changed",
          before: canonicalEdge(baseEdge),
          after: canonicalEdge(headEdge),
        });
      } else {
        mergedEdgeSlots.push({ edge: baseEdge, status: undefined });
      }
      continue;
    }
    mergedEdgeSlots.push({ edge: baseEdge, status: "removed" });
    summary.removedEdges += 1;
    changes.push({ entity: "edge", id: identity, status: "removed", before: canonicalEdge(baseEdge) });
  }

  for (const headEdge of headEdges) {
    if (typeof headEdge.from !== "string" || typeof headEdge.to !== "string") continue;
    const identity = edgeIdentity(headEdge);
    if (matchedHeadIdentities.has(identity)) continue;
    matchedHeadIdentities.add(identity);
    mergedEdgeSlots.push({ edge: headEdge, status: "added" });
    summary.addedEdges += 1;
    changes.push({ entity: "edge", id: identity, status: "added", after: canonicalEdge(headEdge) });
  }

  const mergedEdges = mergedEdgeSlots.map((slot) => canonicalEdge(slot.edge, slot.status));

  // ---- groups: head groups + base groups still held by removed nodes ------
  const mergedGroupIds = new Set();
  const mergedGroups = [];

  for (const group of headGroups) {
    if (typeof group.id !== "string" || mergedGroupIds.has(group.id)) continue;
    mergedGroupIds.add(group.id);
    const copy = { id: group.id, label: group.label };
    if (group.kind !== undefined) copy.kind = group.kind;
    copy.nodes = Array.isArray(group.nodes) ? group.nodes.filter((id) => typeof id === "string") : [];
    mergedGroups.push(copy);
  }

  // A removed node references its group via `node.group` and/or by being
  // listed in `group.nodes`; either way the group survives for the diff view.
  const referencedGroupIds = new Set();
  for (const id of removedNodeIds) {
    const baseNode = baseNodeById.get(id);
    if (baseNode !== undefined && typeof baseNode.group === "string") referencedGroupIds.add(baseNode.group);
  }
  for (const group of baseGroups) {
    if (typeof group.id !== "string" || !Array.isArray(group.nodes)) continue;
    if (group.nodes.some((id) => removedNodeIds.has(id))) referencedGroupIds.add(group.id);
  }

  for (const group of baseGroups) {
    if (typeof group.id !== "string" || !referencedGroupIds.has(group.id)) continue;
    if (mergedGroupIds.has(group.id)) continue; // head already carries this group
    const members = (Array.isArray(group.nodes) ? group.nodes : []).filter(
      (id) => typeof id === "string" && removedNodeIds.has(id),
    );
    if (members.length === 0) continue;
    mergedGroupIds.add(group.id);
    const copy = { id: group.id, label: group.label };
    let kind = group.kind;
    // A fragment band is only legal in a sequence diagram; keep merged valid
    // when head switched type.
    if (kind === "fragment" && head.type !== "sequence") kind = "zone";
    if (kind !== undefined) copy.kind = kind;
    copy.nodes = members;
    mergedGroups.push(copy);
  }

  // A removed node keeps its `group` only when a merged group lists it,
  // otherwise the validator warns about a mismatch.
  const groupMemberOf = new Map();
  for (const group of mergedGroups) {
    for (const id of group.nodes) {
      if (!groupMemberOf.has(id)) groupMemberOf.set(id, group.id);
    }
  }
  for (const node of mergedNodes) {
    if (node.status !== "removed" || node.group === undefined) continue;
    if (groupMemberOf.get(node.id) !== node.group) delete node.group;
  }

  // ---- root ---------------------------------------------------------------
  const fallbackTitle = typeof base.title === "string" && base.title.trim().length > 0 ? base.title : undefined;
  const { title, subtitle } = markHeadText(head, fallbackTitle);
  const type = DIAGRAM_TYPES.includes(head.type)
    ? head.type
    : DIAGRAM_TYPES.includes(base.type)
      ? base.type
      : "architecture";
  const merged = { title };
  if (subtitle !== undefined) merged.subtitle = subtitle;
  merged.type = type;
  if (DIRECTIONS.includes(head.direction)) merged.direction = head.direction;
  // v1.1 root fields ride along from head (they describe the diagram being
  // shown, not the delta), guarded so a hand-built IR cannot make the merged
  // IR invalid.
  const walkthrough = sanitizeWalkthrough(head.walkthrough, mergedNodeIds);
  if (walkthrough !== undefined) merged.walkthrough = walkthrough;
  merged.nodes = mergedNodes;
  merged.edges = mergedEdges;
  if (mergedGroups.length > 0) merged.groups = mergedGroups;
  const notes = sanitizeNotes(head.notes);
  if (notes !== undefined) merged.notes = notes;

  return { ir: merged, summary, changes: changes.slice(0, MAX_CHANGES) };
}

/**
 * Shortest path between two nodes over an undirected graph.
 *
 * `edges` carries the identity keys (`from|to|kind|label`) of the traversed
 * edges in path order, using each edge's declared orientation. BFS expands a
 * node's neighbours in edge declaration order, which makes equal-length paths
 * deterministic.
 *
 * @param {object} ir
 * @param {string} fromId
 * @param {string} toId
 * @returns {{ok: boolean, path: string[], edges: string[], hops: number, reason?: string}}
 */
export function shortestPath(ir, fromId, toId) {
  const source = isObj(ir) ? ir : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const edges = Array.isArray(source.edges) ? source.edges.filter(isObj) : [];

  const nodeIds = new Set();
  for (const node of nodes) {
    if (isObj(node) && typeof node.id === "string") nodeIds.add(node.id);
  }

  if (typeof fromId !== "string" || !nodeIds.has(fromId)) {
    return { ok: false, path: [], edges: [], hops: 0, reason: "unknown-from" };
  }
  if (typeof toId !== "string" || !nodeIds.has(toId)) {
    return { ok: false, path: [], edges: [], hops: 0, reason: "unknown-to" };
  }
  if (fromId === toId) {
    return { ok: true, path: [fromId], edges: [], hops: 0 };
  }

  const parent = new Map();
  const viaEdge = new Map();
  parent.set(fromId, null);
  const queue = [fromId];
  let found = false;

  for (let cursor = 0; cursor < queue.length && !found; cursor += 1) {
    const current = queue[cursor];
    for (const edge of edges) {
      if (edge.from === edge.to) continue;
      let next = null;
      if (edge.from === current && typeof edge.to === "string") next = edge.to;
      else if (edge.to === current && typeof edge.from === "string") next = edge.from;
      if (next === null || !nodeIds.has(next) || parent.has(next)) continue;
      parent.set(next, current);
      viaEdge.set(next, edge);
      queue.push(next);
      if (next === toId) {
        found = true;
        break;
      }
    }
  }

  if (!found) {
    return { ok: false, path: [], edges: [], hops: 0, reason: "unreachable" };
  }

  const path = [];
  const edgeKeys = [];
  for (let step = toId; step !== null; step = parent.get(step)) {
    path.push(step);
    const edge = viaEdge.get(step);
    if (edge !== undefined) edgeKeys.push(edgeTraceKey(edge));
  }
  path.reverse();
  edgeKeys.reverse();
  return { ok: true, path, edges: edgeKeys, hops: path.length - 1 };
}
