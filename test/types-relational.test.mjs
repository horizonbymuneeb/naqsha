// Layout tests for the relational v1.2 diagram types: erd, class, tree.
// Owner: types-relational (task-9). Scratch space: /tmp/types-rel.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { layout } from "../src/layout/index.mjs";
import { textWidth, PADDING } from "../src/layout/geometry.mjs";
import { ROOT, parseJsonStdout, runCli } from "./helpers.mjs";

const TYPES_DIR = path.join(ROOT, "test", "fixtures");
const SCRATCH = "/tmp/types-rel/test";
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const FIXTURES = [
  { file: "shop.erd.json", type: "erd" },
  { file: "payments.class.json", type: "class" },
  { file: "monorepo.tree.json", type: "tree" },
];

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(TYPES_DIR, file), "utf8"));
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Edge endpoints grouped by the node border they attach to. */
function attachmentPoints(scene) {
  const onBorder = (point, node) =>
    point.x >= node.x - 0.01 &&
    point.x <= node.x + node.w + 0.01 &&
    point.y >= node.y - 0.01 &&
    point.y <= node.y + node.h + 0.01 &&
    (Math.abs(point.x - node.x) < 0.01 ||
      Math.abs(point.x - (node.x + node.w)) < 0.01 ||
      Math.abs(point.y - node.y) < 0.01 ||
      Math.abs(point.y - (node.y + node.h)) < 0.01);
  const byNode = new Map(scene.nodes.map((node) => [node.id, []]));
  for (const edge of scene.edges) {
    for (const point of [edge.points[0], edge.points[edge.points.length - 1]]) {
      for (const node of scene.nodes) {
        if (onBorder(point, node)) byNode.get(node.id).push({ edge: edge.id, point });
      }
    }
  }
  return byNode;
}

/** No two edges may attach to the exact same point on a node (pills overprint). */
function assertDistinctAttachments(scene) {
  for (const [nodeId, list] of attachmentPoints(scene)) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i].point;
        const b = list[j].point;
        assert.ok(
          Math.hypot(a.x - b.x, a.y - b.y) >= 4,
          `${nodeId}: ${list[i].edge} and ${list[j].edge} share an attach point`,
        );
      }
    }
  }
}

