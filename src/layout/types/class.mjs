/**
 * Layout for type "class" — class boxes layered by inheritance depth.
 *
 * Owner: types-relational. Parents (extends/implements targets) sit on top;
 * other relation kinds keep their kinds so the view can pick distinct heads.
 * Deterministic, zero dependencies, canvas = content + 24px padding.
 */

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  simplifyPoints,
  placeEdgeLabel,
  routeAbstract,
  orderLayers,
} from "../geometry.mjs";

const HEADER_H = 34;
const ROW_H = 22;
const BOX_PAD_X = 32;
const MIN_BOX_W = 180;
const LAYER_GAP = 64;
const NODE_GAP = 40;
const FONT_HEADER = 13;
const FONT_MEMBER = 11;

const RELATION_ORDER = [
  { kind: "extends", label: "Extends" },
  { kind: "implements", label: "Implements" },
  { kind: "composition", label: "Composition" },
  { kind: "association", label: "Association" },
  { kind: "dependency", label: "Dependency" },
];
const RELATION_KINDS = new Set(RELATION_ORDER.map((item) => item.kind));

/* ------------------------------------------------------------------------- */
/* Shared scene scaffolding                                                  */
/* ------------------------------------------------------------------------- */

function copyNotes(ir) {
  if (!Array.isArray(ir.notes)) return [];
  return ir.notes.filter((note) => typeof note === "string").slice(0, 4);
}

function baseScene(ir, type) {
  const scene = {
    sceneVersion: 1,
    type,
    direction: "TB", // inheritance depth stacks top-to-bottom
    width: 0,
    height: 0,
    title: typeof ir.title === "string" ? ir.title : "",
    notes: copyNotes(ir),
  };
  if (typeof ir.subtitle === "string" && ir.subtitle.length) {
    scene.subtitle = ir.subtitle;
  }
  return scene;
}

function finalizeCanvas(scene) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x, y, w = 0, h = 0) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  };
  for (const node of scene.nodes) grow(node.x, node.y, node.w, node.h);
  for (const group of scene.groups) grow(group.x, group.y, group.w, group.h);
  for (const edge of scene.edges) {
    for (const point of edge.points) grow(point.x, point.y);
    if (edge.labelBox) grow(edge.labelBox.x, edge.labelBox.y, edge.labelBox.w, edge.labelBox.h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const dx = PADDING - minX;
  const dy = PADDING - minY;
  scene.width = Math.max(MIN_CANVAS_WIDTH, Math.ceil(maxX - minX) + PADDING * 2);
  scene.height = Math.ceil(maxY - minY) + PADDING * 2;
  for (const node of scene.nodes) {
    node.x += dx;
    node.y += dy;
  }
  for (const group of scene.groups) {
    group.x += dx;
    group.y += dy;
  }
  for (const edge of scene.edges) {
    for (const point of edge.points) {
      point.x += dx;
      point.y += dy;
    }
    if (edge.labelBox) {
      edge.labelBox.x += dx;
      edge.labelBox.y += dy;
    }
  }
  return scene;
}

/* ------------------------------------------------------------------------- */
/* Class boxes                                                               */
/* ------------------------------------------------------------------------- */

function normalizeEdges(ir) {
  const list = Array.isArray(ir.edges) ? ir.edges : [];
  return list.map((edge, index) => ({
    id: `e${index + 1}`,
    from: String(edge.from),
    to: String(edge.to),
    label:
      typeof edge.label === "string" && edge.label.length ? edge.label : null,
    kind:
      typeof edge.kind === "string" && RELATION_KINDS.has(edge.kind)
        ? edge.kind
        : "association",
  }));
}

function sizeClass(node) {
  const label = String(node.label ?? node.id ?? "");
  const stereotype =
    typeof node.stereotype === "string" && node.stereotype ? node.stereotype : null;
  const members = Array.isArray(node.members)
    ? node.members.filter((member) => typeof member === "string")
    : [];
  const headerW = Math.max(
    textWidth(label, FONT_HEADER),
    stereotype ? textWidth(`\u00ab${stereotype}\u00bb`, FONT_MEMBER) : 0,
  );
  let contentW = headerW;
  for (const member of members) {
    contentW = Math.max(contentW, textWidth(member, FONT_MEMBER));
  }
  const w = Math.max(MIN_BOX_W, contentW + BOX_PAD_X);
  // One body row minimum keeps an empty class visually a box, not a bar.
  const h = HEADER_H + Math.max(members.length, 1) * ROW_H;
  return { stereotype, members, w: Math.ceil(w), h: Math.ceil(h) };
}

/* ------------------------------------------------------------------------- */
/* Inheritance-depth layering (cycle-safe, deterministic)                    */
/* ------------------------------------------------------------------------- */

/**
 * Rank nodes by extends/implements depth: an interface/superclass that nobody
 * extends is rank 0, its subclasses rank 1, and so on. Other relation kinds do
 * not affect layers. Cycles are broken deterministically by edge order so a
 * bad IR still lays out deterministically instead of exploding.
 */
function hierarchyRanks(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const hierarchy = edges.filter(
    (edge) => edge.kind === "extends" || edge.kind === "implements",
  );
  const childrenOf = new Map(ids.map((id) => [id, []]));
  hierarchy.forEach((edge, index) => {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) return;
    childrenOf.get(edge.to).push({ child: edge.from, index }); // parent -> child
  });

  const state = new Map(ids.map((id) => [id, 0]));
  const post = [];
  const backEdges = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const { child, index } of childrenOf.get(id)) {
      const st = state.get(child);
      if (st === 1) backEdges.add(index);
      else if (st === 0) visit(child);
    }
    state.set(id, 2);
    post.push(id);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);

  const topo = post.slice().reverse();
  const rank = new Map(ids.map((id) => [id, 0]));
  for (const id of topo) {
    for (const { child, index } of childrenOf.get(id)) {
      if (backEdges.has(index)) continue;
      if (rank.get(id) + 1 > rank.get(child)) rank.set(child, rank.get(id) + 1);
    }
  }
  return rank;
}

