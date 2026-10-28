// Layout for type "timeline" — owner: types-time (see src/CONTRACT.md
// §"v1.2 — the other seven diagram types", NORMATIVE).
//
// A horizontal time axis with 4..8 nice ticks runs across the top. Events are
// cards (`shape: "event"`) placed at their `at` position inside lane bands
// derived from `node.lane`; same-lane cards that collide alternate between two
// rows and then nudge right deterministically, and every card carries a leader
// polyline back to its exact axis point.
//
// Deterministic: no clock, no randomness, declaration-order ties.

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  DASHED_KINDS,
  placeEdgeLabel,
} from "../geometry.mjs";

const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Nice steps in days for a date axis: quarter/half day up to years.
const DATE_STEPS = [0.25, 0.5, 1, 2, 3, 7, 14, 30, 60, 90, 180, 365, 730, 1460, 2920, 5840, 11680];

const AXIS_TOP = 22; // tick labels sit above the axis line
const LANE_GAP = 10;
const LANE_TOP_PAD = 14;
const LANE_BOTTOM_PAD = 14;
const LANE_ROW_GAP = 12;
const EVENT_MIN_W = 112;
const EVENT_MAX_W = 240;
const EVENT_H = 44;
const LANE_HEIGHT = LANE_TOP_PAD + EVENT_H + LANE_ROW_GAP + EVENT_H + LANE_BOTTOM_PAD;
const EVENT_GAP = 12;

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
/* Time scale                                                                */
/* ------------------------------------------------------------------------- */

/** Read `at` (ISO date or number) into a day-unit value. */
function readAt(node) {
  if (typeof node.at === "number" && Number.isFinite(node.at)) return { value: node.at, numeric: true };
  if (typeof node.at === "string") {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(node.at) ? `${node.at}T00:00:00Z` : node.at;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return { value: ms / DAY_MS, numeric: false };
  }
  return { value: 0, numeric: true };
}

function formatDate(value, step) {
  const date = new Date(Math.round(value * DAY_MS));
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  if (step >= 1) return day;
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

function formatNumber(value, step) {
  if (step >= 1) return String(Math.round(value));
  const digits = step < 0.1 ? 2 : 1;
  return value.toFixed(digits);
}

function decimalSteps(maxStep) {
  const steps = [];
  for (let exp = -1; exp <= 12; exp += 1) {
    for (const mult of [1, 2, 2.5, 5]) steps.push(mult * 10 ** exp);
  }
  return steps.filter((step) => step > 0 && step <= Math.max(1, maxStep));
}

/**
 * 4..8 nice ticks covering [lo, hi]. The domain snaps to the chosen step, so
 * axis.min/axis.max are exactly the first/last tick values.
 */
function chooseTicks(lo, hi, dateMode) {
  let start = lo;
  let end = hi;
  if (!(end > start)) {
    // A one-instant timeline still needs a readable axis: open a whole day on
    // each side for dates, a sane unit window for numbers.
    const pad = dateMode ? 1 : Math.max(1, Math.abs(start) * 0.1);
    start -= pad;
    end += pad;
  }
  const steps = dateMode ? DATE_STEPS : decimalSteps(end - start);
  let bestSmall = null;
  for (const step of steps) {
    const snappedStart = Math.floor(start / step) * step;
    const snappedEnd = Math.ceil(end / step) * step;
    const count = Math.round((snappedEnd - snappedStart) / step) + 1;
    if (count >= 4 && count <= 8) return { step, start: snappedStart, end: snappedEnd, count };
    if (count < 4 && (bestSmall === null || count > bestSmall.count)) {
      bestSmall = { step, start: snappedStart, end: snappedEnd, count };
    }
  }
  const step = (end - start) / 3;
  return { step, start, end, count: 4 };
}

/* ------------------------------------------------------------------------- */
/* Edge routing (timeline diagrams usually have no edges; keep them simple)  */
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
  const sx = Math.round(from.x + from.w / 2);
  const sy = Math.round(from.y + from.h / 2);
  const tx = Math.round(to.x + to.w / 2);
  const ty = Math.round(to.y + to.h / 2);
  if (Math.abs(sy - ty) < 2) return [{ x: sx, y: sy }, { x: tx, y: ty }];
  const midY = Math.round((sy + ty) / 2);
  return [
    { x: sx, y: sy },
    { x: sx, y: midY },
    { x: tx, y: midY },
    { x: tx, y: ty },
  ];
}

