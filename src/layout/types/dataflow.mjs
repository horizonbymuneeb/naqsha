// Layout for type "dataflow" — owner: types-time (see src/CONTRACT.md
// §"v1.2 — the other seven diagram types", NORMATIVE).
//
// Pipelines read left-to-right: `node.stage` values, in declaration order,
// define the columns; every column is wrapped in a `zone` group whose label is
// the stage header. Nodes are cards/pills/notes (per kind) centered in their
// column; flows are orthogonal, left-to-right edges with label boxes.
//
// Deterministic: no clock, no randomness, declaration-order ties.

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  DASHED_KINDS,
  placeEdgeLabel,
} from "../geometry.mjs";

const HEADER_BAND = 26; // group label band the view draws the stage header in
const GROUP_INSET_X = 14;
const GROUP_INSET_BOTTOM = 14;
const COL_GAP = 104; // space between stage groups for edges + labels
const NODE_GAP = 26; // vertical gap between nodes in a column
const CARD_MIN_W = 132;
const PILL_MIN_W = 120;
const NOTE_MIN_W = 120;
const NODE_MAX_W = 240;

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
/* Node sizing                                                               */
/* ------------------------------------------------------------------------- */

function shapeFor(node) {
  if (node.kind === "note") return "note";
  if (node.kind === "actor" || node.kind === "external") return "pill";
  return "card";
}