/** Assert the scene-level invariants every v1.2 type shares. */
function assertSceneInvariants(ir, scene, expectedType) {
  assert.equal(scene.sceneVersion, 1, "sceneVersion");
  assert.equal(scene.type, expectedType, "scene type");
  assert.equal(scene.direction, "TB", "direction is top-to-bottom for these types");
  assert.deepEqual(scene.meta, { padding: PADDING, sceneVersion: 1 });
  assert.equal(scene.title, ir.title);
  if (ir.subtitle) assert.equal(scene.subtitle, ir.subtitle);
  assert.deepEqual(scene.notes, (ir.notes || []).slice(0, 4));

  const text = JSON.stringify(scene);
  assert.ok(!/NaN|Infinity/.test(text), "scene must not contain NaN/Infinity");

  const ids = new Set(scene.nodes.map((node) => node.id));
  assert.equal(ids.size, scene.nodes.length, "node ids unique");

  // Determinism: the same IR must serialise byte-identically twice.
  assert.equal(JSON.stringify(layout(ir)), text, "layout is deterministic");

  // Every node inside the canvas, positive size, and no two boxes intersect.
  for (const node of scene.nodes) {
    assert.ok(node.w > 0 && node.h > 0, `${node.id} size`);
    assert.ok(node.x >= 0 && node.y >= 0, `${node.id} origin`);
    assert.ok(node.x + node.w <= scene.width, `${node.id} right edge in canvas`);
    assert.ok(node.y + node.h <= scene.height, `${node.id} bottom edge in canvas`);
  }
  for (let i = 0; i < scene.nodes.length; i += 1) {
    for (let j = i + 1; j < scene.nodes.length; j += 1) {
      assert.ok(
        !overlaps(scene.nodes[i], scene.nodes[j]),
        `nodes overlap: ${scene.nodes[i].id} / ${scene.nodes[j].id}`,
      );
    }
  }

  // Edges: known endpoints, >= 2 points, orthogonal segments, points in canvas.
  for (const edge of scene.edges) {
    assert.ok(ids.has(edge.from), `${edge.id} from exists`);
    assert.ok(ids.has(edge.to), `${edge.id} to exists`);
    assert.notEqual(edge.from, edge.to, `${edge.id} not a self edge`);
    assert.ok(edge.points.length >= 2, `${edge.id} has points`);
    for (const point of edge.points) {
      assert.ok(
        point.x >= 0 && point.x <= scene.width && point.y >= 0 && point.y <= scene.height,
        `${edge.id} point in canvas`,
      );
    }
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      assert.ok(
        a.x === b.x || a.y === b.y,
        `${edge.id} segment ${i} is not orthogonal`,
      );
    }
    if (edge.labelBox) {
      assert.ok(edge.labelBox.w > 0 && edge.labelBox.h > 0);
      assert.ok(
        edge.labelBox.x >= 0 &&
          edge.labelBox.y >= 0 &&
          edge.labelBox.x + edge.labelBox.w <= scene.width &&
          edge.labelBox.y + edge.labelBox.h <= scene.height,
        `${edge.id} labelBox in canvas`,
      );
    }
  }

  // Canvas = content bbox + 24px on every side (and never below the 320 min).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x, y, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const node of scene.nodes) grow(node.x, node.y, node.w, node.h);
  for (const edge of scene.edges) {
    for (const point of edge.points) grow(point.x, point.y);
    if (edge.labelBox) grow(edge.labelBox.x, edge.labelBox.y, edge.labelBox.w, edge.labelBox.h);
  }
  assert.equal(minX, PADDING, "content starts at the 24px padding");
  assert.equal(minY, PADDING, "content starts at the 24px padding");
  assert.equal(scene.height, Math.ceil(maxY - minY) + PADDING * 2, "height = bbox + padding");
  assert.ok(scene.width >= Math.ceil(maxX - minX) + PADDING * 2, "width fits content");
  assert.ok(scene.width >= 320, "minimum canvas width");
}

function layoutFixture(entry) {
  const ir = loadFixture(entry.file);
  const scene = layout(ir);
  assertSceneInvariants(ir, scene, entry.type);
  return { ir, scene };
}

// ---------------------------------------------------------------------------
// ERD
// ---------------------------------------------------------------------------

