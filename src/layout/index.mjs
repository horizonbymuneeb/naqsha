import { layoutErd } from "./types/erd.mjs";
import { layoutClass } from "./types/class.mjs";
import { layoutTree } from "./types/tree.mjs";
import { layoutTimeline } from "./types/timeline.mjs";
import { layoutWaterfall } from "./types/waterfall.mjs";
import { layoutDataflow } from "./types/dataflow.mjs";
import { layoutLifecycle } from "./types/lifecycle.mjs";

/**
 * Naqsha layout engine — IR v1 -> scene v1 (see src/CONTRACT.md §2).
 *
 * Deterministic: the scene is a pure function of the IR (no randomness, no
 * clock, stable iteration order), so two runs serialise byte-identically.
 *
 * Owned by: layout. Exports: layout(ir) -> scene.
 */

import {
  PADDING,
  NODE_GAP,
  GROUP_INSET_SIDE,
  GROUP_INSET_BOTTOM,
  GROUP_INSET_TOP,
  GROUP_LABEL_INSET,
  LABEL_HEIGHT,
  MIN_CANVAS_WIDTH,
  DASHED_KINDS,
  groupLabelWidth,
  sizeNode,
  layerGraph,
  layerGapFor,
  orderLayers,
  packLayered,
  routeAbstract,
  simplifyPoints,
  placeEdgeLabel,
} from "./geometry.mjs";

/** Legend order is fixed by the contract; labels are ours. */
const LEGEND_ORDER = [
  { kind: "main", label: "Main request" },
  { kind: "return", label: "Response" },
  { kind: "async", label: "Async event" },
  { kind: "security", label: "Security boundary" },
  { kind: "message", label: "Message" },
  { kind: "data", label: "Data flow" },
];

const GAP_BETWEEN_MESSAGES = Math.max(44, LABEL_HEIGHT + 18);
const MESSAGE_START_BELOW_CARDS = 56;
const FRAGMENT_PAD = 12;

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

function buildLegend(edges) {
  const used = new Set(edges.map((e) => e.kind || "main"));
  return LEGEND_ORDER.filter((item) => used.has(item.kind)).map(
    ({ kind, label }) => ({ kind, label }),
  );
}

function copyNotes(ir) {
  if (!Array.isArray(ir.notes)) return [];
  return ir.notes
    .filter((note) => typeof note === "string")
    .slice(0, 4);
}

/** Normalise IR edges with our scene ids (e1.. in declared order). */
function normalizeEdges(ir) {
  const list = Array.isArray(ir.edges) ? ir.edges : [];
  return list.map((edge, index) => ({
    id: `e${index + 1}`,
    from: String(edge.from),
    to: String(edge.to),
    label:
      typeof edge.label === "string" && edge.label.length ? edge.label : null,
    kind: typeof edge.kind === "string" && edge.kind ? edge.kind : "main",
    ...(typeof edge.status === "string" && edge.status ? { status: edge.status } : {}),
  }));
}

/**
 * Per-pair routing offsets so parallel edges between the same two nodes do
 * not paint on top of each other. Deterministic: declaration order decides.
 */
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
    if (total <= 1) {
      offsets.set(edge.id, 0);
      continue;
    }
    const raw = (seen - (total - 1) / 2) * 8;
    offsets.set(edge.id, Math.round(Math.max(-16, Math.min(16, raw))));
  }
  return offsets;
}

/**
 * Canvas = content bbox + 24px padding on every side (min width 320) and shift
 * every coordinate so the bbox starts at the padding. Everything that the
 * scene exposes is included in the bbox: node boxes, group rectangles, edge
 * points and label chips.
 */
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
  const width = Math.max(MIN_CANVAS_WIDTH, Math.ceil(maxX - minX) + PADDING * 2);
  const height = Math.ceil(maxY - minY) + PADDING * 2;

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

  scene.width = width;
  scene.height = height;
  return scene;
}

function baseScene(ir, type, direction) {
  const scene = {
    sceneVersion: 1,
    type,
    direction,
    width: 0,
    height: 0,
    title: typeof ir.title === "string" ? ir.title : "",
    notes: copyNotes(ir),
  };
  if (typeof ir.subtitle === "string" && ir.subtitle.length) {
    scene.subtitle = ir.subtitle;
  }
  const walkthrough = copyWalkthrough(ir);
  if (walkthrough.length) scene.walkthrough = walkthrough;
  return scene;
}

