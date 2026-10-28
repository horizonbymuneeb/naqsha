// Layout for type "waterfall" — owner: types-time (see src/CONTRACT.md
// §"v1.2 — the other seven diagram types", NORMATIVE).
//
// Spans are bars on a horizontal numeric axis in the same unit as
// `start`/`duration`. Spans that overlap in time are stacked on separate rows
// (packed greedily in declaration order); every bar gets a duration label and a
// left-gutter name slot so the view can draw the full text without truncation.
//
// Deterministic: no clock, no randomness, declaration-order ties.

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  DASHED_KINDS,
  placeEdgeLabel,
} from "../geometry.mjs";

const AXIS_TOP = 22; // tick labels sit above the axis line
const BAR_H = 26;
const ROW_GAP = 10;
const ROWS_TOP_GAP = 30;
const MIN_PLOT_WIDTH = 560;
const MIN_LABEL_GUTTER = 96;
const MAX_LABEL_GUTTER = 280;
const MIN_BAR_W = 6;

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

function legendFromEdges(sceneEdges) {
  const used = new Set(sceneEdges.map((edge) => edge.kind || "main"));
  return LEGEND_ORDER.filter((item) => used.has(item.kind)).map(({ kind, label }) => ({ kind, label }));
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

/* ------------------------------------------------------------------------- */
/* Numeric scale                                                             */
/* ------------------------------------------------------------------------- */

function decimalSteps(maxStep) {
  const steps = [];
  for (let exp = -1; exp <= 12; exp += 1) {
    for (const mult of [1, 2, 2.5, 5]) steps.push(mult * 10 ** exp);
  }
  return steps.filter((step) => step > 0 && step <= Math.max(1, maxStep));
}

/** Axis from 0 to a nice rounded max with 4..8 ticks (0 is always a tick). */
function chooseAxis(maxValue) {
  let best = null;
  for (const step of decimalSteps(maxValue)) {
    const rounded = Math.ceil(maxValue / step);
    const count = rounded + 1;
    if (count >= 4 && count <= 8) return { step, max: step * rounded, count };
    if (count < 4 && (best === null || count > best.count)) best = { step, max: step * rounded, count };
  }
  if (best) return best;
  const step = Math.ceil(maxValue / 6);
  return { step, max: step * Math.ceil(maxValue / step), count: Math.ceil(maxValue / step) + 1 };
}

function formatValue(value) {
  if (Number.isInteger(value)) return String(value);
  const text = value.toFixed(2);
  return text.replace(/\.?0+$/, "");
}

/* ------------------------------------------------------------------------- */
/* Edge routing (waterfall IR may carry edges; keep them simple)             */
/* ------------------------------------------------------------------------- */

/** Drop consecutive duplicate vertices (straight runs collapse to 2 points). */
function simplifyPoints(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) out.push(point);
  }
  return out;
}

