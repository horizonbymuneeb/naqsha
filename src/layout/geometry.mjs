/**
 * Naqsha layout geometry — pure, deterministic helpers.
 *
 * Zero dependencies, no randomness, no clock, no I/O. Everything here is a
 * function of its arguments only, so `layout(ir)` stays byte-identical.
 *
 * Coordinate model ("abstract space") used by the layered engine:
 *   c = cross axis — the axis nodes of one layer spread along
 *   d = depth axis — the axis layers stack along (rank grows with d)
 * TB: screen x = c, screen y = d.  LR: screen x = d, screen y = c.
 *
 * Text metrics are deliberately conservative: they must never report a string
 * narrower than the system sans renders it, because the view clips any text
 * wider than its box.
 */

export const PADDING = 24;
export const NODE_GAP = 32;
export const LANE_GAP = 32;
export const LAYER_GAP_ARCHITECTURE = 88;
export const LAYER_GAP_WORKFLOW = 72;
export const GROUP_INSET_SIDE = 14;
export const GROUP_INSET_BOTTOM = 14;
export const GROUP_INSET_TOP = 26;
export const ROUTE_MARGIN = 20;
export const LABEL_HEIGHT = 18;
export const LABEL_OFFSET = 8;
export const MIN_CANVAS_WIDTH = 320;
export const MIN_CARD_WIDTH = 156;
export const MIN_PILL_WIDTH = 132;
export const MIN_DIAMOND_WIDTH = 140;
export const MIN_PARTICIPANT_WIDTH = 120;
export const PARTICIPANT_CARD_H = 56;
export const FONT_LABEL = 13;
export const FONT_SUBLABEL = 11;
export const FONT_EDGE_LABEL = 11;
export const FONT_GROUP_LABEL = 11;
export const GROUP_LABEL_INSET = 24; // view draws group labels at x+12, clips at w-24

/** Edge kinds rendered with a dashed/dotted stroke rather than a solid one. */
export const DASHED_KINDS = new Set(["return", "async", "data"]);

/** Vertical space between layers: architecture breathes more than workflows. */
export function layerGapFor(type) {
  return type === "workflow" ? LAYER_GAP_WORKFLOW : LAYER_GAP_ARCHITECTURE;
}

/* ------------------------------------------------------------------------- */
/* Text metrics                                                              */
/* ------------------------------------------------------------------------- */

const WIDE_CHARS = new Set(["M", "W", "m", "w", "@", "%", "&"]);
const DIGIT = /^[0-9]$/;
const UPPER = /^[A-Z]$/;
const LOWER = /^[a-z]$/;

/**
 * Conservative width of `text` at `fontSize` px (humanist sans).
 * Base table from the design review: uppercase 0.62em, lowercase 0.55em,
 * digits 0.58em, space 0.30em, punctuation 0.34em, wide glyphs 0.85em;
 * never narrower than a flat 0.55em/char floor so a browser that measures by
 * average advance cannot overflow the box we derive from this.
 */
export function textWidth(text, fontSize = 12) {
  const s = text == null ? "" : String(text);
  if (!s) return 0;
  let em = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === " ") em += 0.3;
    else if (WIDE_CHARS.has(ch)) em += 0.85;
    else if (DIGIT.test(ch)) em += 0.58;
    else if (UPPER.test(ch)) em += 0.62;
    else if (LOWER.test(ch)) em += 0.55;
    else if (cp > 0x2e7f) em += 1.0; // CJK / full-width glyphs
    else em += 0.34; // punctuation and symbols
  }
  return Math.ceil(Math.max(em, s.length * 0.55) * fontSize);
}

/** Width of the edge-label chip the view draws for an 11px label. */
export function labelChipWidth(label) {
  return textWidth(label, FONT_EDGE_LABEL) + 14;
}

/** Width the view's group-label text needs (labels are uppercased). */
export function groupLabelWidth(label) {
  return textWidth(String(label || "").toUpperCase(), FONT_GROUP_LABEL);
}

/* ------------------------------------------------------------------------- */
/* Node shapes and sizes                                                     */
/* ------------------------------------------------------------------------- */

function isSingleShortWord(label) {
  const raw = String(label || "").trim();
  return raw.length > 0 && raw.length <= 12 && !/\s/.test(raw);
}