test("erd: entity tables, rows, marks and cardinality edges", () => {
  const { ir, scene } = layoutFixture(FIXTURES[0]);
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));

  for (const node of scene.nodes) {
    assert.equal(node.shape, "entity");
    const irNode = ir.nodes.find((candidate) => candidate.id === node.id);
    assert.ok(node.rows.length >= 1, `${node.id} has rows`);
    assert.equal(node.rows.length, irNode.attributes.length, `${node.id} row count`);
    assert.equal(node.h, 34 + node.rows.length * 22, `${node.id} header 34 + rows 22`);
    assert.ok(node.w >= 180, `${node.id} minimum table width`);
    assert.ok(
      textWidth(node.label, 13) <= node.w - 32,
      `${node.id} header text fits`,
    );
    irNode.attributes.forEach((attribute, index) => {
      const row = node.rows[index];
      assert.equal(row.label, attribute.name);
      assert.equal(row.right, attribute.type);
      const expectedMark =
        attribute.key === "pk" || attribute.key === "fk" || attribute.key === "unique"
          ? attribute.key
          : null;
      assert.equal(row.mark, expectedMark, `${node.id}.${attribute.name} mark`);
      assert.ok(
        textWidth(row.label, 12) + 16 + textWidth(row.right, 12) + 18 <= node.w - 32 + 0.001,
        `${node.id}.${attribute.name} row fits`,
      );
    });
  }

  // Declaration order grid: four tables -> two columns, two rows. Nodes are
  // centred inside their cell, so compare cell centres, not raw origins.
  const uniqueCenters = (values) => [...new Set(values.map((value) => Math.round(value)))];
  const colCenters = uniqueCenters(scene.nodes.map((node) => node.x + node.w / 2));
  const rowCenters = uniqueCenters(scene.nodes.map((node) => node.y + node.h / 2));
  assert.equal(colCenters.length, 2, "two grid columns");
  assert.equal(rowCenters.length, 2, "two grid rows");
  assert.ok(
    rowCenters[1] - rowCenters[0] > 56,
    "rows separated by the grid gap",
  );
  assert.ok(
    colCenters[1] - colCenters[0] > 72,
    "columns separated by the grid gap",
  );

  for (const node of scene.nodes) {
    for (const mark of node.rows.map((row) => row.mark)) {
      assert.ok(mark === null || ["pk", "fk", "unique"].includes(mark));
    }
  }

  // Edges carry card from IR cardinality; legend lists the used cardinalities.
  assert.equal(scene.edges.length, ir.edges.length);
  scene.edges.forEach((edge, index) => {
    assert.equal(edge.card, ir.edges[index].cardinality);
    assert.equal(edge.kind, "main");
    assert.equal(edge.arrow, "end");
    assert.equal(edge.label, ir.edges[index].label);
    assert.ok(edge.labelBox, "labelled edge has a chip");
  });
  assert.deepEqual(
    scene.legend.map((entry) => entry.label),
    ["1:n relationship"],
  );
  // Border anchors: edge points start on a table border.
  for (const edge of scene.edges) {
    const from = byId.get(edge.from);
    const start = edge.points[0];
    assert.ok(
      start.x === from.x ||
        start.x === from.x + from.w ||
        start.y === from.y ||
        start.y === from.y + from.h,
      `${edge.id} starts on a border`,
    );
  }
  // Cardinality pills sit on endpoints: no two edges may share one.
  assertDistinctAttachments(scene);
});

test("erd: wide 10-table schema still lays out inside the canvas", () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({
    id: `table-${index}`,
    label: `table_${index}`,
    attributes: [
      { name: "id", type: "uuid", key: "pk" },
      { name: `column_${index}`, type: "text" },
    ],
  }));
  const edges = Array.from({ length: 9 }, (_, index) => ({
    from: `table-${index}`,
    to: `table-${index + 1}`,
    cardinality: index % 2 === 0 ? "1:n" : "1:1",
  }));
  const ir = { title: "Wide ERD", type: "erd", nodes, edges };
  const scene = layout(ir);
  assertSceneInvariants(ir, scene, "erd");
  const xs = [...new Set(scene.nodes.map((node) => node.x))];
  assert.equal(xs.length, 3, "ten tables use three columns");
  assert.deepEqual(
    scene.legend.map((entry) => entry.label),
    ["1:1 relationship", "1:n relationship"],
  );
});

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

test("class: stereotypes, member rows, inheritance depth and relation kinds", () => {
  const { ir, scene } = layoutFixture(FIXTURES[1]);
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const irById = new Map(ir.nodes.map((node) => [node.id, node]));

  for (const node of scene.nodes) {
    assert.equal(node.shape, "class");
    const irNode = irById.get(node.id);
    assert.equal(node.label, irNode.label);
    assert.deepEqual(node.members, irNode.members || []);
    assert.deepEqual(node.rows.map((row) => row.label), irNode.members || []);
    if (irNode.stereotype) assert.equal(node.stereotype, irNode.stereotype);
    else assert.equal(node.stereotype, undefined);
    assert.equal(node.h, 34 + Math.max((irNode.members || []).length, 1) * 22);
    assert.ok(node.w >= 180);
    assert.ok(textWidth(node.label, 13) <= node.w - 32, `${node.id} header fits`);
    for (const member of irNode.members || []) {
      assert.ok(textWidth(member, 11) <= node.w - 32, `${node.id} member fits`);
    }
  }

  // Parents sit above children (implements): StripeGateway below PaymentGateway.
  assert.ok(byId.get("stripe").y > byId.get("gateway").y, "child below parent");
  const maxParentBottom = Math.max(
    byId.get("gateway").y + byId.get("gateway").h,
    byId.get("receipt").y + byId.get("receipt").h,
  );
  const layerGap = byId.get("stripe").y - maxParentBottom;
  assert.ok(layerGap >= 64 - 1, `layer gap is at least 64 (got ${layerGap})`);

  // Horizontal node gap 40 between neighbours in the same layer.
  const layerNodes = scene.nodes
    .filter((node) => Math.abs(node.y - byId.get("gateway").y) < 40)
    .sort((a, b) => a.x - b.x);
  for (let i = 1; i < layerNodes.length; i += 1) {
    assert.equal(
      layerNodes[i].x - (layerNodes[i - 1].x + layerNodes[i - 1].w),
      40,
      "same-layer node gap is 40",
    );
  }

  // Relation kinds are preserved; only relation edges are emitted.
  const kinds = scene.edges.map((edge) => edge.kind).sort();
  assert.deepEqual(kinds, [
    "composition",
    "composition",
    "composition",
    "dependency",
    "dependency",
    "implements",
  ]);
  for (const edge of scene.edges) {
    if (edge.kind === "dependency") {
      assert.equal(edge.dashed, true, "dependency is dashed");
    } else {
      assert.ok(edge.kind !== "composition" || edge.arrow === "none");
    }
  }
  assert.deepEqual(
    scene.legend.map((entry) => entry.kind),
    ["implements", "composition", "dependency"],
  );
  // UML heads (triangle/diamond/arrow) must not stack on one border point.
  assertDistinctAttachments(scene);
});