function routeEdge(from, to) {
  const sy = Math.round(from.y + from.h / 2);
  const ty = Math.round(to.y + to.h / 2);
  const sx = from.x + from.w > to.x ? Math.round(from.x) : Math.round(from.x + from.w);
  const tx = from.x + from.w > to.x ? Math.round(to.x + to.w) : Math.round(to.x);
  if (Math.abs(sy - ty) < 2) return [{ x: sx, y: sy }, { x: tx, y: ty }];
  const midX = Math.round((sx + tx) / 2);
  return [
    { x: sx, y: sy },
    { x: midX, y: sy },
    { x: midX, y: ty },
    { x: tx, y: ty },
  ];
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a `waterfall` IR into a scene v3 document.
 * @param {object} ir validated IR
 * @returns {object} scene
 */
export function layoutWaterfall(ir) {
  if (!ir || typeof ir !== "object") throw new TypeError("layoutWaterfall(ir): expected an IR object");

  const nodeList = Array.isArray(ir.nodes) ? ir.nodes.filter((node) => node && typeof node.id === "string") : [];
  const spans = nodeList.map((node, index) => {
    const start = typeof node.start === "number" && Number.isFinite(node.start) ? Math.max(0, node.start) : 0;
    const duration = typeof node.duration === "number" && Number.isFinite(node.duration) && node.duration > 0 ? node.duration : 1;
    return { node, index, start, duration, end: start + duration };
  });
  const maxEnd = spans.length ? Math.max(...spans.map((span) => span.end)) : 1;
  const axisInfo = chooseAxis(maxEnd);
  const axisMax = Math.max(axisInfo.max, axisInfo.step);
  const tickCount = Math.round(axisMax / axisInfo.step) + 1;

  // ---- rows -------------------------------------------------------------
  // Every span owns one row: a waterfall reads as a list of spans, and each
  // row needs its own left-gutter label slot (packing several spans into one
  // row would overprint their names). Overlapping spans are therefore always
  // on separate lanes. Rows are ordered by start time, declaration-order ties.
  const ordered = spans.slice().sort((a, b) => a.start - b.start || a.index - b.index);
  ordered.forEach((span, rowIndex) => {
    span.row = rowIndex;
  });
  const rows = ordered.map((span) => span.end);

  // ---- geometry ----------------------------------------------------------
  const labelGutter = Math.min(
    MAX_LABEL_GUTTER,
    Math.max(
      MIN_LABEL_GUTTER,
      ...spans.map((span) => textWidth(typeof span.node.label === "string" ? span.node.label : span.node.id, 11) + 24),
    ),
  );
  const plotLeft = labelGutter;
  const plotWidth = Math.max(MIN_PLOT_WIDTH, 900 - PADDING * 2 - labelGutter);
  const plotRight = plotLeft + plotWidth;
  const scaleX = (value) => plotLeft + (value / axisMax) * plotWidth;
  const rowsTop = AXIS_TOP + ROWS_TOP_GAP;
  const rowY = (row) => rowsTop + row * (BAR_H + ROW_GAP);

  // ---- nodes / lanes -----------------------------------------------------
  const sceneNodes = [];
  const boxes = new Map();
  for (const span of ordered) {
    const x = Math.round(scaleX(span.start));
    const durationW = (span.duration / axisMax) * plotWidth;
    const w = Math.max(MIN_BAR_W, Math.round(Math.min(durationW, plotRight - x)));
    const y = rowY(span.row);
    const label = typeof span.node.label === "string" ? span.node.label : span.node.id;
    const valueLabel = formatValue(span.duration);
    const valueW = textWidth(valueLabel, 11) + 2;
    // Keep the duration chip inside wide bars (it would overlap the next bar in
    // the same row otherwise); short bars put it just to the right.
    const valueBox = w >= valueW + 8
      ? { x: x + w - 4 - valueW, y: y + 5, w: valueW, h: 16 }
      : { x: x + w + 6, y: y + 5, w: valueW, h: 16 };
    const entry = {
      id: span.node.id,
      label,
      shape: "span",
      x,
      y,
      w,
      h: BAR_H,
      bar: { start: span.start, duration: span.duration },
      valueLabel,
      labelBox: { x: 0, y, w: labelGutter - 12, h: BAR_H },
      valueBox,
    };
    if (typeof span.node.sublabel === "string" && span.node.sublabel) entry.sublabel = span.node.sublabel;
    if (typeof span.node.kind === "string" && span.node.kind) entry.kind = span.node.kind;
    if (typeof span.node.lane === "string" && span.node.lane) entry.lane = span.node.lane;
    if (typeof span.node.status === "string") entry.status = span.node.status;
    sceneNodes.push(entry);
    boxes.set(entry.id, entry);
  }
  const sceneLanes = [];
  for (let r = 0; r < rows.length; r += 1) {
    sceneLanes.push({ id: `lane-${r + 1}`, label: "", y: rowY(r) - 4, h: BAR_H + 8 });
  }

  // ---- axis --------------------------------------------------------------
  const axisTicks = [];
  for (let i = 0; i < tickCount; i += 1) {
    const value = i * axisInfo.step;
    axisTicks.push({ x: Math.round(scaleX(value)), label: formatValue(value) });
  }
  const axis = {
    kind: "numeric",
    min: 0,
    max: axisMax,
    y: AXIS_TOP,
    x0: Math.round(plotLeft),
    x1: Math.round(plotRight),
    ticks: axisTicks,
  };

  // ---- edges -------------------------------------------------------------
  const sceneEdges = [];
  const placedLabels = [];
  const allBoxes = sceneNodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const irEdges = Array.isArray(ir.edges) ? ir.edges : [];
  irEdges.forEach((edge, index) => {
    if (!edge || !boxes.has(edge.from) || !boxes.has(edge.to) || edge.from === edge.to) return;
    const points = simplifyPoints(routeEdge(boxes.get(edge.from), boxes.get(edge.to)));
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

  const scene = baseScene(ir, "waterfall", "LR");
  scene.axis = axis;
  scene.lanes = sceneLanes;
  scene.nodes = sceneNodes;
  scene.groups = [];
  scene.edges = sceneEdges;
  scene.legend = legendFromEdges(sceneEdges);
  return finalizeCanvas(scene, 900);
}