/** Map an IR node kind to a scene shape. */
export function shapeForKind(kind, node, type) {
  if (type === "sequence") return "participant";
  if (kind === "note") return "note";
  if (kind === "actor" || kind === "external") return "pill";
  if (kind === "security") {
    const label = node && node.label != null ? node.label : "";
    const hasSublabel = !!(node && node.sublabel);
    // A diamond only earns its shape for one short word and no second line;
    // anything longer becomes a card so nothing has to wrap inside a rhombus.
    return !hasSublabel && isSingleShortWord(label) ? "diamond" : "card";
  }
  return "card";
}

/**
 * Size one node. Cards: label 13px + optional sublabel 11px on a second line,
 * 40px content + 24px baseline padding => 64 / 80px tall.
 * Returns { shape, w, h } with integer dimensions.
 */
export function sizeNode(node, type) {
  const label = String(node.label ?? node.id ?? "");
  const sublabel = typeof node.sublabel === "string" ? node.sublabel : "";
  const kind = node.kind || "service";
  const shape = shapeForKind(kind, node, type);
  const labelW = textWidth(label, FONT_LABEL);
  const subW = sublabel ? textWidth(sublabel, FONT_SUBLABEL) : 0;
  const contentW = Math.max(labelW, subW);
  let w;
  let h;
  switch (shape) {
    case "card":
      w = Math.max(MIN_CARD_WIDTH, contentW + 36);
      h = 40 + (sublabel ? 16 : 0) + 24;
      break;
    case "pill":
      w = Math.max(MIN_PILL_WIDTH, contentW + 44);
      h = 44 + (sublabel ? 16 : 0);
      break;
    case "diamond":
      w = Math.max(MIN_DIAMOND_WIDTH, Math.ceil(labelW * 1.5) + 24);
      h = 84;
      break;
    case "note": {
      const wrapWidth = 212;
      const lines = Math.max(1, Math.ceil(labelW / wrapWidth));
      w = 240;
      h = Math.max(64, 40 + (lines - 1) * 18 + (sublabel ? 16 : 0) + 24);
      break;
    }
    case "participant":
    default:
      w = Math.max(MIN_PARTICIPANT_WIDTH, contentW + 28);
      h = PARTICIPANT_CARD_H;
      break;
  }
  return { shape, w: Math.ceil(w), h: Math.ceil(h) };
}

/* ------------------------------------------------------------------------- */
/* Layering (longest path over a cycle-broken DAG)                           */
/* ------------------------------------------------------------------------- */

/**
 * Build the layered DAG.
 * Cycles are broken deterministically by declared edge order: a depth-first
 * walk over nodes/edges in declaration order marks edges back into the active
 * stack as feedback edges; those are ignored for ranking but stay in the
 * drawing. Longest-path ranking then runs over the remaining DAG.
 *
 * @returns {{rank: Map<string, number>, layers: string[][], backEdges: Set<number>}}
 */
export function layerGraph(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const out = new Map();
  for (const id of ids) out.set(id, []);
  edges.forEach((e, index) => {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) return;
    out.get(e.from).push({ to: e.to, index });
  });

  const state = new Map();
  for (const id of ids) state.set(id, 0);
  const post = [];
  const backEdges = new Set();

  const visit = (id) => {
    state.set(id, 1);
    for (const { to, index } of out.get(id)) {
      const st = state.get(to);
      if (st === 1) backEdges.add(index); // feedback edge for ranking only
      else if (st === 0) visit(to);
    }
    state.set(id, 2);
    post.push(id);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);

  // Reverse postorder is a topological order of the remaining DAG.
  const topo = post.slice().reverse();
  const rank = new Map();
  for (const id of ids) rank.set(id, 0);
  for (const id of topo) {
    const r = rank.get(id);
    for (const { to, index } of out.get(id)) {
      if (backEdges.has(index)) continue;
      if (r + 1 > rank.get(to)) rank.set(to, r + 1);
    }
  }

  let maxRank = 0;
  for (const id of ids) if (rank.get(id) > maxRank) maxRank = rank.get(id);
  const layers = [];
  for (let i = 0; i <= maxRank; i++) layers.push([]);
  for (const id of ids) layers[rank.get(id)].push(id);
  return { rank, layers, backEdges };
}

/**
 * Barycenter crossing reduction: 4 sweeps (down/up/down/up), sorting each
 * layer by the average cross position of its neighbours in the previous
 * (down sweep) or next (up sweep) layer. Ties fall back to declaration order.
 */