test("class: cycle-safe inheritance and empty class bodies", () => {
  const ir = {
    title: "Cycles and empties",
    type: "class",
    nodes: [
      { id: "a", label: "A", stereotype: "abstract", members: [] },
      {
        id: "b",
        label: "B",
        members: ["+ run(): void", "+ stop(): void", "+ status(): Status"],
      },
      { id: "c", label: "C", members: [] },
    ],
    edges: [
      { from: "a", to: "b", kind: "extends" },
      { from: "b", to: "a", kind: "extends" },
      { from: "c", to: "b", kind: "dependency" },
    ],
  };
  const scene = layout(ir);
  assertSceneInvariants(ir, scene, "class");
  assert.equal(scene.edges.length, 3);
  assert.ok(scene.nodes.every((node) => node.h >= 56), "empty class keeps a body row");
});

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function descendantExtent(scene, childrenOf, id) {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  let left = Infinity;
  let right = -Infinity;
  const visit = (current) => {
    const node = byId.get(current);
    left = Math.min(left, node.x);
    right = Math.max(right, node.x + node.w);
    for (const child of childrenOf.get(current) || []) visit(child);
  };
  visit(id);
  return { left, right };
}

test("tree: tidy layout, roles, parent centring and elbow edges", () => {
  const { ir, scene } = layoutFixture(FIXTURES[2]);
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map(scene.nodes.map((node) => [node.id, []]));
  const parentOf = new Map(scene.nodes.map((node) => [node.id, null]));
  for (const edge of scene.edges) {
    childrenOf.get(edge.from).push(edge.to);
    parentOf.set(edge.to, edge.from);
  }

  for (const node of scene.nodes) {
    assert.equal(node.shape, "card");
    assert.ok(["root", "branch", "leaf"].includes(node.role));
    if (node.id === "repo") assert.equal(node.role, "root");
    if (node.id === "layout" || node.id === "view" || node.id === "cli") {
      assert.equal(node.role, "leaf");
    }
    if (node.id === "src") assert.equal(node.role, "branch");
    assert.ok(textWidth(node.label, 13) <= node.w - 36, `${node.id} label fits`);
  }

  // Exactly one root; children in declared edge order left-to-right.
  const roots = scene.nodes.filter((node) => node.role === "root");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, "repo");
  const ordered = (parent) =>
    scene.edges
      .filter((edge) => edge.from === parent)
      .map((edge) => byId.get(edge.to));
  const repoKids = ordered("repo");
  assert.deepEqual(repoKids.map((node) => node.id), ["src", "tests", "docs"]);
  assert.ok(repoKids[0].x < repoKids[1].x && repoKids[1].x < repoKids[2].x);
  const srcKids = ordered("src");
  assert.deepEqual(srcKids.map((node) => node.id), ["layout", "view", "cli"]);

  // Parent centred over first and last child centres.
  for (const parent of scene.nodes) {
    const kids = ordered(parent.id);
    if (!kids.length) continue;
    const parentCenter = parent.x + parent.w / 2;
    const first = kids[0].x + kids[0].w / 2;
    const last = kids[kids.length - 1].x + kids[kids.length - 1].w / 2;
    assert.ok(
      Math.abs(parentCenter - (first + last) / 2) <= 0.5,
      `${parent.id} centred over children`,
    );
  }

  // Subtrees never overlap: consecutive child subtrees keep a gap.
  for (const parent of scene.nodes) {
    const kids = ordered(parent.id);
    for (let i = 1; i < kids.length; i += 1) {
      const previous = descendantExtent(scene, childrenOf, kids[i - 1].id);
      const next = descendantExtent(scene, childrenOf, kids[i].id);
      assert.ok(
        next.left - previous.right >= 40 - 0.5,
        `${kids[i - 1].id} / ${kids[i].id} subtrees overlap`,
      );
    }
  }

  // Elbow edges: 2 or 4 points, orthogonal, parent -> child, no arrowheads.
  for (const edge of scene.edges) {
    assert.equal(childrenOf.get(edge.from).length > 0, true);
    assert.equal(edge.kind, "main");
    assert.equal(edge.arrow, "none");
    assert.equal(edge.dashed, false);
    assert.ok(edge.points.length === 2 || edge.points.length === 4, "elbow");
    if (edge.points.length === 4) {
      assert.equal(edge.points[1].y, edge.points[2].y, "horizontal elbow run");
      assert.equal(edge.points[0].x, edge.points[1].x);
      assert.equal(edge.points[2].x, edge.points[3].x);
    }
  }
  assert.deepEqual(scene.legend, [{ kind: "main", label: "Contains" }]);
});