function slug(value) {
  const slugged = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged || "lane";
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a `timeline` IR into a scene v3 document.
 * @param {object} ir validated IR
 * @returns {object} scene
 */
export function layoutTimeline(ir) {
  if (!ir || typeof ir !== "object") throw new TypeError("layoutTimeline(ir): expected an IR object");

  const nodeList = Array.isArray(ir.nodes) ? ir.nodes.filter((node) => node && typeof node.id === "string") : [];
  const events = nodeList.map((node, index) => {
    const at = readAt(node);
    return { node, index, value: at.value, numeric: at.numeric };
  });
  const dateMode = events.some((event) => !event.numeric);

  const values = events.map((event) => event.value);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const ticks = chooseTicks(lo, hi, dateMode);
  const domainStart = ticks.start;
  const domainEnd = ticks.end;

  // ---- lanes (declaration order of first appearance) ---------------------
  const hasLanes = nodeList.some((node) => typeof node.lane === "string" && node.lane.trim().length > 0);
  /** @type {Array<{id:string,label:string,events:Array<object>}>} */
  const laneBuckets = [];
  const laneByKey = new Map();
  for (const event of events) {
    const raw = typeof event.node.lane === "string" ? event.node.lane.trim() : "";
    const key = hasLanes ? (raw.length ? raw : "__other") : "__all";
    let bucket = laneByKey.get(key);
    if (!bucket) {
      bucket = {
        id: hasLanes ? (key === "__other" ? "other" : slug(key)) : "events",
        label: hasLanes ? (raw || "Other") : "",
        events: [],
      };
      laneByKey.set(key, bucket);
      laneBuckets.push(bucket);
    }
    bucket.events.push(event);
  }

  // ---- card sizing and plot box -----------------------------------------
  const cardWidth = new Map();
  let maxCardW = EVENT_MIN_W;
  for (const event of events) {
    const label = typeof event.node.label === "string" ? event.node.label : event.node.id;
    const w = Math.max(EVENT_MIN_W, Math.min(EVENT_MAX_W, Math.ceil(textWidth(label, 11)) + 26));
    cardWidth.set(event.node.id, w);
    if (w > maxCardW) maxCardW = w;
  }
  const laneLabelW = hasLanes
    ? Math.max(72, ...laneBuckets.map((lane) => textWidth(lane.label, 11) + 24))
    : 0;
  const plotLeft = laneLabelW + 16 + Math.ceil(maxCardW / 2);
  const plotWidth = Math.max(560, 900 - PADDING * 2 - plotLeft - Math.ceil(maxCardW / 2));
  const plotRight = plotLeft + plotWidth;
  const scaleX = (value) => plotLeft + ((value - domainStart) / (domainEnd - domainStart)) * plotWidth;

  // ---- events on lane bands ---------------------------------------------
  const boxes = new Map();
  const sceneNodes = [];
  const sceneLanes = [];
  let laneTop = AXIS_TOP + 32;

  for (const lane of laneBuckets) {
    const items = lane.events
      .slice()
      .sort((a, b) => scaleX(a.value) - scaleX(b.value) || a.index - b.index);
    const rows = [[], []];
    for (const event of items) {
      const width = cardWidth.get(event.node.id);
      const desired = scaleX(event.value);
      let x = Math.round(desired - width / 2);
      if (x < laneLabelW + 8) x = laneLabelW + 8;
      if (x + width > plotRight + Math.ceil(maxCardW / 2)) {
        x = plotRight + Math.ceil(maxCardW / 2) - width;
      }
      let row = -1;
      for (let candidate = 0; candidate < 2; candidate += 1) {
        const fits = rows[candidate].every(
          (other) => x >= other.x1 + EVENT_GAP || x + width <= other.x0 - EVENT_GAP,
        );
        if (fits) {
          row = candidate;
          break;
        }
      }
      if (row === -1) {
        // Both rows busy: stay on row 0 and nudge deterministically past the last card.
        row = 0;
        const last = rows[0][rows[0].length - 1];
        if (last) x = last.x1 + EVENT_GAP;
      }
      rows[row].push({ x0: x, x1: x + width });
      const y = laneTop + LANE_TOP_PAD + row * (EVENT_H + LANE_ROW_GAP);
      const axisPoint = { x: Math.round(desired), y: AXIS_TOP + 8 };
      const anchorX = x + Math.round(width / 2);
      const anchorY = y;
      let leader;
      if (row === 0) {
        leader = Math.abs(anchorX - axisPoint.x) < 2
          ? [{ x: anchorX, y: anchorY }, { x: axisPoint.x, y: axisPoint.y }]
          : [
              { x: anchorX, y: anchorY },
              { x: anchorX, y: anchorY - 6 },
              { x: axisPoint.x, y: anchorY - 6 },
              { x: axisPoint.x, y: axisPoint.y },
            ];
      } else {
        // Second-row cards clear the first row on a rail left of the card, then
        // run up to the axis point.
        const railX = x - 8;
        leader = [
          { x, y: anchorY },
          { x: railX, y: anchorY },
          { x: railX, y: axisPoint.y },
          { x: axisPoint.x, y: axisPoint.y },
        ];
      }
      const entry = {
        id: event.node.id,
        label: typeof event.node.label === "string" ? event.node.label : event.node.id,
        shape: "event",
        x,
        y,
        w: width,
        h: EVENT_H,
        at: event.node.at,
        leader,
      };
      if (typeof event.node.sublabel === "string" && event.node.sublabel) entry.sublabel = event.node.sublabel;
      if (typeof event.node.kind === "string" && event.node.kind) entry.kind = event.node.kind;
      if (typeof event.node.status === "string") entry.status = event.node.status;
      sceneNodes.push(entry);
      boxes.set(entry.id, entry);
    }
    sceneLanes.push({ id: lane.id, label: lane.label, y: laneTop, h: LANE_HEIGHT });
    laneTop += LANE_HEIGHT + LANE_GAP;
  }

  // ---- axis --------------------------------------------------------------
  const axisTicks = [];
  for (let i = 0; i < ticks.count; i += 1) {
    const value = domainStart + i * ticks.step;
    axisTicks.push({
      x: Math.round(scaleX(value)),
      label: dateMode ? formatDate(value, ticks.step) : formatNumber(value, ticks.step),
    });
  }
  const axis = {
    kind: "time",
    min: domainStart,
    max: domainEnd,
    y: AXIS_TOP,
    x0: Math.round(plotLeft),
    x1: Math.round(plotRight),
    ticks: axisTicks,
  };

  // ---- edges (allowed by the IR; draw them as simple elbows) -------------
  const sceneEdges = [];
  const placedLabels = [];
  const allBoxes = sceneNodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const irEdges = Array.isArray(ir.edges) ? ir.edges : [];
  irEdges.forEach((edge, index) => {
    if (!edge || !boxes.has(edge.from) || !boxes.has(edge.to) || edge.from === edge.to) return;
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const points = simplifyPoints(routeEdge(from, to));
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

  const scene = baseScene(ir, "timeline", "LR");
  scene.axis = axis;
  if (hasLanes) scene.lanes = sceneLanes;
  scene.nodes = sceneNodes;
  scene.groups = [];
  scene.edges = sceneEdges;
  scene.legend = legendFromEdges(sceneEdges);
  return finalizeCanvas(scene, 900);
}
