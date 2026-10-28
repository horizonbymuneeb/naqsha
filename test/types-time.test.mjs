// Layout tests for the v1.2 time/flow diagram types — owner: types-time.
//
// Covers timeline, waterfall, dataflow and lifecycle: scene shape, axis ticks
// (4..8, ordered, inside the axis), lane bands, bar mapping, stage columns,
// state roles, cycle safety, determinism, in-bounds boxes / no overlaps, plus
// an end-to-end CLI render of every shipped fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validate } from "../src/validate/index.mjs";
import { layout } from "../src/layout/index.mjs";
import { layoutTimeline } from "../src/layout/types/timeline.mjs";
import { layoutWaterfall } from "../src/layout/types/waterfall.mjs";
import { layoutDataflow } from "../src/layout/types/dataflow.mjs";
import { layoutLifecycle } from "../src/layout/types/lifecycle.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = {
  timeline: "release.timeline.json",
  waterfall: "request.waterfall.json",
  dataflow: "analytics.dataflow.json",
  lifecycle: "order.lifecycle.json",
};
const ENGINES = {
  timeline: layoutTimeline,
  waterfall: layoutWaterfall,
  dataflow: layoutDataflow,
  lifecycle: layoutLifecycle,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const loadFixture = (file) => JSON.parse(readFileSync(join(ROOT, "test", "fixtures", file), "utf8"));

function inside(scene, x, y, w = 0, h = 0) {
  return x >= -0.001 && y >= -0.001 && x + w <= scene.width + 0.001 && y + h <= scene.height + 0.001;
}

function assertSceneBase(scene, type, ir) {
  assert.equal(scene.sceneVersion, 1);
  assert.equal(scene.type, type);
  assert.equal(scene.title, ir.title);
  assert.deepEqual(scene.meta, { padding: 24, sceneVersion: 1 });
  assert.ok(Number.isInteger(scene.width) && scene.width > 0);
  assert.ok(Number.isInteger(scene.height) && scene.height > 0);
  assert.ok(Array.isArray(scene.nodes) && Array.isArray(scene.groups));
  assert.ok(Array.isArray(scene.edges) && Array.isArray(scene.legend));

  for (const node of scene.nodes) {
    assert.ok(inside(scene, node.x, node.y, node.w, node.h), `node ${node.id} out of bounds`);
    assert.equal(typeof node.label, "string");
    assert.ok(node.w > 0 && node.h > 0, `node ${node.id} has no size`);
  }
  for (const group of scene.groups) {
    assert.ok(inside(scene, group.x, group.y, group.w, group.h), `group ${group.id} out of bounds`);
  }
  const nodeIds = new Set(scene.nodes.map((node) => node.id));
  for (const edge of scene.edges) {
    assert.ok(edge.points.length >= 2, `edge ${edge.id} has <2 points`);
    for (const point of edge.points) assert.ok(inside(scene, point.x, point.y), `edge ${edge.id} point out of bounds`);
    assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to), `edge ${edge.id} endpoints missing`);
    if (edge.labelBox) assert.ok(inside(scene, edge.labelBox.x, edge.labelBox.y, edge.labelBox.w, edge.labelBox.h));
  }
  // No two node boxes overlap.
  for (let i = 0; i < scene.nodes.length; i += 1) {
    for (let j = i + 1; j < scene.nodes.length; j += 1) {
      const a = scene.nodes[i];
      const b = scene.nodes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 0.5 || oy <= 0.5, `nodes ${a.id} and ${b.id} overlap`);
    }
  }
}

