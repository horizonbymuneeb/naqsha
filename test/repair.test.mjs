// Self-healing repair suite (owner: convert). The repair pass must be
// deterministic and idempotent, must never delete a node or a non-duplicate
// edge, and must turn the sloppy IR an agent writes into IR that validates.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { repair } from "../src/repair/index.mjs";
import { convertMermaid } from "../src/convert/mermaid.mjs";
import { validate } from "../src/validate/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const FIXTURES_DIR = path.join(ROOT, "test", "mermaid");
const EXAMPLE_NAMES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const FIXTURE_NAMES = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".mmd"))
  .sort();
const chars = (text) => Array.from(text).length;

function readExample(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), "utf8"));
}

function repairTwice(input) {
  const first = repair(input);
  const second = repair(first.ir);
  return { first, second };
}

function brokenIr() {
  return {
    extra: 1,
    title: "",
    type: "flow",
    nodes: [
      { id: "Web App", label: "", kind: "nope", bogus: true },
      { id: "api", label: "API", kind: "service", role: "x" },
      { id: "db", label: "DB" },
      { id: "web-app", label: "Web App" },
    ],
    edges: [
      { from: "Web App", to: "api", label: "call", kind: "main", weight: 2 },
      { from: "api", to: "db", label: "query" },
      { from: "api", to: "db", label: "query" },
      { from: "web-app", to: "api", label: "retry" },
    ],
    groups: [{ id: "Edge Layer", label: "", kind: "nope", nodes: ["Web App", "ghost"] }],
    notes: ["a", "b", "c", "d", "e"],
  };
}

test("repair is a no-op on every canonical example", () => {
  assert.ok(EXAMPLE_NAMES.length >= 3, `expected examples, found ${EXAMPLE_NAMES.length}`);
  for (const name of EXAMPLE_NAMES) {
    const ir = readExample(name);
    const { ir: repaired, changes } = repair(ir);
    assert.deepEqual(changes, [], `${name}: repair changed a valid IR`);
    assert.deepEqual(repaired, ir, `${name}: repair modified content`);
    // Validate the same verdict as the untouched example. (The v1.1 validator
    // decides whether `locale` is accepted; a no-op repair must not change it.)
    assert.deepEqual(validate(repaired), validate(ir), `${name}: repair changed the validator verdict`);
  }
});

