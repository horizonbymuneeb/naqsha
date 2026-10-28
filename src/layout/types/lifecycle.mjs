// Layout for type "lifecycle" — owner: types-time (see src/CONTRACT.md
// §"v1.2 — the other seven diagram types", NORMATIVE).
//
// States are laid out as a layered state machine: DFS back-edges (cycles) are
// detected first and excluded from layering, the remaining DAG is layered by
// longest path from the entry states, and each node carries its computed
// `role` ("start" = no incoming, "end" = no outgoing, else "state"). Back-edges
// are still drawn, routed through a side channel, so cycles render safely.
//
// Deterministic: no clock, no randomness, declaration-order ties.

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  DASHED_KINDS,
  placeEdgeLabel,
} from "../geometry.mjs";

const STATE_H = 54;
const STATE_MIN_W = 132;
const STATE_MAX_W = 220;
const ROW_GAP = 74;
const NODE_GAP = 28;
const BACK_CHANNEL_GAP = 16;
const BACK_CHANNEL_OFFSET = 26;

/* ------------------------------------------------------------------------- */
/* Copy helpers (same contract as the existing engine)                       */
/* ------------------------------------------------------------------------- */

function copyNotes(ir) {
  if (!Array.isArray(ir.notes)) return [];
  return ir.notes.filter((note) => typeof note === "string").slice(0, 4);
}

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
  if (typeof ir.subtitle === "string" && ir.subtitle.length) scene.subtitle = ir.subtitle;
  const walkthrough = copyWalkthrough(ir);
  if (walkthrough.length) scene.walkthrough = walkthrough;
  return scene;
}

const LEGEND_ORDER = [
  { kind: "main", label: "Main request" },
  { kind: "return", label: "Response" },
  { kind: "async", label: "Async event" },
  { kind: "security", label: "Security boundary" },
  { kind: "message", label: "Message" },
  { kind: "data", label: "Data flow" },
];

function legendFromEdges(sceneEdges, type) {
  const used = new Set(sceneEdges.map((edge) => edge.kind || "main"));
  return LEGEND_ORDER.filter((item) => used.has(item.kind)).map(({ kind, label }) => ({
    kind,
    // Lifecycle edges are transitions, not requests; keep the legend honest.
    label: type === "lifecycle" && kind === "main" ? "Transition" : label,
  }));
}

/**
 * Shift laid-out content into the 24px padding box and size the canvas.
 * The finaliser in src/layout/index.mjs is private, so type modules carry the
 * identical maths locally.
 */
function finalizeCanvas(scene, minWidth = MIN_CANVAS_WIDTH) {
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

  for (const node of scene.nodes) {
    grow(node.x, node.y, node.w, node.h);
    if (node.labelBox) grow(node.labelBox.x, node.labelBox.y, node.labelBox.w, node.labelBox.h);
    if (node.valueBox) grow(node.valueBox.x, node.valueBox.y, node.valueBox.w, node.valueBox.h);
    if (Array.isArray(node.leader)) for (const point of node.leader) grow(point.x, point.y);
  }
  for (const group of scene.groups) grow(group.x, group.y, group.w, group.h);
  for (const edge of scene.edges) {
    for (const point of edge.points) grow(point.x, point.y);
    if (edge.labelBox) grow(edge.labelBox.x, edge.labelBox.y, edge.labelBox.w, edge.labelBox.h);
  }
  if (scene.axis) {
    const axis = scene.axis;
    grow(axis.x0, axis.y);
    grow(axis.x1, axis.y);
    for (const tick of axis.ticks) {
      const w = textWidth(tick.label, 11);
      grow(tick.x - w / 2, axis.y - 20, w, 17);
      grow(tick.x, axis.y, 0, 7);
    }
  }
  for (const lane of scene.lanes || []) {
    grow(0, lane.y, 0, lane.h);
    grow(0, lane.y + 4, textWidth(lane.label || "", 11) + 8, 14);
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  // Integer shift keeps every pixel coordinate on the grid (fractional tick
  // label boxes can pull minX off-grid otherwise).
  const dx = Math.round(PADDING - minX);
  const dy = Math.round(PADDING - minY);
  const width = Math.max(minWidth, Math.ceil(maxX - minX) + PADDING * 2);
  const height = Math.ceil(maxY - minY) + PADDING * 2;

  for (const node of scene.nodes) {
    node.x += dx;
    node.y += dy;
    if (node.labelBox) {
      node.labelBox.x += dx;
      node.labelBox.y += dy;
    }
    if (node.valueBox) {
      node.valueBox.x += dx;
      node.valueBox.y += dy;
    }
    if (Array.isArray(node.leader)) {
      for (const point of node.leader) {
        point.x += dx;
        point.y += dy;
      }
    }
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
  if (scene.axis) {
    scene.axis.y += dy;
    scene.axis.x0 += dx;
    scene.axis.x1 += dx;
    for (const tick of scene.axis.ticks) tick.x += dx;
  }
  for (const lane of scene.lanes || []) lane.y += dy;

  scene.width = width;
  scene.height = height;
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return scene;
}

/** Drop consecutive duplicate vertices (straight runs collapse to 2 points). */
function simplifyPoints(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) out.push(point);
  }
  return out;
}