function assertAxis(scene, kind) {
  const axis = scene.axis;
  assert.ok(axis, "scene.axis missing");
  assert.equal(axis.kind, kind);
  assert.ok(axis.min < axis.max, "axis min must be < max");
  assert.ok(axis.x0 >= 0 && axis.x1 <= scene.width && axis.x1 > axis.x0);
  assert.ok(axis.y >= 0 && axis.y <= scene.height);
  assert.ok(Array.isArray(axis.ticks));
  assert.ok(axis.ticks.length >= 4 && axis.ticks.length <= 8, `axis has ${axis.ticks.length} ticks (expected 4..8)`);
  for (let i = 0; i < axis.ticks.length; i += 1) {
    const tick = axis.ticks[i];
    assert.equal(typeof tick.label, "string");
    assert.ok(tick.label.length > 0);
    assert.ok(tick.x >= axis.x0 - 0.51 && tick.x <= axis.x1 + 0.51, `tick ${i} outside axis`);
    if (i > 0) assert.ok(tick.x > axis.ticks[i - 1].x, `tick ${i} not ascending`);
  }
  assert.equal(axis.ticks[0].x, Math.round(axis.x0), "first tick should sit at the axis start");
  assert.equal(axis.ticks[axis.ticks.length - 1].x, Math.round(axis.x1), "last tick should sit at the axis end");
}

const dayOf = (at) => (typeof at === "number" ? at : Date.parse(`${at}T00:00:00Z`) / 86400000);

function assertTimeline(scene, ir) {
  assertSceneBase(scene, "timeline", ir);
  assertAxis(scene, "time");
  assert.ok(scene.width >= 900, "timeline should be at least 900px wide");
  assert.equal(scene.nodes.length, ir.nodes.length);
  for (const node of scene.nodes) {
    assert.equal(node.shape, "event");
    const source = ir.nodes.find((candidate) => candidate.id === node.id);
    assert.deepEqual(node.at, source.at, `node ${node.id} lost its "at"`);
    assert.ok(Array.isArray(node.leader) && node.leader.length >= 2, `node ${node.id} has no leader`);
    const anchor = node.leader[node.leader.length - 1];
    const expectedX = Math.round(scene.axis.x0 + ((dayOf(source.at) - scene.axis.min) / (scene.axis.max - scene.axis.min)) * (scene.axis.x1 - scene.axis.x0));
    assert.equal(anchor.x, expectedX, `node ${node.id} leader should end on its axis point`);
    assert.equal(anchor.y, scene.axis.y + 8);
    for (const point of node.leader) assert.ok(inside(scene, point.x, point.y), `node ${node.id} leader out of bounds`);
  }
  const hasLanes = ir.nodes.some((node) => typeof node.lane === "string" && node.lane.trim());
  if (hasLanes) {
    assert.ok(Array.isArray(scene.lanes) && scene.lanes.length >= 1);
    for (const node of scene.nodes) {
      assert.ok(
        scene.lanes.some((lane) => node.y >= lane.y - 0.5 && node.y + node.h <= lane.y + lane.h + 0.5),
        `node ${node.id} outside every lane band`,
      );
    }
  }
}

function assertWaterfall(scene, ir) {
  assertSceneBase(scene, "waterfall", ir);
  assertAxis(scene, "numeric");
  assert.equal(scene.axis.min, 0);
  assert.equal(scene.axis.ticks[0].label, "0");
  const maxEnd = Math.max(...ir.nodes.map((node) => node.start + node.duration));
  assert.ok(scene.axis.max >= maxEnd - 1e-9, "axis max must cover every span");
  assert.equal(scene.nodes.length, ir.nodes.length);
  const scale = (value) => scene.axis.x0 + (value / scene.axis.max) * (scene.axis.x1 - scene.axis.x0);
  for (const node of scene.nodes) {
    const span = ir.nodes.find((candidate) => candidate.id === node.id);
    assert.equal(node.shape, "span");
    assert.deepEqual(node.bar, { start: span.start, duration: span.duration });
    assert.ok(node.x >= scene.axis.x0 - 1 && node.x + node.w <= scene.axis.x1 + 0.51);
    assert.ok(Math.abs(node.x - scale(span.start)) <= 1, `bar ${node.id} start not mapped`);
    const expectedW = Math.max(6, Math.round((span.duration / scene.axis.max) * (scene.axis.x1 - scene.axis.x0)));
    assert.ok(Math.abs(node.w - expectedW) <= 1, `bar ${node.id} duration not mapped`);
    assert.equal(typeof node.valueLabel, "string");
    assert.ok(node.valueLabel.length > 0, `bar ${node.id} has no duration label`);
    assert.ok(node.labelBox && inside(scene, node.labelBox.x, node.labelBox.y, node.labelBox.w, node.labelBox.h));
    assert.ok(node.valueBox && inside(scene, node.valueBox.x, node.valueBox.y, node.valueBox.w, node.valueBox.h));
  }
  // Overlapping spans must not share a row.
  for (let i = 0; i < scene.nodes.length; i += 1) {
    for (let j = i + 1; j < scene.nodes.length; j += 1) {
      const a = ir.nodes.find((node) => node.id === scene.nodes[i].id);
      const b = ir.nodes.find((node) => node.id === scene.nodes[j].id);
      const overlaps = a.start < b.start + b.duration && b.start < a.start + a.duration;
      if (overlaps) assert.ok(Math.abs(scene.nodes[i].y - scene.nodes[j].y) >= 0.5, `overlapping spans ${a.id}, ${b.id} share a row`);
    }
  }
  assert.ok(Array.isArray(scene.lanes) && scene.lanes.length >= 1);
}