test("repair is a no-op on IR produced by convertMermaid", () => {
  for (const name of FIXTURE_NAMES) {
    const converted = convertMermaid(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
    assert.equal(converted.ok, true, `${name}: conversion failed`);
    const { ir, changes } = repair(converted.ir);
    assert.deepEqual(changes, [], `${name}: repair touched freshly converted IR`);
    assert.deepEqual(ir, converted.ir, `${name}: repair changed converted IR`);
    assert.equal(validate(ir).ok, true);
  }
});

test("repair turns a deliberately broken IR into IR that validates", () => {
  const input = brokenIr();
  const { first, second } = repairTwice(input);
  const codes = new Set(first.changes.map((change) => change.code));

  for (const code of ["repair/unknown-key", "repair/type-inferred", "repair/node-kind", "repair/duplicate-edge", "repair/title"]) {
    assert.ok(codes.has(code), `expected ${code} in ${[...codes].join(", ")}`);
  }
  assert.ok(first.changes.length > 5);

  const ir = first.ir;
  assert.deepEqual(ir.nodes.map((node) => node.id), ["web-app", "api", "db", "web-app-2"]);
  assert.equal(ir.nodes[0].label, "Web App");
  assert.equal(ir.nodes[2].kind, "datastore"); // label "DB"
  assert.equal(ir.type, "workflow");
  assert.equal(ir.title, "Workflow diagram");

  assert.equal(ir.edges.length, 3); // duplicate "query" edge dropped
  assert.deepEqual(ir.edges.map((edge) => `${edge.from}->${edge.to}:${edge.label || ""}`), [
    "web-app->api:call",
    "api->db:query",
    "web-app->api:retry",
  ]);

  assert.deepEqual(ir.groups, [{ id: "edge-layer", label: "Edge Layer", kind: "zone", nodes: ["web-app"] }]);
  assert.deepEqual(ir.notes, ["a", "b", "c", "d"]);

  const verdict = validate(ir);
  assert.equal(verdict.ok, true, `repaired IR must validate: ${JSON.stringify(verdict.errors)}`);
  assert.equal(second.changes.length, 0, `repair is not idempotent: ${JSON.stringify(second.changes)}`);
  assert.deepEqual(second.ir, ir);
  assert.deepEqual(repair(input).ir, ir, "repair is not deterministic");
});

test("repair never deletes nodes or non-duplicate edges", () => {
  const input = brokenIr();
  const { first } = repairTwice(input);
  assert.equal(first.ir.nodes.length, input.nodes.length);
  const uniqueEdges = input.edges.filter(
    (edge, index, list) =>
      list.findIndex((other) => other.from === edge.from && other.to === edge.to && (other.label || "") === (edge.label || "")) === index,
  );
  assert.equal(first.ir.edges.length, uniqueEdges.length);

  const clean = {
    title: "Keep everything",
    type: "architecture",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "datastore" },
    ],
    edges: [
      { from: "a", to: "b", label: "one", kind: "data" },
      { from: "b", to: "a", label: "two", kind: "return" },
      { from: "a", to: "b", label: "three", kind: "main" },
    ],
  };
  const { ir } = repair(clean);
  assert.equal(ir.nodes.length, 2);
  assert.equal(ir.edges.length, 3);
});

test("node kind is inferred from id/label keywords, else service", () => {
  const ir = repair({
    title: "Kinds",
    type: "architecture",
    nodes: ["Postgres DB", "End User", "Auth Gateway", "Event Broker", "Job Worker", "Mystery Box"].map((label, index) => ({
      id: `n${index}`,
      label,
    })),
  }).ir;
  assert.deepEqual(ir.nodes.map((node) => node.kind), ["datastore", "actor", "security", "queue", "compute", "service"]);
  assert.equal(validate(ir).ok, true);

  const kept = repair({
    title: "Explicit",
    type: "workflow",
    nodes: [
      { id: "x", label: "X", kind: "state" },
      { id: "y", label: "Y", kind: "banana" },
    ],
  });
  assert.equal(kept.ir.nodes[0].kind, "state");
  assert.equal(kept.ir.nodes[1].kind, "service");
  assert.ok(kept.changes.some((change) => change.code === "repair/node-kind" && change.path === "nodes[1].kind"));
});

test("ids are normalized, deduped with -2 and referenced from edges/groups", () => {
  const { first } = repairTwice({
    title: "Ids",
    type: "architecture",
    nodes: [
      { id: "Web App", label: "Web App" },
      { id: "web_app", label: "Web App Two" },
      { id: "1 endpoint", label: "First Endpoint" },
      { id: "!!!", label: "Odd" },
      { id: "api", label: "API", kind: "service" },
    ],
    edges: [
      { from: "Web App", to: "API", label: "call", kind: "main" },
      { from: "web_app", to: "1 endpoint", label: "forward", kind: "main" },
      { from: "!!!", to: "api", label: "odd", kind: "main" },
    ],
    groups: [{ id: "Edge Layer", label: "Edge Layer", kind: "zone", nodes: ["Web App"] }],
  });
  const ir = first.ir;
  assert.deepEqual(ir.nodes.map((node) => node.id), ["web-app", "web-app-2", "n-1-endpoint", "node", "api"]);
  assert.deepEqual(ir.edges.map((edge) => `${edge.from}->${edge.to}`), ["web-app->api", "web-app-2->n-1-endpoint", "node->api"]);
  assert.equal(ir.groups[0].id, "edge-layer");
  assert.deepEqual(ir.groups[0].nodes, ["web-app"]);
  assert.equal(validate(ir).ok, true);
});