function sizeNode(node) {
  const label = typeof node.label === "string" ? node.label : node.id;
  const shape = shapeFor(node);
  let minW = CARD_MIN_W;
  if (shape === "pill") minW = PILL_MIN_W;
  if (shape === "note") minW = NOTE_MIN_W;
  const w = Math.max(minW, Math.min(NODE_MAX_W, Math.ceil(textWidth(label, 13)) + 26));
  const h = shape === "note" ? 56 : node.sublabel ? 78 : 60;
  return { shape, w, h };
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

function slug(value) {
  const slugged = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged || "stage";
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a `dataflow` IR into a scene v3 document.
 * @param {object} ir validated IR
 * @returns {object} scene
 */
export function layoutDataflow(ir) {
  if (!ir || typeof ir !== "object") throw new TypeError("layoutDataflow(ir): expected an IR object");

  const nodeList = Array.isArray(ir.nodes) ? ir.nodes.filter((node) => node && typeof node.id === "string") : [];
  /** @type {Array<{id:string,label:string,nodes:Array<object>}>} */
  const stages = [];
  const stageByKey = new Map();
  for (const node of nodeList) {
    const raw = typeof node.stage === "string" ? node.stage.trim() : "";
    const key = raw.length ? raw : "__default";
    let stage = stageByKey.get(key);
    if (!stage) {
      stage = { key, id: "", label: raw || "Flow", nodes: [] };
      stageByKey.set(key, stage);
      stages.push(stage);
    }
    stage.nodes.push(node);
  }
  // Unique, readable group ids derived from the stage name.
  const usedIds = new Set();
  for (const stage of stages) {
    const base = slug(stage.label);
    let id = base;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    usedIds.add(id);
    stage.id = id;
  }

  // ---- column metrics ----------------------------------------------------
  const sizes = new Map();
  for (const node of nodeList) sizes.set(node.id, sizeNode(node));
  const columns = stages.map((stage) => {
    const colW = Math.max(...stage.nodes.map((node) => sizes.get(node.id).w));
    const colH = stage.nodes.reduce((sum, node) => sum + sizes.get(node.id).h, 0) + Math.max(0, stage.nodes.length - 1) * NODE_GAP;
    return { stage, w: colW, h: colH };
  });
  const maxColH = columns.length ? Math.max(...columns.map((col) => col.h)) : 0;

  const boxes = new Map();
  const sceneNodes = [];
  const sceneGroups = [];
  let cursorX = 0;
  for (const column of columns) {
    const group = {
      id: column.stage.id,
      label: column.stage.label,
      kind: "zone",
      x: cursorX - GROUP_INSET_X,
      y: -HEADER_BAND,
      w: column.w + GROUP_INSET_X * 2,
      h: maxColH + HEADER_BAND + GROUP_INSET_BOTTOM,
    };
    sceneGroups.push(group);
    let nodeY = Math.round((maxColH - column.h) / 2);
    for (const node of column.stage.nodes) {
      const size = sizes.get(node.id);
      const x = cursorX + Math.round((column.w - size.w) / 2);
      const entry = {
        id: node.id,
        label: typeof node.label === "string" ? node.label : node.id,
        kind: typeof node.kind === "string" ? node.kind : "service",
        shape: size.shape,
        x,
        y: nodeY,
        w: size.w,
        h: size.h,
        group: column.stage.id,
      };
      if (typeof node.sublabel === "string" && node.sublabel) entry.sublabel = node.sublabel;
      if (typeof node.status === "string") entry.status = node.status;
      sceneNodes.push(entry);
      boxes.set(entry.id, entry);
      nodeY += size.h + NODE_GAP;
    }
    cursorX += column.w + GROUP_INSET_X * 2 + COL_GAP;
  }

  // ---- edges -------------------------------------------------------------
  const sceneEdges = [];
  const placedLabels = [];
  const allBoxes = sceneNodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const columnOf = new Map();
  columns.forEach((column, index) => {
    for (const node of column.stage.nodes) columnOf.set(node.id, index);
  });
  const columnRight = (index) => columns[index].stage.id ? (() => {
    const group = sceneGroups[index];
    return group.x + group.w;
  })() : 0;
  const columnLeft = (index) => sceneGroups[index].x;
  let backward = 0;
  let sameColumn = 0;
  const irEdges = Array.isArray(ir.edges) ? ir.edges : [];
  irEdges.forEach((edge, index) => {
    if (!edge || !boxes.has(edge.from) || !boxes.has(edge.to) || edge.from === edge.to) return;
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const fromCol = columnOf.get(edge.from);
    const toCol = columnOf.get(edge.to);
    let points;
    if (toCol > fromCol) {
      // Forward flow: leave right, arrive left, with a shared vertical channel.
      const sx = from.x + from.w;
      const sy = from.y + Math.round(from.h / 2);
      const tx = to.x;
      const ty = to.y + Math.round(to.h / 2);
      const midX = Math.round((sx + tx) / 2);
      points = [
        { x: sx, y: sy },
        { x: midX, y: sy },
        { x: midX, y: ty },
        { x: tx, y: ty },
      ];
    } else if (toCol < fromCol) {
      // Backward flow: dip below the stage columns so it never crosses a card.
      const sx = from.x + Math.round(from.w / 2);
      const sy = from.y + from.h;
      const tx = to.x + Math.round(to.w / 2);
      const ty = to.y + to.h;
      const channelY = maxColH + GROUP_INSET_BOTTOM + 22 + backward * 16;
      backward += 1;
      points = [
        { x: sx, y: sy },
        { x: sx, y: channelY },
        { x: tx, y: channelY },
        { x: tx, y: ty },
      ];
    } else {
      // Same stage: adjacent cards get a straight vertical hop; anything
      // farther apart routes around the right edge of the column.
      const cx = from.x + Math.round(from.w / 2);
      const sourceTop = from.y < to.y;
      const adjacent = !columns[fromCol].stage.nodes.some((node) => {
        if (node.id === from.id || node.id === to.id) return false;
        const box = boxes.get(node.id);
        const fromC = from.y + from.h / 2;
        const toC = to.y + to.h / 2;
        const nodeC = box.y + box.h / 2;
        return nodeC > Math.min(fromC, toC) && nodeC < Math.max(fromC, toC);
      });
      if (adjacent) {
        points = sourceTop
          ? [{ x: cx, y: from.y + from.h }, { x: cx, y: to.y }]
          : [{ x: cx, y: from.y }, { x: cx, y: to.y + to.h }];
      } else {
        const channelX = columnRight(fromCol) + 20 + sameColumn * 14;
        sameColumn += 1;
        const sx = from.x + from.w;
        const sy = from.y + Math.round(from.h / 2);
        const tx = to.x + to.w;
        const ty = to.y + Math.round(to.h / 2);
        points = [
          { x: sx, y: sy },
          { x: channelX, y: sy },
          { x: channelX, y: ty },
          { x: tx, y: ty },
        ];
      }
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

  const scene = baseScene(ir, "dataflow", "LR");
  scene.nodes = sceneNodes;
  scene.groups = sceneGroups;
  scene.edges = sceneEdges;
  scene.legend = legendFromEdges(sceneEdges);
  return finalizeCanvas(scene);
}