test("tree: 20-node tree stays tidy and in bounds", () => {
  const nodes = [{ id: "root", label: "root" }];
  const edges = [];
  // Binary-ish tree: node i has children 2i+1 and 2i+2 when they exist.
  for (let i = 1; i <= 19; i += 1) {
    nodes.push({ id: `n${i}`, label: `node ${i}` });
    const parent = Math.floor((i - 1) / 2);
    edges.push({
      from: parent === 0 ? "root" : `n${parent}`,
      to: `n${i}`,
    });
  }
  const ir = { title: "Twenty nodes", type: "tree", nodes, edges };
  const scene = layout(ir);
  assertSceneInvariants(ir, scene, "tree");
  assert.equal(scene.nodes.filter((node) => node.role === "root").length, 1);
  assert.ok(scene.width > 320 && scene.height > 320, "tree uses both axes");
});

test("tree: single node root", () => {
  const ir = { title: "One node", type: "tree", nodes: [{ id: "only", label: "only" }], edges: [] };
  const scene = layout(ir);
  assertSceneInvariants(ir, scene, "tree");
  assert.equal(scene.nodes[0].role, "root");
  assert.equal(scene.nodes[0].x, 24);
  assert.equal(scene.nodes[0].y, 24);
  assert.deepEqual(scene.legend, []);
});

// ---------------------------------------------------------------------------
// CLI render smoke: the pipeline must not crash for the new shapes.
// ---------------------------------------------------------------------------

test("render: all three new-type fixtures render through the CLI", () => {
  for (const entry of FIXTURES) {
    const input = path.join(TYPES_DIR, entry.file);
    const output = path.join(SCRATCH, `${entry.type}.html`);
    const run = runCli(["render", input, output, "--json"]);
    assert.equal(run.status, 0, `${entry.file} render failed: ${run.stderr}`);
    const receipt = parseJsonStdout(run);
    assert.equal(receipt.ok, true);
    assert.ok(fs.existsSync(output), `${entry.file} output exists`);
    const html = fs.readFileSync(output, "utf8");
    assert.ok(html.includes("<svg"), "html has an svg diagram");
    assert.ok(html.length > 10000, "html is a full document");
  }
});