export function orderLayers(layers, edges, declaredIndex) {
  const layerOf = new Map();
  layers.forEach((layer, li) => {
    for (const id of layer) layerOf.set(id, li);
  });
  const preds = new Map();
  const succs = new Map();
  for (const layer of layers) {
    for (const id of layer) {
      preds.set(id, []);
      succs.set(id, []);
    }
  }
  for (const e of edges) {
    if (!layerOf.has(e.from) || !layerOf.has(e.to) || e.from === e.to) continue;
    preds.get(e.to).push({ id: e.from, layer: layerOf.get(e.from) });
    succs.get(e.from).push({ id: e.to, layer: layerOf.get(e.to) });
  }

  const order = layers.map((layer) => layer.slice());
  const pos = new Map();
  const syncPositions = () => {
    order.forEach((layer) => layer.forEach((id, idx) => pos.set(id, idx)));
  };
  syncPositions();

  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const from = down ? 1 : order.length - 2;
    const to = down ? order.length : -1;
    const step = down ? 1 : -1;
    for (let li = from; li !== to; li += step) {
      if (li < 0 || li >= order.length) continue;
      const neighbours = down ? preds : succs;
      const neighbourLayer = down ? li - 1 : li + 1;
      const keys = new Map();
      for (const id of order[li]) {
        let sum = 0;
        let count = 0;
        for (const item of neighbours.get(id) || []) {
          if (item.layer !== neighbourLayer) continue;
          sum += pos.get(item.id);
          count++;
        }
        keys.set(id, count ? sum / count : pos.get(id));
      }
      order[li].sort(
        (a, b) =>
          keys.get(a) - keys.get(b) ||
          (declaredIndex.get(a) ?? 0) - (declaredIndex.get(b) ?? 0),
      );
      order[li].forEach((id, idx) => pos.set(id, idx));
    }
  }
  return order;
}

/* ------------------------------------------------------------------------- */
/* Lane / column packing                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Place layered nodes in abstract cross/depth coordinates.
 *
 * Grouped nodes live in group "lanes" (columns). Groups whose layer ranges are
 * disjoint share a lane; overlapping ranges land in separate lanes so their
 * rectangles can never collide. Every lane is wide enough for the group's
 * heaviest layer AND for the group's label band.
 *
 * Ungrouped nodes are placed per layer into the space left free by the groups
 * active in that layer, steered towards the average position of their
 * neighbours (so entry actors sit above what they talk to instead of in a
 * far-off corner). A few deterministic refinement sweeps settle that.
 */