function assertDataflow(scene, ir) {
  assertSceneBase(scene, "dataflow", ir);
  const stages = [];
  for (const node of ir.nodes) {
    const stage = typeof node.stage === "string" && node.stage.trim() ? node.stage.trim() : "Flow";
    if (!stages.includes(stage)) stages.push(stage);
  }
  assert.equal(scene.groups.length, stages.length);
  for (const group of scene.groups) assert.equal(group.kind, "zone");
  for (let i = 1; i < scene.groups.length; i += 1) {
    assert.ok(scene.groups[i].x > scene.groups[i - 1].x, "stage columns must run left to right");
  }
  for (const node of scene.nodes) {
    const group = scene.groups.find((candidate) => candidate.id === node.group);
    assert.ok(group, `node ${node.id} has no stage group`);
    assert.ok(node.x >= group.x && node.x + node.w <= group.x + group.w, `node ${node.id} outside its stage column`);
    assert.ok(node.y >= group.y + 22, `node ${node.id} clashes with the stage header band`);
  }
  for (const edge of scene.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      assert.ok(Math.abs(a.x - b.x) < 0.001 || Math.abs(a.y - b.y) < 0.001, `edge ${edge.id} is not orthogonal`);
    }
  }
  const kinds = [...new Set(scene.edges.map((edge) => edge.kind))].sort();
  assert.deepEqual(scene.legend.map((entry) => entry.kind).sort(), kinds);
}

function assertLifecycle(scene, ir) {
  assertSceneBase(scene, "lifecycle", ir);
  const ids = ir.nodes.map((node) => node.id);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, 0]));
  for (const edge of ir.edges || []) {
    if (incoming.has(edge.to)) incoming.set(edge.to, incoming.get(edge.to) + 1);
    if (outgoing.has(edge.from)) outgoing.set(edge.from, outgoing.get(edge.from) + 1);
  }
  let starts = ids.filter((id) => incoming.get(id) === 0);
  if (starts.length === 0 && ids.length) starts = [ids[0]];
  const startSet = new Set(starts);
  const ends = ids.filter((id) => outgoing.get(id) === 0 && !startSet.has(id));
  for (const node of scene.nodes) {
    assert.equal(node.shape, "state");
    const expected = startSet.has(node.id) ? "start" : ends.includes(node.id) ? "end" : "state";
    assert.equal(node.role, expected, `node ${node.id} role`);
  }
  const validEdges = (ir.edges || []).filter((edge) => ids.includes(edge.from) && ids.includes(edge.to) && edge.from !== edge.to);
  assert.equal(scene.edges.length, validEdges.length);
  for (const edge of scene.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      assert.ok(Math.abs(a.x - b.x) < 0.001 || Math.abs(a.y - b.y) < 0.001, `edge ${edge.id} is not orthogonal`);
    }
  }
}