function buildLayers(nodes, rank) {
  let maxRank = 0;
  for (const node of nodes) maxRank = Math.max(maxRank, rank.get(node.id));
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  for (const node of nodes) layers[rank.get(node.id)].push(node);
  return layers;
}

/* ------------------------------------------------------------------------- */
/* Packing + routing                                                         */
/* ------------------------------------------------------------------------- */

function packLayers(layers) {
  const layerDepth = layers.map((layer) =>
    layer.reduce((max, node) => Math.max(max, node.h), 0),
  );
  const layerStart = [];
  for (let i = 0; i < layers.length; i++) {
    layerStart.push(i === 0 ? 0 : layerStart[i - 1] + layerDepth[i - 1] + LAYER_GAP);
  }
  const rowWidth = layers.map((layer) =>
    layer.reduce((sum, node) => sum + node.w, 0) +
    NODE_GAP * Math.max(0, layer.length - 1),
  );
  const contentWidth = rowWidth.reduce((max, width) => Math.max(max, width), 0);
  const layerIntervals = [];
  layers.forEach((layer, li) => {
    const startX = Math.round((contentWidth - rowWidth[li]) / 2);
    let x = startX;
    const intervals = [];
    for (const node of layer) {
      node.x = x;
      node.y = layerStart[li] + Math.round((layerDepth[li] - node.h) / 2);
      intervals.push([node.x, node.x + node.w]);
      x += node.w + NODE_GAP;
    }
    intervals.sort((a, b) => a[0] - b[0]);
    layerIntervals.push(intervals);
  });
  return { layerStart, layerDepth, layerIntervals, contentWidth };
}

function parallelOffsets(edges) {
  const counts = new Map();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const cursor = new Map();
  const offsets = new Map();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const total = counts.get(key);
    const seen = cursor.get(key) || 0;
    cursor.set(key, seen + 1);
    offsets.set(
      edge.id,
      total <= 1
        ? 0
        : Math.round(Math.max(-16, Math.min(16, (seen - (total - 1) / 2) * 8))),
    );
  }
  return offsets;
}

/** Which border an edge leaves from / arrives at, from rank order. */
function portSides(sourceRank, targetRank) {
  if (sourceRank > targetRank) return { fromSide: "top", toSide: "bottom" };
  if (targetRank > sourceRank) return { fromSide: "bottom", toSide: "top" };
  return { fromSide: "bottom", toSide: "bottom" };
}

/**
 * Move an orthogonal route's first/last anchors along the node border so
 * several relations attached to the same side do not overprint on one point.
 * Class routes only ever touch bottom/top borders, so the shift is in x.
 */