export function packLayered({
  layers,
  sizes,
  groupOf,
  groupIds,
  groupLabels,
  neighbours,
  declaredIndex,
  layerGap,
}) {
  const layerStart = [];
  const layerDepth = [];
  for (let li = 0; li < layers.length; li++) {
    let depth = 0;
    for (const id of layers[li]) depth = Math.max(depth, sizes.get(id).ah);
    layerDepth.push(depth);
    layerStart.push(
      li === 0 ? 0 : layerStart[li - 1] + layerDepth[li - 1] + layerGap,
    );
  }

  const totalOf = (ids) =>
    ids.reduce((sum, id) => sum + sizes.get(id).aw, 0) +
    NODE_GAP * Math.max(0, ids.length - 1);

  const memberLayers = new Map();
  for (const gid of groupIds) memberLayers.set(gid, new Map());
  const freeByLayer = new Map();
  const freeIds = [];
  layers.forEach((layer, li) => {
    const free = [];
    for (const id of layer) {
      const gid = groupOf.get(id);
      if (gid && memberLayers.has(gid)) {
        const byLayer = memberLayers.get(gid);
        if (!byLayer.has(li)) byLayer.set(li, []);
        byLayer.get(li).push(id);
      } else {
        free.push(id);
        freeIds.push(id);
      }
    }
    if (free.length) freeByLayer.set(li, free);
  });

  // Group metadata: layer range, heaviest layer width, label width.
  const groupInfo = new Map();
  groupIds.forEach((gid, order) => {
    const byLayer = memberLayers.get(gid);
    let minL = Infinity;
    let maxL = -1;
    let memberTotal = 0;
    for (const [li, ids] of byLayer) {
      if (li < minL) minL = li;
      if (li > maxL) maxL = li;
      memberTotal = Math.max(memberTotal, totalOf(ids));
    }
    if (maxL < 0) {
      minL = 0;
      maxL = 0;
    }
    const labelW = groupLabelWidth(groupLabels.get(gid) || gid);
    const requiredWidth = Math.max(
      memberTotal + GROUP_INSET_SIDE * 2,
      labelW + GROUP_LABEL_INSET + 8,
    );
    groupInfo.set(gid, {
      minL,
      maxL,
      memberTotal,
      requiredWidth,
      order,
      lane: -1,
    });
  });

  // Interval colouring: reuse the lowest lane whose last end is strictly
  // above this group's first layer (so group rectangles never share rows).
  const lanes = [];
  const groupsByStart = [...groupIds].sort(
    (a, b) =>
      groupInfo.get(a).minL - groupInfo.get(b).minL ||
      groupInfo.get(a).order - groupInfo.get(b).order,
  );
  for (const gid of groupsByStart) {
    const info = groupInfo.get(gid);
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].lastEnd < info.minL) {
        lane = i;
        break;
      }
    }
    if (lane === -1) {
      lanes.push({ width: 0, lastEnd: -1 });
      lane = lanes.length - 1;
    }
    lanes[lane].lastEnd = Math.max(lanes[lane].lastEnd, info.maxL);
    lanes[lane].width = Math.max(lanes[lane].width, info.requiredWidth);
    info.lane = lane;
  }

  const laneX = [];
  let cursor = 0;
  for (let i = 0; i < lanes.length; i++) {
    laneX.push(cursor);
    cursor += lanes[i].width;
    if (i < lanes.length - 1) cursor += LANE_GAP;
  }
  const lanesEnd = cursor;

  // Without any lanes the row is sized by the widest layer of free nodes.
  let maxFreeTotal = 0;
  for (const ids of freeByLayer.values()) maxFreeTotal = Math.max(maxFreeTotal, totalOf(ids));
  const gapRight = lanes.length ? lanesEnd : maxFreeTotal;
  const centerBase = lanes.length ? lanesEnd : maxFreeTotal;

  const allPos = new Map();
  const depthFor = (li, ah) =>
    layerStart[li] + Math.round((layerDepth[li] - ah) / 2);

  // 1) Group members are pinned inside their lane, centred per layer.
  for (let li = 0; li < layers.length; li++) {
    for (const gid of groupIds) {
      const info = groupInfo.get(gid);
      if (li < info.minL || li > info.maxL) continue;
      const ids = memberLayers.get(gid).get(li);
      if (!ids || !ids.length) continue;
      const total = totalOf(ids);
      let x = laneX[info.lane] + Math.round((lanes[info.lane].width - total) / 2);
      for (const id of ids) {
        const size = sizes.get(id);
        allPos.set(id, { ax: x, ay: depthFor(li, size.ah), aw: size.aw, ah: size.ah });
        x += size.aw + NODE_GAP;
      }
    }
  }

  // Lane bands active per layer: the cross interval a group rectangle can
  // occupy, and therefore where ungrouped nodes must not go.
  const laneBands = new Map();
  for (let li = 0; li < layers.length; li++) {
    const bands = [];
    for (const gid of groupIds) {
      const info = groupInfo.get(gid);
      if (li < info.minL || li > info.maxL) continue;
      const lane = info.lane;
      bands.push({
        lane,
        start: laneX[lane],
        end: laneX[lane] + lanes[lane].width,
      });
    }
    bands.sort((a, b) => a.start - b.start);
    laneBands.set(li, bands);
  }

  // 2) Ungrouped nodes.
  // Without groups there is no column structure to respect: pack every row
  // left-to-right like a plain layered layout.
  const targets = new Map();
  for (const id of freeIds) targets.set(id, centerBase / 2);
  if (!lanes.length) {
    for (let li = 0; li < layers.length; li++) {
      const ids = freeByLayer.get(li);
      if (!ids || !ids.length) continue;
      let x = 0;
      for (const id of ids) {
        const size = sizes.get(id);
        allPos.set(id, { ax: x, ay: depthFor(li, size.ah), aw: size.aw, ah: size.ah });
        x += size.aw + NODE_GAP;
      }
    }
  }
  for (let sweep = 0; sweep < (lanes.length ? 3 : 0); sweep++) {
    for (let li = 0; li < layers.length; li++) {
      const ids = freeByLayer.get(li);
      if (!ids || !ids.length) continue;
      for (const id of ids) allPos.delete(id);
      const gaps = [];
      let gapCursor = 0;
      for (const band of laneBands.get(li) || []) {
        if (band.start - gapCursor > 0) gaps.push([gapCursor, band.start]);
        gapCursor = Math.max(gapCursor, band.end);
      }
      if (gapRight > gapCursor) gaps.push([gapCursor, gapRight]);
      const ordered = ids.slice().sort(
        (a, b) =>
          (targets.get(a) ?? 0) - (targets.get(b) ?? 0) ||
          (declaredIndex.get(a) ?? 0) - (declaredIndex.get(b) ?? 0),
      );
      let overflow = lanesEnd + (lanes.length ? LANE_GAP : 0);
      if (!lanes.length) overflow = 0;
      for (const id of ordered) {
        const size = sizes.get(id);
        const target = targets.get(id) ?? centerBase / 2;
        let best = null;
        for (let gi = 0; gi < gaps.length; gi++) {
          const [gs, ge] = gaps[gi];
          if (ge - gs < size.aw) continue;
          const x = Math.min(Math.max(target - size.aw / 2, gs), ge - size.aw);
          const cost = Math.abs(x + size.aw / 2 - target);
          if (
            !best ||
            cost < best.cost - 1e-9 ||
            (Math.abs(cost - best.cost) < 1e-9 && gi < best.gi)
          ) {
            best = { gi, x, cost };
          }
        }
        let placedX;
        if (best) {
          placedX = Math.round(best.x);
          const [gs, ge] = gaps[best.gi];
          const rest = [];
          if (placedX - NODE_GAP - gs > 0) rest.push([gs, placedX - NODE_GAP]);
          if (ge - (placedX + size.aw + NODE_GAP) > 0) {
            rest.push([placedX + size.aw + NODE_GAP, ge]);
          }
          gaps.splice(best.gi, 1, ...rest);
          gaps.sort((a, b) => a[0] - b[0]);
        } else {
          placedX = overflow;
          overflow += size.aw + NODE_GAP;
        }
        allPos.set(id, {
          ax: placedX,
          ay: depthFor(li, size.ah),
          aw: size.aw,
          ah: size.ah,
        });
      }
    }
    // Refresh targets from the positions we just produced.
    for (const id of freeIds) {
      const list = neighbours.get(id) || [];
      let sum = 0;
      let count = 0;
      for (const other of list) {
        const box = allPos.get(other);
        if (!box) continue;
        sum += box.ax + box.aw / 2;
        count++;
      }
      targets.set(id, count ? sum / count : centerBase / 2);
    }
  }

  // 3) Derived geometry: per-layer sorted node intervals (for routing) and
  //    the overall cross extent.
  const layerIntervals = layers.map(() => []);
  let maxCross = 0;
  layers.forEach((layer, li) => {
    for (const id of layer) {
      const box = allPos.get(id);
      if (!box) continue;
      layerIntervals[li].push([box.ax, box.ax + box.aw]);
      if (box.ax + box.aw > maxCross) maxCross = box.ax + box.aw;
    }
  });
  for (const intervals of layerIntervals) intervals.sort((a, b) => a[0] - b[0]);

  return {
    pos: allPos,
    layerStart,
    layerDepth,
    layerIntervals,
    minCross: 0,
    maxCross,
  };
}

