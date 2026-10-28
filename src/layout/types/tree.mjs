/**
 * Layout for type "tree" — tidy tree (Reingold-Tilford style), root on top.
 *
 * Owner: types-relational. Children keep declared edge order, subtrees never
 * overlap and every parent is centred over its children. Edges are elbow
 * polylines. Deterministic, zero dependencies, canvas = content + 24px padding.
 */

import {
  PADDING,
  MIN_CANVAS_WIDTH,
  textWidth,
  placeEdgeLabel,
} from "../geometry.mjs";

const MIN_CARD_W = 156;
const CARD_H = 64;
const SUBLABEL_EXTRA = 16;
const SIBLING_GAP = 40;
const LEVEL_GAP = 72;
const FOREST_GAP = 72;
const FONT_LABEL = 13;
const FONT_SUBLABEL = 11;

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
    direction: "TB", // trees always grow downwards from the root
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
/* Tree cards                                                                */
/* ------------------------------------------------------------------------- */

function sizeTreeCard(node) {
  const label = String(node.label ?? node.id ?? "");
  const sublabel = typeof node.sublabel === "string" ? node.sublabel : "";
  const contentW = Math.max(
    textWidth(label, FONT_LABEL),
    sublabel ? textWidth(sublabel, FONT_SUBLABEL) : 0,
  );
  return {
    w: Math.max(MIN_CARD_W, contentW + 36),
    h: CARD_H + (sublabel ? SUBLABEL_EXTRA : 0),
  };
}

/* ------------------------------------------------------------------------- */
/* Tree structure                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Build parent -> children links from the declared edges. The first incoming
 * edge wins if an invalid IR gives a node two parents; edges that would close
 * a cycle are ignored so the tidy pass always terminates.
 */
function buildTree(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map(nodes.map((node) => [node.id, []]));
  const parentOf = new Map(nodes.map((node) => [node.id, null]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    if (parentOf.get(edge.to) !== null) continue; // at most one parent
    if (parentOf.get(edge.from) === null && edge.to === edge.from) continue;
    parentOf.set(edge.to, edge.from);
    childrenOf.get(edge.from).push(edge.to);
  }
  // A node whose ancestor chain loops back is detached to become a root.
  const roots = nodes.filter((node) => parentOf.get(node.id) === null).map((node) => node.id);
  if (!roots.length && nodes.length) {
    const first = nodes[0].id;
    const parent = parentOf.get(first);
    if (parent !== null) {
      childrenOf.set(parent, childrenOf.get(parent).filter((child) => child !== first));
      parentOf.set(first, null);
    }
    roots.push(first);
  }
  // Defensive: any node not reachable from a root joins the forest.
  const seen = new Set();
  const queue = roots.slice();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of childrenOf.get(id)) queue.push(child);
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) {
      roots.push(node.id);
      seen.add(node.id);
    }
  }
  return { byId, childrenOf, parentOf, roots };
}

/* ------------------------------------------------------------------------- */
/* Tidy placement                                                            */
/* ------------------------------------------------------------------------- */

function tidyPlace(roots, byId, childrenOf) {
  // measured: subtree width, node centre relative to the subtree's left edge,
  // and the offset of every child subtree inside it.
  const measured = new Map();

  const measure = (id) => {
    const node = byId.get(id);
    const children = childrenOf.get(id);
    if (!children.length) {
      const leaf = { width: node.w, center: node.w / 2, children: [] };
      measured.set(id, leaf);
      return leaf;
    }
    let cursor = 0;
    const childOffsets = [];
    for (const child of children) {
      const childMeasure = measure(child);
      childOffsets.push({ id: child, offset: cursor, width: childMeasure.width });
      cursor += childMeasure.width + SIBLING_GAP;
    }
    const span = cursor - SIBLING_GAP;
    const firstById = measured.get(childOffsets[0].id);
    const lastById = measured.get(childOffsets[childOffsets.length - 1].id);
    const firstCenter = childOffsets[0].offset + firstById.center;
    const lastCenter = childOffsets[childOffsets.length - 1].offset + lastById.center;
    // Reingold-Tilford: the parent centres over its first and last child.
    const center = (firstCenter + lastCenter) / 2;
    const parentLeft = center - node.w / 2;
    const left = Math.min(0, parentLeft);
    const right = Math.max(span, parentLeft + node.w);
    const shift = -left;
    const result = {
      width: right - left,
      center: center + shift,
      children: childOffsets.map((item) => ({ id: item.id, offset: item.offset + shift })),
    };
    measured.set(id, result);
    return result;
  };

  for (const root of roots) measure(root);

  const place = (id, left) => {
    const node = byId.get(id);
    const info = measured.get(id);
    node.x = Math.round(left + info.center - node.w / 2);
    for (const child of info.children) place(child.id, left + child.offset);
  };

  let cursor = 0;
  for (const root of roots) {
    place(root, cursor);
    cursor += measured.get(root).width + FOREST_GAP;
  }
}