/** Copy authored tour steps into the scene, numbering them 1..n. */
function copyWalkthrough(ir) {
  if (!Array.isArray(ir.walkthrough)) return [];
  return ir.walkthrough
    .filter((step) => step && typeof step === "object" && Array.isArray(step.focus) && step.focus.length)
    .slice(0, 10)
    .map((step, index) => ({
      n: index + 1,
      title: typeof step.title === "string" ? step.title : "",
      text: typeof step.text === "string" ? step.text : "",
      focus: step.focus.filter((id) => typeof id === "string"),
    }));
}

/* ------------------------------------------------------------------------- */
/* Architecture / workflow — layered DAG                                     */
/* ------------------------------------------------------------------------- */

function layoutLayered(ir) {
  const type = ir.type;
  const direction = ir.direction === "LR" ? "LR" : "TB";
  const isTB = direction === "TB";

  const irNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const nodes = irNodes.map((node) => {
    const sized = sizeNode(node, type);
    return {
      id: node.id,
      label: node.label,
      sublabel: node.sublabel,
      kind: node.kind || "service",
      group: node.group || null,
      shape: sized.shape,
      w: sized.w,
      h: sized.h,
      ...(typeof node.status === "string" && node.status ? { status: node.status } : {}),
    };
  });
  const declaredIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = normalizeEdges(ir);
  const knownNodes = new Set(nodes.map((node) => node.id));

  const graph = layerGraph(nodes, edges);
  const layers = orderLayers(graph.layers, edges, declaredIndex);

  const sizeMap = new Map();
  for (const node of nodes) {
    sizeMap.set(node.id, isTB
      ? { aw: node.w, ah: node.h }
      : { aw: node.h, ah: node.w });
  }

  const groupIds = [];
  if (Array.isArray(ir.groups)) {
    for (const group of ir.groups) {
      if (group && typeof group.id === "string") groupIds.push(group.id);
    }
  }
  const groupIdSet = new Set(groupIds);
  const groupOf = new Map();
  for (const node of nodes) {
    groupOf.set(node.id, node.group && groupIdSet.has(node.group) ? node.group : null);
  }
  const groupLabels = new Map();
  if (Array.isArray(ir.groups)) {
    for (const group of ir.groups) {
      if (group && typeof group.id === "string") {
        groupLabels.set(
          group.id,
          typeof group.label === "string" && group.label ? group.label : group.id,
        );
      }
    }
  }

  // Undirected neighbour lists steer ungrouped nodes towards what they touch.
  const neighbours = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    if (!knownNodes.has(edge.from) || !knownNodes.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    neighbours.get(edge.from).add(edge.to);
    neighbours.get(edge.to).add(edge.from);
  }
  const neighbourList = new Map(
    [...neighbours].map(([id, set]) => [id, [...set].sort()]),
  );

  const packed = packLayered({
    layers,
    sizes: sizeMap,
    groupOf,
    groupIds,
    groupLabels,
    neighbours: neighbourList,
    declaredIndex,
    layerGap: layerGapFor(type),
  });
  const { pos, layerStart, layerDepth, layerIntervals } = packed;

  const toScreen = (c, d) => (isTB ? { x: c, y: d } : { x: d, y: c });
  const boxToScreen = (box) =>
    isTB
      ? { x: box.ax, y: box.ay, w: box.aw, h: box.ah }
      : { x: box.ay, y: box.ax, w: box.ah, h: box.aw };

  const nodeBoxes = new Map();
  for (const node of nodes) {
    const box = pos.get(node.id);
    if (!box) continue;
    nodeBoxes.set(node.id, boxToScreen(box));
  }

  // Group rectangles: member-node bbox expanded 14px on the sides/bottom and
  // 26px on top, leaving a label band the view's group label sits in. The
  // width grows when a long label needs more room than the members do.
  const sceneGroups = [];
  if (Array.isArray(ir.groups)) {
    for (const group of ir.groups) {
      const members = (group.nodes || []).filter((id) => nodeBoxes.has(id));
      if (!members.length) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const id of members) {
        const box = nodeBoxes.get(id);
        x0 = Math.min(x0, box.x);
        y0 = Math.min(y0, box.y);
        x1 = Math.max(x1, box.x + box.w);
        y1 = Math.max(y1, box.y + box.h);
      }
      const label = typeof group.label === "string" ? group.label : group.id;
      const labelW = groupLabelWidth(label);
      const width = Math.max(
        x1 - x0 + GROUP_INSET_SIDE * 2,
        labelW + GROUP_LABEL_INSET + 8,
      );
      sceneGroups.push({
        id: group.id,
        label,
        kind: typeof group.kind === "string" && group.kind ? group.kind : "zone",
        x: x0 - GROUP_INSET_SIDE,
        y: y0 - GROUP_INSET_TOP,
        w: width,
        h: y1 - y0 + GROUP_INSET_TOP + GROUP_INSET_BOTTOM,
      });
    }
  }

  const offsets = parallelOffsets(edges);
  const allBoxes = [...nodeBoxes.values()];
  const sceneEdges = [];
  for (const edge of edges) {
    if (!knownNodes.has(edge.from) || !knownNodes.has(edge.to)) continue;
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (!from || !to) continue;
    const abstract = routeAbstract({
      from: { id: edge.from, ...from },
      to: { id: edge.to, ...to },
      rank: graph.rank,
      layerStart,
      layerDepth,
      layerIntervals,
      offset: offsets.get(edge.id) || 0,
    });
    const points = simplifyPoints(
      abstract.map((point) => toScreen(point.c, point.d)),
    );
    const sceneEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      dashed: DASHED_KINDS.has(edge.kind),
      arrow: "end",
      points,
      ...(edge.status ? { status: edge.status } : {}),
    };
    if (edge.label) sceneEdge.label = edge.label;
    sceneEdges.push(sceneEdge);
  }
  // Labels go second so each one can dodge nodes and earlier label chips.
  const placedLabels = [];
  for (const sceneEdge of sceneEdges) {
    if (!sceneEdge.label) continue;
    const labelBox = placeEdgeLabel(
      sceneEdge.points,
      sceneEdge.label,
      allBoxes,
      placedLabels,
    );
    if (labelBox) {
      sceneEdge.labelBox = labelBox;
      placedLabels.push(labelBox);
    }
  }

  const scene = baseScene(ir, type, direction);
  scene.nodes = nodes.map((node) => {
    const box = nodeBoxes.get(node.id);
    const entry = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      shape: node.shape,
      x: box ? box.x : 0,
      y: box ? box.y : 0,
      w: box ? box.w : node.w,
      h: box ? box.h : node.h,
    };
    if (node.sublabel) entry.sublabel = node.sublabel;
    if (node.group) entry.group = node.group;
    if (node.status) entry.status = node.status;
    return entry;
  });
  scene.groups = sceneGroups;
  scene.edges = sceneEdges;
  scene.legend = buildLegend(edges);
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return finalizeCanvas(scene);
}