/* ------------------------------------------------------------------------- */
/* Orthogonal router (abstract space)                                        */
/* ------------------------------------------------------------------------- */

function layerIntervalsOf(layerIntervals, li) {
  return layerIntervals[li] || [];
}

function channelIsFree(x, layerIntervals, fromLayer, toLayer) {
  for (let li = fromLayer; li <= toLayer; li++) {
    for (const [a, b] of layerIntervalsOf(layerIntervals, li)) {
      if (x > a - 2 && x < b + 2) return false;
    }
  }
  return true;
}

/**
 * Find a vertical channel cross-position that no node box of the intermediate
 * layers occupies, preferring the source/target centre (2-bend Z route).
 * Returns null when no in-content channel is free.
 */
function pickForwardChannel(sx, tx, rank, layerIntervals) {
  const sr = rank.from;
  const tr = rank.to;
  if (channelIsFree(sx, layerIntervals, sr + 1, tr - 1)) return sx;
  if (channelIsFree(tx, layerIntervals, sr + 1, tr - 1)) return tx;
  const mid = (sx + tx) / 2;
  const candidates = [];
  for (let li = sr + 1; li < tr; li++) {
    const intervals = layerIntervalsOf(layerIntervals, li);
    for (const [a, b] of intervals) {
      candidates.push(a - 8, b + 8);
    }
    for (let i = 1; i < intervals.length; i++) {
      candidates.push(Math.round((intervals[i - 1][1] + intervals[i][0]) / 2));
    }
  }
  let best = null;
  for (const raw of candidates) {
    const x = Math.round(raw);
    if (!channelIsFree(x, layerIntervals, sr + 1, tr - 1)) continue;
    const cost = Math.abs(x - mid);
    if (
      !best ||
      cost < best.cost - 1e-9 ||
      (Math.abs(cost - best.cost) < 1e-9 && x < best.x)
    ) {
      best = { x, cost };
    }
  }
  return best ? best.x : null;
}