function applyPortOffsets(points, fromOffset, toOffset) {
  const out = points.map((point) => ({ x: point.x, y: point.y }));
  if (!fromOffset && !toOffset) return out;
  if (out.length === 2) {
    const midY = Math.round((out[0].y + out[1].y) / 2);
    return [
      { x: out[0].x + fromOffset, y: out[0].y },
      { x: out[0].x + fromOffset, y: midY },
      { x: out[1].x + toOffset, y: midY },
      { x: out[1].x + toOffset, y: out[1].y },
    ];
  }
  if (out.length >= 3) {
    if (out[0].x === out[1].x) {
      out[0].x += fromOffset;
      out[1].x += fromOffset;
    }
    const last = out.length - 1;
    if (out[last - 1].x === out[last].x) {
      out[last - 1].x += toOffset;
      out[last].x += toOffset;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a class IR into a scene v3 document.
 * @param {object} ir validated IR with type "class"
 * @returns {object} scene
 */
export function layoutClass(ir) {
  const irNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const nodes = irNodes.map((node) => {
    const sized = sizeClass(node);
    const entry = {
      id: node.id,
      label: node.label,
      kind: typeof node.kind === "string" && node.kind ? node.kind : "service",
      stereotype: sized.stereotype,
      members: sized.members,
      w: sized.w,
      h: sized.h,
      x: 0,
      y: 0,
    };
    return entry;
  });

  const edges = normalizeEdges(ir);
  const declaredIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const rank = hierarchyRanks(nodes, edges);
  let layers = buildLayers(nodes, rank);
  layers = orderLayers(layers, edges, declaredIndex);
  const { layerStart, layerDepth, layerIntervals } = packLayers(layers);

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const layerOf = new Map();
  layers.forEach((layer, li) => {
    for (const node of layer) layerOf.set(node.id, li);
  });
  // Same-layer relations get their own channel depth inside the row gap so
  // several of them do not paint on the same horizontal line.
  const channelOffsets = parallelOffsets(edges);
  const sameLayerSeen = new Map();
  for (const edge of edges) {
    const li = layerOf.get(edge.from);
    if (li === undefined || li !== layerOf.get(edge.to)) continue;
    const seen = sameLayerSeen.get(li) || 0;
    sameLayerSeen.set(li, seen + 1);
    channelOffsets.set(edge.id, seen * 8);
  }

  // Port spreading: each (node, border) bucket distributes its endpoints along
  // the border (16px steps) so triangles/diamonds/arrowheads never coincide.
  const plans = [];
  const portBuckets = new Map();
  for (const edge of edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;
    const sides = portSides(rank.get(edge.from), rank.get(edge.to));
    const plan = {
      edge,
      fromSide: sides.fromSide,
      toSide: sides.toSide,
      fromOffset: 0,
      toOffset: 0,
    };
    for (const [nodeId, side, role] of [
      [edge.from, sides.fromSide, "from"],
      [edge.to, sides.toSide, "to"],
    ]) {
      const key = `${nodeId}:${side}`;
      if (!portBuckets.has(key)) portBuckets.set(key, []);
      portBuckets.get(key).push({ plan, role });
    }
    plans.push(plan);
  }
  for (const [key, list] of portBuckets) {
    const separator = key.lastIndexOf(":");
    const node = nodesById.get(key.slice(0, separator));
    if (!node) continue;
    const limit = Math.max(0, Math.floor(node.w / 2) - 8);
    list.forEach((item, portIndex) => {
      const raw = Math.round((portIndex - (list.length - 1) / 2) * 16);
      const offset = Math.max(-limit, Math.min(limit, raw));
      if (item.role === "from") item.plan.fromOffset = offset;
      else item.plan.toOffset = offset;
    });
  }

  const placedChips = [];
  const allBoxes = nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));

  const routedEdges = [];
  for (const plan of plans) {
    const edge = plan.edge;
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    const abstract = routeAbstract({
      from: { id: edge.from, ax: from.x, ay: from.y, aw: from.w, ah: from.h },
      to: { id: edge.to, ax: to.x, ay: to.y, aw: to.w, ah: to.h },
      rank,
      layerStart,
      layerDepth,
      layerIntervals,
      offset: channelOffsets.get(edge.id) || 0,
    });
    let points = simplifyPoints(abstract.map((point) => ({ x: point.c, y: point.d })));
    points = simplifyPoints(applyPortOffsets(points, plan.fromOffset, plan.toOffset));
    routedEdges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label,
      points,
    });
  }

  for (const edge of routedEdges) {
    if (!edge.label) continue;
    const labelBox = placeEdgeLabel(edge.points, edge.label, allBoxes, placedChips);
    if (labelBox) {
      edge.labelBox = labelBox;
      placedChips.push(labelBox);
    }
  }

  const usedKinds = new Set(routedEdges.map((edge) => edge.kind));
  const scene = baseScene(ir, "class");
  scene.nodes = nodes.map((node) => {
    const entry = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      shape: "class",
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      rows: node.members.map((member) => ({ label: member })),
    };
    if (node.stereotype) entry.stereotype = node.stereotype;
    // The view renders `rows`; keep `members` too so either contract reading works.
    entry.members = node.members.slice();
    return entry;
  });
  scene.groups = [];
  scene.edges = routedEdges.map((edge) => {
    const entry = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      dashed: edge.kind === "dependency",
      arrow: edge.kind === "composition" ? "none" : "end",
      points: edge.points,
    };
    if (edge.label) entry.label = edge.label;
    if (edge.labelBox) entry.labelBox = edge.labelBox;
    return entry;
  });
  scene.legend = RELATION_ORDER.filter((item) => usedKinds.has(item.kind)).map(
    (item) => ({ kind: item.kind, label: item.label }),
  );
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return finalizeCanvas(scene);
}