test("group ids/labels are normalized and empty or overlapping groups are dropped", () => {
  const { first } = repairTwice({
    title: "Groups",
    type: "workflow",
    direction: "TD",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
      { id: "c", label: "C", kind: "service" },
    ],
    groups: [
      { id: "Group One", kind: "weird", nodes: ["a", "a", "ghost"] },
      { id: "Group Two", nodes: ["a", "b"] },
      { id: "empty one", label: "", nodes: [] },
    ],
  });
  const ir = first.ir;
  assert.deepEqual(ir.groups.map((group) => group.id), ["group-one", "group-two"]);
  assert.deepEqual(ir.groups.map((group) => group.label), ["Group One", "Group Two"]);
  assert.deepEqual(ir.groups.map((group) => group.kind), ["zone", "zone"]);
  assert.deepEqual(ir.groups[0].nodes, ["a"]);
  assert.deepEqual(ir.groups[1].nodes, ["b"]);
  assert.equal(validate(ir).ok, true);
  const codes = first.changes.map((change) => change.code);
  assert.ok(codes.includes("repair/group-dangling"));
  assert.ok(codes.includes("repair/group-kind"));
  assert.ok(codes.includes("repair/group-label"));
});

test("node.group is kept only when it resolves and stays consistent", () => {
  const base = {
    title: "Member",
    type: "workflow",
    nodes: [
      { id: "a", label: "A", kind: "service", group: "Group One" },
      { id: "b", label: "B", kind: "service", group: "missing" },
      { id: "c", label: "C", kind: "service", group: "Group Two" },
      { id: "d", label: "D", kind: "service", group: "Group One" },
    ],
    groups: [
      { id: "Group One", label: "Group One", kind: "zone", nodes: ["a"] },
      { id: "Group Two", label: "Group Two", kind: "zone", nodes: ["b", "d"] },
    ],
  };
  const { first } = repairTwice(base);
  const ir = first.ir;
  assert.equal(ir.nodes[0].group, "group-one"); // already listed there
  assert.equal(ir.nodes[1].group, undefined); // unknown group id -> dropped
  assert.equal(ir.nodes[2].group, "group-two"); // declared but not listed -> added to its group
  assert.ok(ir.groups[1].nodes.includes("c"));
  assert.equal(ir.nodes[3].group, undefined); // declares group one but is listed in group two -> dropped
  assert.equal(validate(ir).ok, true);
  const codes = first.changes.map((change) => change.code);
  assert.ok(codes.includes("repair/node-group"));

  // A node that declares a group without being listed gets added to it.
  const added = repair({
    title: "Add",
    type: "workflow",
    nodes: [{ id: "a", label: "A", kind: "service", group: "edge" }],
    groups: [{ id: "edge", label: "Edge", kind: "zone", nodes: [] }],
  }).ir;
  assert.deepEqual(added.groups[0].nodes, ["a"]);
  assert.equal(added.nodes[0].group, "edge");
  assert.equal(validate(added).ok, true);
});