/**
 * Orthogonal polyline from `from` to `to` in abstract coordinates.
 *
 * - rank+1 forward edges: a Z route through the layer gap (2 bends);
 * - same-layer edges: a Z route through the gap under the row (2 bends);
 * - forward skip edges: Z through a channel free of intermediate nodes
 *   (2 bends when the source/target x works, otherwise 4);
 * - feedback (cycle) edges: a short local side channel just outside the
 *   layers they span (4 bends), never a canvas-edge detour.
 *
 * All horizontal runs happen inside layer gaps, so an edge never crosses a
 * node box.
 */
export function routeAbstract({
  from,
  to,
  rank,
  layerStart,
  layerDepth,
  layerIntervals,
  offset = 0,
}) {
  const sr = rank.get(from.id);
  const tr = rank.get(to.id);
  const sx = Math.round(from.ax + from.aw / 2);
  const tx = Math.round(to.ax + to.aw / 2);

  if (sr === tr) {
    const layerBottom = layerStart[sr] + layerDepth[sr];
    const channel = layerBottom + ROUTE_MARGIN + Math.abs(offset);
    return [
      { c: sx, d: from.ay + from.ah },
      { c: sx, d: channel },
      { c: tx, d: channel },
      { c: tx, d: to.ay + to.ah },
    ];
  }

  if (tr === sr + 1) {
    const sy = from.ay + from.ah;
    const ty = to.ay;
    if (sx === tx) return [{ c: sx, d: sy }, { c: sx, d: ty }];
    const raw = Math.round((sy + ty) / 2) + offset;
    const mid = Math.min(Math.max(raw, sy + 16), ty - 16);
    return [
      { c: sx, d: sy },
      { c: sx, d: mid },
      { c: tx, d: mid },
      { c: tx, d: ty },
    ];
  }

  const exit = layerStart[sr] + layerDepth[sr] + ROUTE_MARGIN + offset;
  const entry = layerStart[tr] - ROUTE_MARGIN + offset;
  const sy = from.ay + from.ah;
  const ty = to.ay;

  if (tr > sr + 1) {
    const channel = pickForwardChannel(sx, tx, { from: sr, to: tr }, layerIntervals);
    if (channel === sx) {
      return [
        { c: sx, d: sy },
        { c: sx, d: entry },
        { c: tx, d: entry },
        { c: tx, d: ty },
      ];
    }
    if (channel === tx) {
      return [
        { c: sx, d: sy },
        { c: sx, d: exit },
        { c: tx, d: exit },
        { c: tx, d: ty },
      ];
    }
    let gx;
    if (channel !== null) {
      gx = channel;
    } else {
      // Dense layers: step just outside the involved layer extents.
      let lo = Infinity;
      let hi = -Infinity;
      for (let li = sr + 1; li < tr; li++) {
        for (const [a, b] of layerIntervalsOf(layerIntervals, li)) {
          lo = Math.min(lo, a);
          hi = Math.max(hi, b);
        }
      }
      if (!Number.isFinite(lo)) {
        lo = sx;
        hi = tx;
      }
      gx = tx >= sx ? hi + ROUTE_MARGIN : lo - ROUTE_MARGIN;
    }
    return [
      { c: sx, d: sy },
      { c: sx, d: exit },
      { c: gx, d: exit },
      { c: gx, d: entry },
      { c: tx, d: entry },
      { c: tx, d: ty },
    ];
  }

  // Feedback edge: target sits above the source.
  let lo = Infinity;
  let hi = -Infinity;
  for (let li = tr; li <= sr; li++) {
    for (const [a, b] of layerIntervalsOf(layerIntervals, li)) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  if (!Number.isFinite(lo)) {
    lo = sx;
    hi = tx;
  }
  const midEdge = (sx + tx) / 2;
  const channel = midEdge <= (lo + hi) / 2 ? lo - ROUTE_MARGIN : hi + ROUTE_MARGIN;
  const above = layerStart[sr] - ROUTE_MARGIN + offset;
  const below = layerStart[tr] + layerDepth[tr] + ROUTE_MARGIN + offset;
  return [
    { c: sx, d: from.ay },
    { c: sx, d: above },
    { c: channel, d: above },
    { c: channel, d: below },
    { c: tx, d: below },
    { c: tx, d: to.ay + to.ah },
  ];
}

/* ------------------------------------------------------------------------- */
/* Point / label utilities                                                   */
/* ------------------------------------------------------------------------- */

const EPSILON = 0.5;

/** Drop duplicate and collinear intermediate points (keeps corners). */
export function simplifyPoints(points) {
  const out = [];
  for (const point of points) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - x) <= EPSILON && Math.abs(last.y - y) <= EPSILON) {
      continue;
    }
    if (out.length >= 2) {
      const prev = out[out.length - 2];
      const collinear =
        (prev.x === last.x && last.x === x) ||
        (prev.y === last.y && last.y === y);
      if (collinear) {
        out[out.length - 1] = { x, y };
        continue;
      }
    }
    out.push({ x, y });
  }
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].x === out[i - 1].x && out[i].y === out[i - 1].y) out.splice(i, 1);
  }
  return out;
}