/* ------------------------------------------------------------------------- */
/* Sequence — participants in one row, lifelines, messages, fragments        */
/* ------------------------------------------------------------------------- */

function layoutSequence(ir) {
  const direction = ir.direction === "LR" ? "LR" : "TB";
  const irNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const nodes = irNodes.map((node) => {
    const sized = sizeNode(node, "sequence");
    return {
      id: node.id,
      label: node.label,
      sublabel: node.sublabel,
      kind: node.kind || "service",
      shape: "participant",
      w: sized.w,
      cardH: sized.h,
      ...(typeof node.status === "string" && node.status ? { status: node.status } : {}),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = normalizeEdges(ir);

  // One horizontal row of participant cards, declared order.
  let cursor = 0;
  for (const node of nodes) {
    node.x = cursor;
    cursor += node.w + NODE_GAP;
  }
  const cardH = nodes.length ? Math.max(...nodes.map((node) => node.cardH)) : 56;

  const messages = edges.filter(
    (edge) => byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to,
  );
  const firstMessageY = cardH + MESSAGE_START_BELOW_CARDS;
  const messageY = (index) => firstMessageY + index * GAP_BETWEEN_MESSAGES;
  const lastMessageY = messages.length
    ? messageY(messages.length - 1)
    : cardH + GAP_BETWEEN_MESSAGES;
  const lifelineBottom = lastMessageY + GAP_BETWEEN_MESSAGES;

  for (const node of nodes) {
    node.y = 0;
    node.h = lifelineBottom; // lifeline extent lives in node.h
  }

  const sceneEdges = [];
  messages.forEach((edge, index) => {
    const y = messageY(index);
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const points = [
      { x: Math.round(from.x + from.w / 2), y },
      { x: Math.round(to.x + to.w / 2), y },
    ];
    const sceneEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      dashed: DASHED_KINDS.has(edge.kind),
      arrow: "end",
      points,
    };
    if (edge.label) sceneEdge.label = edge.label;
    sceneEdges.push(sceneEdge);
  });
  const placedLabels = [];
  for (const sceneEdge of sceneEdges) {
    if (!sceneEdge.label) continue;
    const labelBox = placeEdgeLabel(sceneEdge.points, sceneEdge.label, [], placedLabels);
    if (labelBox) {
      sceneEdge.labelBox = labelBox;
      placedLabels.push(labelBox);
    }
  }

  // Fragments: bands spanning the participants' x-range, y from the first to
  // the last message they exchange +/-12px. The tab label lives in the band's
  // top strip, so the width also leaves room for it (never clipped).
  const sceneGroups = [];
  if (Array.isArray(ir.groups)) {
    for (const group of ir.groups) {
      const members = new Set(
        (group.nodes || []).filter((id) => byId.has(id)),
      );
      if (!members.size) continue;
      const involved = [];
      messages.forEach((edge, index) => {
        if (members.has(edge.from) && members.has(edge.to)) involved.push(index);
      });
      let y0;
      let y1;
      if (involved.length) {
        y0 = messageY(Math.min(...involved)) - FRAGMENT_PAD;
        y1 = messageY(Math.max(...involved)) + FRAGMENT_PAD;
      } else {
        y0 = firstMessageY - FRAGMENT_PAD;
        y1 = Math.max(y0 + 48, lifelineBottom - 16);
      }
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const node of nodes) {
        x0 = Math.min(x0, node.x);
        x1 = Math.max(x1, node.x + node.w);
      }
      if (!nodes.length) {
        x0 = 0;
        x1 = 0;
      }
      const label = typeof group.label === "string" ? group.label : group.id;
      // View draws a rounded tab of height 20 with the label clipped at
      // min(group.w, max(64, labelW+26)) - 20; keep that >= labelW.
      const minBandWidth = Math.max(64, groupLabelWidth(label) + 26);
      sceneGroups.push({
        id: group.id,
        label,
        kind: typeof group.kind === "string" && group.kind ? group.kind : "fragment",
        x: x0,
        y: y0,
        w: Math.max(x1 - x0, minBandWidth),
        h: y1 - y0,
      });
    }
  }

  const scene = baseScene(ir, "sequence", direction);
  scene.nodes = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    shape: "participant",
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    ...(node.sublabel ? { sublabel: node.sublabel } : {}),
  }));
  scene.groups = sceneGroups;
  scene.edges = sceneEdges;
  scene.legend = buildLegend(edges);
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return finalizeCanvas(scene);
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout an IR v1 document into a scene v1 document.
 * @param {object} ir validated IR (see CONTRACT.md §1)
 * @returns {object} scene (see CONTRACT.md §2)
 */
export function layout(ir) {
  if (!ir || typeof ir !== "object") {
    throw new TypeError("layout(ir): expected an IR object");
  }
  switch (ir.type) {
    case "sequence":
      return layoutSequence(ir);
    case "erd":
      return layoutErd(ir);
    case "class":
      return layoutClass(ir);
    case "tree":
      return layoutTree(ir);
    case "timeline":
      return layoutTimeline(ir);
    case "waterfall":
      return layoutWaterfall(ir);
    case "dataflow":
      return layoutDataflow(ir);
    case "lifecycle":
      return layoutLifecycle(ir);
    default:
      return layoutLayered(ir);
  }
}