function assignLevels(roots, childrenOf) {
  const level = new Map();
  const queue = roots.map((id) => ({ id, level: 0 }));
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (level.has(item.id)) continue;
    level.set(item.id, item.level);
    for (const child of childrenOf.get(item.id)) {
      queue.push({ id: child, level: item.level + 1 });
    }
  }
  return level;
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Layout a tree IR into a scene v3 document.
 * @param {object} ir validated IR with type "tree"
 * @returns {object} scene
 */
export function layoutTree(ir) {
  const irNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const nodes = irNodes.map((node) => {
    const sized = sizeTreeCard(node);
    return {
      id: node.id,
      label: node.label,
      kind: typeof node.kind === "string" && node.kind ? node.kind : "service",
      sublabel: typeof node.sublabel === "string" ? node.sublabel : "",
      w: sized.w,
      h: sized.h,
      x: 0,
      y: 0,
    };
  });

  const rawEdges = Array.isArray(ir.edges) ? ir.edges : [];
  const edges = [];
  rawEdges.forEach((edge, index) => {
    if (!edge) return;
    edges.push({
      id: `e${index + 1}`,
      from: String(edge.from),
      to: String(edge.to),
      label:
        typeof edge.label === "string" && edge.label.length ? edge.label : null,
    });
  });

  const tree = buildTree(nodes, edges);
  const { byId, childrenOf, parentOf, roots } = tree;
  tidyPlace(roots, byId, childrenOf);

  const level = assignLevels(roots, childrenOf);
  const maxLevel = nodes.reduce((max, node) => Math.max(max, level.get(node.id) ?? 0), 0);
  const levelH = new Array(maxLevel + 1).fill(0);
  for (const node of nodes) {
    const li = level.get(node.id) ?? 0;
    levelH[li] = Math.max(levelH[li], node.h);
  }
  const levelStart = [];
  for (let li = 0; li <= maxLevel; li++) {
    levelStart.push(li === 0 ? 0 : levelStart[li - 1] + levelH[li - 1] + LEVEL_GAP);
  }
  for (const node of nodes) {
    const li = level.get(node.id) ?? 0;
    node.y = levelStart[li] + Math.round((levelH[li] - node.h) / 2);
  }

  // Elbow edges: parent bottom centre -> mid-gap -> child centre x -> child top.
  const placedChips = [];
  const allBoxes = nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const routedEdges = [];
  for (const edge of edges) {
    const parent = byId.get(edge.from);
    const child = byId.get(edge.to);
    if (!parent || !child) continue;
    if (parentOf.get(child.id) !== parent.id) continue; // dropped duplicate/cycle edge
    const px = Math.round(parent.x + parent.w / 2);
    const cx = Math.round(child.x + child.w / 2);
    const py = parent.y + parent.h;
    const cy = child.y;
    let points;
    if (px === cx) {
      points = [{ x: px, y: py }, { x: cx, y: cy }];
    } else {
      const midY = Math.round((py + cy) / 2);
      points = [
        { x: px, y: py },
        { x: px, y: midY },
        { x: cx, y: midY },
        { x: cx, y: cy },
      ];
    }
    routedEdges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
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

  const scene = baseScene(ir, "tree");
  scene.nodes = nodes.map((node) => {
    const children = childrenOf.get(node.id);
    const role =
      parentOf.get(node.id) === null
        ? "root"
        : children.length
          ? "branch"
          : "leaf";
    const entry = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      shape: "card",
      role,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
    };
    if (node.sublabel) entry.sublabel = node.sublabel;
    return entry;
  });
  scene.groups = [];
  scene.edges = routedEdges.map((edge) => {
    const entry = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: "main",
      dashed: false,
      arrow: "none", // hierarchy: the elbow shape carries the direction
      points: edge.points,
    };
    if (edge.label) entry.label = edge.label;
    if (edge.labelBox) entry.labelBox = edge.labelBox;
    return entry;
  });
  scene.legend = routedEdges.length
    ? [{ kind: "main", label: "Contains" }]
    : [];
  scene.meta = { padding: PADDING, sceneVersion: 1 };
  return finalizeCanvas(scene);
}
