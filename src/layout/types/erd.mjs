/**
 * Layout for type "erd" — entity tables in a declaration-order grid.
 *
 * Owner: types-relational. Contract: scene v3 node `shape: "entity"` with
 * `rows: [{label, right, mark}]`, edges carry `card` from IR `cardinality`.
 * Deterministic, zero dependencies, canvas = content + 24px padding.
 */

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  simplifyPoints,
  placeEdgeLabel,
} from "../geometry.mjs";

const HEADER_H = 34;
const ROW_H = 22;
const TABLE_PAD_X = 32; // internal horizontal padding added to content
const MARK_W = 18; // PK / FK / unique mark column
const COLUMN_GAP = 16; // name column -> type column
const MIN_TABLE_W = 180;
const GRID_GAP_X = 72;
const GRID_GAP_Y = 56;
const FONT_HEADER = 13;
const FONT_ROW = 12;

const CARD_ORDER = ["1:1", "1:n", "n:m"];

/* ------------------------------------------------------------------------- */
/* Shared scene scaffolding (kept local: layout/types files are independent)  */
/* ------------------------------------------------------------------------- */

function copyNotes(ir) {
  if (!Array.isArray(ir.notes)) return [];
  return ir.notes.filter((note) => typeof note === "string").slice(0, 4);
}

function baseScene(ir, type) {
  const scene = {
    sceneVersion: 1,
    type,
    direction: "TB", // the ERD grid is column/row based; direction is not used
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

/** Grow the canvas to the content bbox + 24px padding and shift content to 24. */
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
/* Entity tables                                                             */
/* ------------------------------------------------------------------------- */

function entityRows(node) {
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  const hasMarks = attributes.some(
    (attr) => attr && (attr.key === "pk" || attr.key === "fk" || attr.key === "unique"),
  );
  return attributes.map((attr) => {
    const key = attr && attr.key;
    const mark = key === "pk" || key === "fk" || key === "unique" ? key : null;
    return {
      label: String((attr && attr.name) || ""),
      right: String((attr && attr.type) || ""),
      mark,
      hasMarks,
    };
  });
}

function rowContentWidth(row, hasMarks) {
  return (
    (hasMarks ? MARK_W : 0) +
    textWidth(row.label, FONT_ROW) +
    COLUMN_GAP +
    textWidth(row.right, FONT_ROW)
  );
}

function sizeEntity(node) {
  const label = String(node.label ?? node.id ?? "");
  const rows = entityRows(node);
  const hasMarks = rows.length ? rows[0].hasMarks : false;
  let contentW = textWidth(label, FONT_HEADER);
  for (const row of rows) {
    contentW = Math.max(contentW, rowContentWidth(row, hasMarks));
  }
  const w = Math.max(MIN_TABLE_W, contentW + TABLE_PAD_X);
  const h = HEADER_H + rows.length * ROW_H;
  const cleanRows = rows.map((row) => ({
    label: row.label,
    right: row.right,
    mark: row.mark,
  }));
  return { rows: cleanRows, w: Math.ceil(w), h: Math.ceil(h) };
}

/* ------------------------------------------------------------------------- */
/* Grid placement (declaration order, 2-3 columns)                           */
/* ------------------------------------------------------------------------- */

function gridColumns(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

function placeGrid(nodes) {
  const cols = gridColumns(nodes.length);
  const rowCount = Math.ceil(nodes.length / cols);
  const colW = new Array(cols).fill(0);
  const rowH = new Array(rowCount).fill(0);
  nodes.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    colW[col] = Math.max(colW[col], node.w);
    rowH[row] = Math.max(rowH[row], node.h);
  });
  const colX = [];
  let x = 0;
  for (let c = 0; c < cols; c++) {
    colX.push(x);
    x += colW[c] + (c < cols - 1 ? GRID_GAP_X : 0);
  }
  const rowY = [];
  let y = 0;
  for (let r = 0; r < rowCount; r++) {
    rowY.push(y);
    y += rowH[r] + (r < rowCount - 1 ? GRID_GAP_Y : 0);
  }
  nodes.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    node.col = col;
    node.row = row;
    node.x = colX[col] + Math.round((colW[col] - node.w) / 2);
    node.y = rowY[row] + Math.round((rowH[row] - node.h) / 2);
  });
  return { cols, rowCount, width: x, height: y };
}

/* ------------------------------------------------------------------------- */
/* Orthogonal edges between table borders                                    */
/* ------------------------------------------------------------------------- */

/**
 * Pick the facing border pair for a relationship. Same-row pairs meet on the
 * left/right borders, same-column pairs on top/bottom, and diagonal pairs
 * (different row AND column) cross the row gap vertically instead of sharing a
 * border with a same-row edge.
 */
function borderSidePair(from, to) {
  if (from.row === to.row) {
    return to.col > from.col
      ? { fromSide: "right", toSide: "left", axis: "h" }
      : { fromSide: "left", toSide: "right", axis: "h" };
  }
  if (from.col !== to.col) {
    return to.row > from.row
      ? { fromSide: "bottom", toSide: "top", axis: "v" }
      : { fromSide: "top", toSide: "bottom", axis: "v" };
  }
  return to.row > from.row
    ? { fromSide: "bottom", toSide: "top", axis: "v" }
    : { fromSide: "top", toSide: "bottom", axis: "v" };
}