function stateWidth(label) {
  return Math.max(STATE_MIN_W, Math.min(STATE_MAX_W, Math.ceil(textWidth(label, 13)) + 34));
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a `lifecycle` IR into a scene v3 document.
 * @param {object} ir validated IR
 * @returns {object} scene
 */
export function layoutLifecycle(ir) {
  if (!ir || typeof ir !== "object") throw new TypeError("layoutLifecycle(ir): expected an IR object");

  const nodeList = Array.isArray(ir.nodes) ? ir.nodes.filter((node) => node && typeof node.id === "string") : [];
  const ids = nodeList.map((node) => node.id);
  const idSet = new Set(ids);
  const irEdges = (Array.isArray(ir.edges) ? ir.edges : []).filter(
    (edge) => edge && idSet.has(edge.from) && idSet.has(edge.to) && edge.from !== edge.to,
  );

  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of irEdges) {
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  // ---- cycle-safe layering: flag DFS back-edges, then longest-path a DAG ---
  const color = new Map(ids.map((id) => [id, 0])); // 0 new, 1 on stack, 2 done
  const backEdges = new Set();
  const visit = (id) => {
    color.set(id, 1);
    for (const edge of outgoing.get(id)) {
      const state = color.get(edge.to);
      if (state === 1) backEdges.add(edge);
      else if (state === 0) visit(edge.to);
    }
    color.set(id, 2);
  };
  for (const id of ids) if (color.get(id) === 0) visit(id);

  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of irEdges) {
    if (!backEdges.has(edge)) indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const layer = new Map();
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const own = layer.get(id) ?? 0;
    for (const edge of outgoing.get(id)) {
      if (backEdges.has(edge)) continue;
      const next = layer.get(edge.to);
      if (next === undefined || next < own + 1) layer.set(edge.to, own + 1);
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) {
        if (layer.get(edge.to) === undefined) layer.set(edge.to, own + 1);
        queue.push(edge.to);
      }
    }
  }
  // Nodes stranded by a pathological cycle still get a deterministic slot.
  for (const id of ids) if (layer.get(id) === undefined) layer.set(id, 0);

  const layerValues = [...new Set(ids.map((id) => layer.get(id)))].sort((a, b) => a - b);
  const rowIndexOf = new Map(layerValues.map((value, index) => [value, index]));

  // ---- sizes and row widths ---------------------------------------------
  const sizes = new Map();
  for (const node of nodeList) {
    const label = typeof node.label === "string" ? node.label : node.id;
    sizes.set(node.id, { w: stateWidth(label), h: STATE_H });
  }
  const rows = layerValues.map(() => []);
  for (const node of nodeList) rows[rowIndexOf.get(layer.get(node.id))].push(node);
  const rowWidths = rows.map((row) => {
    const widths = row.map((node) => sizes.get(node.id).w);
    return widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * NODE_GAP;
  });
  const widestRow = rowWidths.length ? Math.max(...rowWidths) : 0;

  // ---- roles -------------------------------------------------------------
  let startNodes = ids.filter((id) => incoming.get(id).length === 0);
  if (startNodes.length === 0 && ids.length) startNodes = [ids[0]];
  const startSet = new Set(startNodes);
  const endNodes = ids.filter((id) => outgoing.get(id).length === 0 && !startSet.has(id));
  const endSet = new Set(endNodes);

  // ---- placement ---------------------------------------------------------
  const boxes = new Map();
  const sceneNodes = [];
  rows.forEach((row, rowIndex) => {
    let x = Math.round((widestRow - rowWidths[rowIndex]) / 2);
    for (const node of row) {
      const size = sizes.get(node.id);
      const entry = {
        id: node.id,
        label: typeof node.label === "string" ? node.label : node.id,
        kind: typeof node.kind === "string" ? node.kind : "state",
        shape: "state",
        role: startSet.has(node.id) ? "start" : endSet.has(node.id) ? "end" : "state",
        x,
        y: rowIndex * (STATE_H + ROW_GAP),
        w: size.w,
        h: size.h,
      };
      if (typeof node.sublabel === "string" && node.sublabel) entry.sublabel = node.sublabel;
      if (typeof node.status === "string") entry.status = node.status;
      sceneNodes.push(entry);
      boxes.set(node.id, entry);
      x += size.w + NODE_GAP;
    }
  });
  let contentRight = 0;
  for (const node of sceneNodes) contentRight = Math.max(contentRight, node.x + node.w);

  // ---- edges -------------------------------------------------------------
  const sceneEdges = [];
  const placedLabels = [];
  const allBoxes = sceneNodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  let channelIndex = 0;
  irEdges.forEach((edge, index) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const fromRow = rowIndexOf.get(layer.get(edge.from));
    const toRow = rowIndexOf.get(layer.get(edge.to));
    const rowSpan = toRow - fromRow;
    let points;
    // Cycle/backward transitions and long skips route around the right channel
    // so they never cross the cards of intermediate rows.
    if (backEdges.has(edge) || rowSpan <= 0 || rowSpan > 1) {
      const channelX = Math.round(contentRight + BACK_CHANNEL_OFFSET + channelIndex * BACK_CHANNEL_GAP);
      channelIndex += 1;
      const sy = from.y + Math.round(from.h / 2);
      const ty = to.y + Math.round(to.h / 2);
      points = [
        { x: from.x + from.w, y: sy },
        { x: channelX, y: sy },
        { x: channelX, y: ty },
        { x: to.x + to.w, y: ty },
      ];
    } else {
      // Downward transition between rows: orthogonal elbow at the midpoint.
      const sx = from.x + Math.round(from.w / 2);
      const sy = from.y + from.h;
      const tx = to.x + Math.round(to.w / 2);
      const ty = to.y;
      const midY = Math.round((sy + ty) / 2);
      points = [
        { x: sx, y: sy },
        { x: sx, y: midY },
        { x: tx, y: midY },
        { x: tx, y: ty },
      ];
    }
    points = simplifyPoints(points);
    const kind = typeof edge.kind === "string" ? edge.kind : "main";
    const entry = {
      id: `e${index + 1}`,
      from: edge.from,
      to: edge.to,
      kind,
      dashed: DASHED_KINDS.has(kind),
      arrow: "end",
      points,
    };
    if (typeof edge.label === "string" && edge.label) {
      entry.label = edge.label;
      const labelBox = placeEdgeLabel(points, edge.label, allBoxes, placedLabels);
      if (labelBox) {
        entry.labelBox = labelBox;
        placedLabels.push(labelBox);
      }
    }
    sceneEdges.push(entry);
  });

  const scene = baseScene(ir, "lifecycle", "TB");
  scene.nodes = sceneNodes;
  scene.groups = [];
  scene.edges = sceneEdges;
  scene.legend = legendFromEdges(sceneEdges, "lifecycle");
  return finalizeCanvas(scene);
}