test("missing type is inferred (fragment -> sequence, else workflow); declared type kept", () => {
  const fragment = {
    title: "Tour",
    nodes: [
      { id: "user", label: "User", kind: "actor" },
      { id: "api", label: "API", kind: "service" },
    ],
    edges: [{ from: "user", to: "api", label: "call", kind: "main" }],
    groups: [{ id: "loop-1", label: "loop", kind: "fragment", nodes: ["user", "api"] }],
  };
  const sequence = repair(fragment);
  assert.equal(sequence.ir.type, "sequence");
  assert.ok(sequence.changes.some((change) => change.code === "repair/type-inferred"));
  assert.equal(validate(sequence.ir).ok, true);

  const plain = repair({ title: "Plain", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(plain.ir.type, "workflow");

  const declared = repair({ title: "Decl", type: "architecture", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(declared.ir.type, "architecture");
  assert.ok(!declared.changes.some((change) => change.code === "repair/type-inferred"));

  const invalid = repair({ title: "Bad", type: "flow", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(invalid.ir.type, "workflow");
  assert.ok(invalid.changes.some((change) => change.code === "repair/type-inferred"));
});

test("direction is normalized and dropped where it cannot exist", () => {
  const td = repair({ title: "TD", type: "workflow", direction: "TD", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(td.ir.direction, "TB");
  assert.ok(td.changes.some((change) => change.code === "repair/direction-mapped"));

  const rl = repair({ title: "RL", type: "workflow", direction: "RL", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(rl.ir.direction, "LR");

  const bad = repair({ title: "Bad", type: "workflow", direction: "diagonal", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(bad.ir.direction, undefined);
  assert.ok(bad.changes.some((change) => change.code === "repair/direction-dropped"));

  const seq = repair({ title: "Seq", type: "sequence", direction: "LR", nodes: [{ id: "a", label: "A", kind: "actor" }] });
  assert.equal(seq.ir.direction, undefined);
});

test("title, subtitle and notes are derived and capped", () => {
  const arch = repair({ type: "architecture", nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(arch.ir.title, "Architecture diagram");
  const seq = repair({ type: "sequence", nodes: [{ id: "a", label: "A", kind: "actor" }] });
  assert.equal(seq.ir.title, "Sequence diagram");
  const flow = repair({ nodes: [{ id: "a", label: "A", kind: "service" }] });
  assert.equal(flow.ir.title, "Workflow diagram");

  const long = repair({
    title: "t".repeat(120),
    subtitle: "s".repeat(150),
    type: "workflow",
    nodes: [{ id: "a", label: "A", kind: "service" }],
    notes: ["n".repeat(200), "b", "c", "d", "e"],
  });
  assert.ok(chars(long.ir.title) <= 80);
  assert.ok(chars(long.ir.subtitle) <= 120);
  assert.equal(long.ir.notes.length, 4);
  assert.ok(chars(long.ir.notes[0]) <= 140);
  assert.equal(validate(long.ir).ok, true);
});

test("duplicate edges are dropped but distinct labels, kinds and reverse edges survive", () => {
  const { first } = repairTwice({
    title: "Edges",
    type: "workflow",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
    ],
    edges: [
      { from: "a", to: "b", label: "x", kind: "main" },
      { from: "a", to: "b", label: " x ", kind: "main" },
      { from: "a", to: "b", label: "x", kind: "return" },
      { from: "a", to: "b", label: "y", kind: "data" },
      { from: "b", to: "a", label: "x", kind: "main" },
      { from: "a", to: "b", kind: "async" },
      { from: "a", to: "b", kind: "main" },
    ],
  });
  const ir = first.ir;
  assert.equal(ir.edges.length, 4); // a->b x, a->b y, b->a x, a->b (unlabelled)
  assert.ok(first.changes.some((change) => change.code === "repair/duplicate-edge"));
  assert.equal(validate(ir).ok, true);
});

test("changes are capped at 100 entries", () => {
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `n${index}`,
    label: `N${index}`,
    kind: "service",
    bad1: 1,
    bad2: 2,
    bad3: 3,
  }));
  const result = repair({ title: "Cap", type: "architecture", nodes });
  assert.equal(result.changes.length, 100);
  for (const change of result.changes) {
    assert.deepEqual(Object.keys(change).sort(), ["code", "note", "path"]);
    assert.equal(typeof change.code, "string");
    assert.equal(typeof change.path, "string");
    assert.equal(typeof change.note, "string");
  }
  assert.equal(validate(result.ir).ok, true);
});

test("repair is idempotent and deterministic on a matrix of malformed inputs", () => {
  const matrix = [
    {},
    null,
    [],
    { nodes: "nope" },
    { nodes: [null, {}] },
    { type: 5, nodes: [{ id: "Web App" }] },
    { title: "x".repeat(100), type: "arch", direction: "diagonal", nodes: [{ id: "a", label: "A", kind: "service" }] },
    { nodes: [{ id: "a", group: "missing", label: "A", kind: "service" }] },
    { nodes: [{ id: "a", label: "A", kind: "service" }], edges: "nope" },
    { nodes: [{ id: "a", label: "A", kind: "service" }], edges: [{ from: "a", to: "ghost" }] },
    { nodes: [{ id: "a", label: "A", kind: "service" }], walkthrough: [{ title: "t", text: "x", focus: ["a"], extra: 1 }], locale: "xx" },
    { nodes: [{ id: "a", label: "A", kind: "service" }], groups: [{ id: "g", nodes: [] }] },
    { nodes: [{ id: "a", label: "A", kind: "service" }], notes: ["n".repeat(200), 5, ""] },
    {
      nodes: Array.from({ length: 3 }, () => ({ id: "a", label: "A", kind: "service" })),
    },
  ];
  for (const [index, input] of matrix.entries()) {
    const first = repair(input);
    const second = repair(first.ir);
    assert.equal(second.changes.length, 0, `matrix[${index}]: second repair produced ${JSON.stringify(second.changes)}`);
    assert.deepEqual(second.ir, first.ir, `matrix[${index}]: second repair changed the IR`);
    assert.deepEqual(repair(input).ir, first.ir, `matrix[${index}]: repair is not deterministic`);
  }
});

test("IR v1.1 locale and walkthrough are preserved and normalized", () => {
  const { first, second } = repairTwice({
    title: "Tour",
    type: "architecture",
    locale: "ur",
    nodes: [
      { id: "Web App", label: "Web App", kind: "service" },
      { id: "api", label: "API", kind: "service" },
    ],
    edges: [{ from: "Web App", to: "api", label: "call", kind: "main" }],
    walkthrough: [
      { title: "Step one", text: "Browser calls the API.", focus: ["Web App", "nope", "api"], extra: true },
      { title: "", text: "no title", focus: ["api"] },
      { title: "Ghost", text: "focus is gone", focus: ["ghost"] },
    ],
  });
  const ir = first.ir;
  assert.equal(ir.locale, "ur");
  assert.equal(ir.walkthrough.length, 1);
  assert.deepEqual(ir.walkthrough[0].focus, ["web-app", "api"]);
  assert.ok(first.changes.some((change) => change.code === "repair/unknown-key" && change.path === "walkthrough[0].extra"));
  assert.equal(second.changes.length, 0);
  // Validate the walkthrough without the optional locale field so the suite is
  // independent of how far the v1.1 validator has shipped locale support.
  const withoutLocale = JSON.parse(JSON.stringify(ir));
  delete withoutLocale.locale;
  assert.equal(validate(withoutLocale).ok, true, `v1.1 walkthrough must validate: ${JSON.stringify(validate(withoutLocale).errors)}`);

  const invalidLocale = repair({
    title: "Loc",
    type: "workflow",
    locale: "xx",
    nodes: [{ id: "a", label: "A", kind: "service" }],
  });
  assert.equal(invalidLocale.ir.locale, undefined);
  assert.ok(invalidLocale.changes.some((change) => change.code === "repair/locale"));
});

test("result shape is {ir, changes} with {code,path,note} entries only", () => {
  for (const input of [brokenIr(), {}, null, readExample(EXAMPLE_NAMES[0])]) {
    const result = repair(input);
    assert.deepEqual(Object.keys(result).sort(), ["changes", "ir"]);
    assert.ok(result.ir && typeof result.ir === "object" && !Array.isArray(result.ir));
    assert.ok(Array.isArray(result.changes));
    for (const change of result.changes) {
      assert.deepEqual(Object.keys(change).sort(), ["code", "note", "path"]);
      assert.ok(change.code.startsWith("repair/"), `unexpected change code ${change.code}`);
    }
  }
});