/* ------------------------------------------------------------------ tests */

test("timeline: fixture layout matches the scene v3 contract", () => {
  const ir = loadFixture(FIXTURES.timeline);
  assert.equal(validate(ir).ok, true);
  const scene = layout(ir);
  assertTimeline(scene, ir);
  assert.deepEqual(scene.lanes.map((lane) => lane.label), ["naqsha", "incidents"]);
  assert.equal(scene.nodes.length, 6);
  assert.equal(scene.edges.length, 0);
});

test("timeline: numeric `at` values and single-date domains stay readable", () => {
  const numeric = {
    title: "Numeric timeline",
    type: "timeline",
    nodes: [
      { id: "a", label: "Alpha", at: 1 },
      { id: "b", label: "Beta", at: 4.5 },
      { id: "c", label: "Gamma", at: 9 },
      { id: "d", label: "Delta", at: 13 },
    ],
  };
  assertTimeline(layoutTimeline(numeric), numeric);

  const sameDay = {
    title: "One day",
    type: "timeline",
    nodes: [
      { id: "a", label: "First", at: "2026-05-09" },
      { id: "b", label: "Second", at: "2026-05-09" },
      { id: "c", label: "Third", at: "2026-05-09", lane: "day" },
    ],
  };
  const scene = layoutTimeline(sameDay);
  assertTimeline(scene, sameDay);
  assert.ok(scene.axis.max > scene.axis.min, "a single instant must still get a readable domain");
});

test("timeline: same-date events collide deterministically without overlapping", () => {
  const ir = {
    title: "Dense day",
    type: "timeline",
    nodes: ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ id, label: `Event ${index + 1}`, at: "2026-05-09", lane: "day" })),
  };
  const scene = layoutTimeline(ir);
  assertTimeline(scene, ir);
  assert.deepEqual(layoutTimeline(clone(ir)), scene);
});

test("waterfall: fixture bars, axis and row packing", () => {
  const ir = loadFixture(FIXTURES.waterfall);
  assert.equal(validate(ir).ok, true);
  const scene = layout(ir);
  assertWaterfall(scene, ir);
});

test("waterfall: nested and adjacent spans stack only when they overlap", () => {
  const nested = {
    title: "Nested",
    type: "waterfall",
    nodes: [
      { id: "parent", label: "Parent", start: 0, duration: 100 },
      { id: "child1", label: "Child 1", start: 10, duration: 20 },
      { id: "child2", label: "Child 2", start: 20, duration: 30 },
      { id: "child3", label: "Child 3", start: 30, duration: 40 },
    ],
  };
  assertWaterfall(layoutWaterfall(nested), nested);

  const adjacent = {
    title: "Adjacent",
    type: "waterfall",
    nodes: [
      { id: "a", label: "A", start: 0, duration: 10 },
      { id: "b", label: "B", start: 10, duration: 10 },
      { id: "c", label: "C", start: 20, duration: 10 },
    ],
  };
  const scene = layoutWaterfall(adjacent);
  assertWaterfall(scene, adjacent);
  assert.equal(new Set(scene.nodes.map((node) => node.y)).size, scene.nodes.length, "each span gets its own labelled row");
});

test("dataflow: fixture stage columns and edges", () => {
  const ir = loadFixture(FIXTURES.dataflow);
  assert.equal(validate(ir).ok, true);
  const scene = layout(ir);
  assertDataflow(scene, ir);
  assert.deepEqual(scene.groups.map((group) => group.label), ["collect", "store", "transform", "serve"]);
});

test("dataflow: no-stage IR falls back to a single flow column", () => {
  const ir = {
    title: "Flat",
    type: "dataflow",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "datastore" },
    ],
    edges: [{ from: "a", to: "b", label: "write", kind: "data" }],
  };
  const scene = layoutDataflow(ir);
  assertDataflow(scene, ir);
  assert.equal(scene.groups.length, 1);
});