/** Point on a table border, shifted along that border by `offset` pixels. */
function anchorPoint(node, side, offset) {
  const cx = Math.round(node.x + node.w / 2);
  const cy = Math.round(node.y + node.h / 2);
  if (side === "right") return { x: node.x + node.w, y: cy + offset };
  if (side === "left") return { x: node.x, y: cy + offset };
  if (side === "bottom") return { x: cx + offset, y: node.y + node.h };
  return { x: cx + offset, y: node.y };
}

function sideLength(node, side) {
  return side === "left" || side === "right" ? node.h : node.w;
}

/** Orthogonal route between two border anchors (<= 2 bends). */
function routeBetween(start, end, axis) {
  if (axis === "h") {
    if (start.y === end.y) return [start, end];
    const midX = Math.round((start.x + end.x) / 2);
    return [
      start,
      { x: midX, y: start.y },
      { x: midX, y: end.y },
      end,
    ];
  }
  if (start.x === end.x) return [start, end];
  const midY = Math.round((start.y + end.y) / 2);
  return [
    start,
    { x: start.x, y: midY },
    { x: end.x, y: midY },
    end,
  ];
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout an ERD IR into a scene v3 document.
 * @param {object} ir validated IR with type "erd"
 * @returns {object} scene
 */
export function layoutErd(ir) {
  const irNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const nodes = irNodes.map((node) => {
    const sized = sizeEntity(node);
    return {
      id: node.id,
      label: node.label,
      kind: typeof node.kind === "string" && node.kind ? node.kind : "datastore",
      rows: sized.rows,
      w: sized.w,
      h: sized.h,
      x: 0,
      y: 0,
    };
  });
  placeGrid(nodes);

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const irEdges = Array.isArray(ir.edges) ? ir.edges : [];
  const usedCards = new Set();

  // First decide the facing borders, then spread every anchor that lands on the
  // same border so two cardinality pills can never sit on the same coordinate.
  const plans = [];
  const portBuckets = new Map();
  irEdges.forEach((edge, index) => {
    if (!edge || !nodesById.has(edge.from) || !nodesById.has(edge.to)) return;
    if (edge.from === edge.to) return;
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    const sides = borderSidePair(from, to);
    const card =
      CARD_ORDER.indexOf(edge.cardinality) >= 0 ? edge.cardinality : "1:n";
    usedCards.add(card);
    const plan = {
      index,
      from: edge.from,
      to: edge.to,
      fromSide: sides.fromSide,
      toSide: sides.toSide,
      axis: sides.axis,
      card,
      label:
        typeof edge.label === "string" && edge.label.length ? edge.label : null,
      fromOffset: 0,
      toOffset: 0,
    };
    const addPort = (nodeId, side, role) => {
      const key = `${nodeId}:${side}`;
      if (!portBuckets.has(key)) portBuckets.set(key, []);
      portBuckets.get(key).push({ plan, role });
    };
    addPort(edge.from, sides.fromSide, "from");
    addPort(edge.to, sides.toSide, "to");
    plans.push(plan);
  });
  for (const [key, list] of portBuckets) {
    const separator = key.lastIndexOf(":");
    const node = nodesById.get(key.slice(0, separator));
    const side = key.slice(separator + 1);
    const limit = Math.max(0, Math.floor(sideLength(node, side) / 2) - 8);
    list.forEach((item, portIndex) => {
      const raw = Math.round((portIndex - (list.length - 1) / 2) * 16);
      const offset = Math.max(-limit, Math.min(limit, raw));
      if (item.role === "from") item.plan.fromOffset = offset;
      else item.plan.toOffset = offset;
    });
  }
  const edges = plans.map((plan) => {
    const start = anchorPoint(
      nodesById.get(plan.from),
      plan.fromSide,
      plan.fromOffset,
    );
    const end = anchorPoint(nodesById.get(plan.to), plan.toSide, plan.toOffset);
    return {
      id: `e${plan.index + 1}`,
      from: plan.from,
      to: plan.to,
      kind: "main",
      card: plan.card,
      label: plan.label,
      points: simplifyPoints(routeBetween(start, end, plan.axis)),
    };
  });

  // Label chips are placed after every route so each can dodge nodes/chips.
  const allBoxes = nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const placedChips = [];
  for (const edge of edges) {
    if (!edge.label) continue;
    const labelBox = placeEdgeLabel(edge.points, edge.label, allBoxes, placedChips);
    if (labelBox) {
      edge.labelBox = labelBox;
      placedChips.push(labelBox);
    }
  }

  const scene = baseScene(ir, "erd");
  scene.nodes = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    shape: "entity",
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    rows: node.rows,
  }));
  scene.groups = [];
  scene.edges = edges.map((edge) => {
    const entry = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      dashed: false,
      arrow: "end",
      card: edge.card,
      points: edge.points,
    };
    if (edge.label) entry.label = edge.label;
    if (edge.labelBox) entry.labelBox = edge.labelBox;
    return entry;
  });
  scene.legend = CARD_ORDER.filter((card) => usedCards.has(card)).map((card) => ({
    kind: "main",
    label: `${card} relationship`,
  }));
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return finalizeCanvas(scene);
}