function rectIntersects(a, b, pad = 0) {
  return (
    a.x < b.x + b.w + pad &&
    b.x < a.x + a.w + pad &&
    a.y < b.y + b.h + pad &&
    b.y < a.y + a.h + pad
  );
}

/**
 * Place an edge-label chip: prefer the longest "free" segment (midpoint not
 * inside a node box), then any segment whose chip would not collide with a
 * node box or an already placed chip. The chip is offset 8px from the line:
 * above a horizontal run, to the right of a vertical one.
 *
 * @param {Array<{x: number, y: number}>} points screen-space polyline
 * @param {string} label
 * @param {Array<{x: number, y: number, w: number, h: number}>} boxes node boxes
 * @param {Array<{x: number, y: number, w: number, h: number}>} placed chips
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function placeEdgeLabel(points, label, boxes = [], placed = []) {
  if (!label || !points || points.length < 2) return null;
  const w = labelChipWidth(label);
  const h = LABEL_HEIGHT;
  const candidates = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) continue;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const free = !boxes.some((box) => {
      if (box.x == null) return false;
      return (
        midX > box.x - 4 &&
        midX < box.x + box.w + 4 &&
        midY > box.y - 4 &&
        midY < box.y + box.h + 4
      );
    });
    candidates.push({ i, len, free, horizontal, midX, midY });
  }
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) => Number(b.free) - Number(a.free) || b.len - a.len || a.i - b.i,
  );
  // Try the required 8px offset first, then stack the chip further off the
  // line so two labels never paint on top of each other.
  const distances = [LABEL_OFFSET, LABEL_OFFSET + h + 4, LABEL_OFFSET + 2 * (h + 4)];
  let fallback = null;
  for (const candidate of candidates) {
    const avail = Math.max(0, candidate.len - w);
    const slides = avail >= 8 ? [0, -Math.round(avail / 2), Math.round(avail / 2)] : [0];
    for (const distance of distances) {
      for (const slide of slides) {
        const x = candidate.horizontal
          ? Math.round(candidate.midX - w / 2 + slide)
          : Math.round(candidate.midX + distance);
        const y = candidate.horizontal
          ? Math.round(candidate.midY - h - distance)
          : Math.round(candidate.midY - h / 2 + slide);
        const chip = { x, y, w, h };
        if (fallback === null) fallback = chip;
        const hitsNode = boxes.some(
          (box) => box.x != null && rectIntersects(chip, box, 2),
        );
        if (hitsNode) continue;
        const hitsChip = placed.some((other) => rectIntersects(chip, other, 0));
        if (hitsChip) continue;
        return chip;
      }
    }
  }
  return fallback;
}