test("dataflow: backward and same-column edges route orthogonally", () => {
  const ir = {
    title: "Retry loop",
    type: "dataflow",
    nodes: [
      { id: "a", label: "Ingest", stage: "in", kind: "service" },
      { id: "b", label: "Validate", stage: "in", kind: "service" },
      { id: "c", label: "Store", stage: "mid", kind: "datastore" },
      { id: "d", label: "Retry", stage: "back", kind: "compute" },
      { id: "e", label: "Serve", stage: "out", kind: "external" },
    ],
    edges: [
      { from: "a", to: "b", label: "next", kind: "main" },
      { from: "b", to: "c", label: "persist", kind: "data" },
      { from: "c", to: "d", label: "fail", kind: "async" },
      { from: "d", to: "a", label: "replay", kind: "return" },
      { from: "c", to: "e", label: "read", kind: "main" },
    ],
  };
  const scene = layoutDataflow(ir);
  assertDataflow(scene, ir);
});

test("lifecycle: fixture roles and transitions", () => {
  const ir = loadFixture(FIXTURES.lifecycle);
  assert.equal(validate(ir).ok, true);
  const scene = layout(ir);
  assertLifecycle(scene, ir);
  const byId = new Map(scene.nodes.map((node) => [node.id, node.role]));
  assert.equal(byId.get("draft"), "start");
  assert.equal(byId.get("refunded"), "end");
  assert.equal(byId.get("cancelled"), "end");
});

test("lifecycle: cycles render deterministically and stay bounded", () => {
  const ir = loadFixture(FIXTURES.lifecycle);
  ir.edges.push({ from: "refunded", to: "draft", label: "reopen" });
  ir.edges.push({ from: "cancelled", to: "draft", label: "retry" });
  const scene = layoutLifecycle(ir);
  assertLifecycle(scene, ir);
  assert.deepEqual(layoutLifecycle(clone(ir)), scene);

  const loop = {
    title: "Two-state loop",
    type: "lifecycle",
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b", label: "go" }, { from: "b", to: "a", label: "back" }],
  };
  const loopScene = layoutLifecycle(loop);
  assertLifecycle(loopScene, loop);
  assert.deepEqual(layoutLifecycle(clone(loop)), loopScene);
});

test("lifecycle: a 20-state chain stays overlap-free", () => {
  const ir = {
    title: "Long chain",
    type: "lifecycle",
    nodes: Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, label: `State ${index}` })),
    edges: Array.from({ length: 19 }, (_, index) => ({ from: `s${index}`, to: `s${index + 1}`, label: `next ${index}` })),
  };
  assertLifecycle(layoutLifecycle(ir), ir);
});

test("scene copy-through: subtitle, notes and walkthrough", () => {
  for (const [type, file] of Object.entries(FIXTURES)) {
    const ir = loadFixture(file);
    ir.subtitle = "production history";
    ir.notes = ["One note"];
    ir.walkthrough = [{ title: "Start", text: "Where it begins", focus: [ir.nodes[0].id] }];
    const scene = ENGINES[type](ir);
    assert.equal(scene.title, ir.title);
    assert.equal(scene.subtitle, "production history");
    assert.deepEqual(scene.notes, ["One note"]);
    assert.equal(scene.walkthrough.length, 1);
    assert.equal(scene.walkthrough[0].n, 1);
    assert.equal(scene.walkthrough[0].focus[0], ir.nodes[0].id);
  }
});

test("cli render: every time/flow fixture renders to a self-contained HTML file", () => {
  const outDir = mkdtempSync(join(tmpdir(), "naqsha-types-time-"));
  for (const [type, file] of Object.entries(FIXTURES)) {
    const input = join(ROOT, "test", "fixtures", file);
    const output = join(outDir, `${type}.html`);
    const result = spawnSync(process.execPath, [join(ROOT, "src", "cli", "naqsha.mjs"), "render", input, output, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, `${type} render failed: ${result.stderr || result.stdout}`);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.ok, true);
    assert.ok(existsSync(output), `${type} html missing`);
    assert.ok(statSync(output).size > 1000, `${type} html suspiciously small`);
  }
});
