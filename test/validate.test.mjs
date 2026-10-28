import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  validate,
  DIAGRAM_TYPES,
  DIRECTIONS,
  NODE_KINDS,
  EDGE_KINDS,
  GROUP_KINDS,
  ID_PATTERN,
  LIMITS,
} from "../src/validate/index.mjs";
import { exampleFiles, minimalArchitecture, minimalSequence, minimalWorkflow, richIr, validIrFor } from "./helpers.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function withGroups() {
  const ir = clone(minimalArchitecture());
  ir.nodes[0].group = "edge";
  ir.groups = [{ id: "edge", label: "Edge", kind: "zone", nodes: ["web"] }];
  return ir;
}

function makeNodes(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`,
    kind: "service",
  }));
}

const ERROR_CASES = [
  {
    name: "unknown top-level key",
    code: "ir/unknown-key",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.titel = "typo";
      return ir;
    },
  },
  {
    name: "unknown node key",
    code: "ir/unknown-key",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].colour = "red";
      return ir;
    },
  },
  {
    name: "unknown edge key",
    code: "ir/unknown-key",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges[0].style = "thick";
      return ir;
    },
  },
  {
    name: "unknown group key",
    code: "ir/unknown-key",
    make: () => {
      const ir = withGroups();
      ir.groups[0].colour = "red";
      return ir;
    },
  },
  {
    name: "missing title",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.title;
      return ir;
    },
  },
  {
    name: "missing type",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.type;
      return ir;
    },
  },
  {
    name: "missing nodes",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.nodes;
      return ir;
    },
  },
  {
    name: "node missing id",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.nodes[0].id;
      return ir;
    },
  },
  {
    name: "node missing label",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.nodes[0].label;
      return ir;
    },
  },
  {
    name: "node missing kind",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.nodes[0].kind;
      return ir;
    },
  },
  {
    name: "edge missing from",
    code: "ir/required",
    make: () => {
      const ir = clone(minimalArchitecture());
      delete ir.edges[0].from;
      return ir;
    },
  },
  {
    name: "group missing nodes",
    code: "ir/required",
    make: () => {
      const ir = withGroups();
      delete ir.groups[0].nodes;
      return ir;
    },
  },
  {
    name: "title wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.title = 42;
      return ir;
    },
  },
  {
    name: "nodes wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes = { web: {} };
      return ir;
    },
  },
  {
    name: "edges wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges = "web -> db";
      return ir;
    },
  },
  {
    name: "notes wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.notes = { note: "x" };
      return ir;
    },
  },
  {
    name: "subtitle wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.subtitle = 2026;
      return ir;
    },
  },
  {
    name: "direction wrong type",
    code: "ir/type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.direction = ["TB"];
      return ir;
    },
  },
  {
    name: "empty title",
    code: "ir/title-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.title = "   ";
      return ir;
    },
  },
  {
    name: "81 character title",
    code: "ir/title-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.title = "x".repeat(81);
      return ir;
    },
  },
  {
    name: "121 character subtitle",
    code: "ir/subtitle-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.subtitle = "s".repeat(121);
      return ir;
    },
  },
  {
    name: "unknown diagram type",
    code: "ir/unknown-type",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.type = "flow";
      return ir;
    },
  },
  {
    name: "unknown direction",
    code: "ir/unknown-direction",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.direction = "UP";
      return ir;
    },
  },
  {
    name: "zero nodes",
    code: "ir/nodes-count",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes = [];
      ir.edges = [];
      return ir;
    },
  },
  {
    name: "41 nodes",
    code: "ir/nodes-count",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes = makeNodes(41);
      ir.edges = [];
      return ir;
    },
  },
  {
    name: "81 edges",
    code: "ir/edges-count",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges = Array.from({ length: 81 }, (_, index) => ({ from: "web", to: "db", label: `call-${index}`, kind: "main" }));
      return ir;
    },
  },
  {
    name: "uppercase node id",
    code: "ir/node-id-format",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].id = "Web";
      ir.edges[0].from = "Web";
      return ir;
    },
  },
  {
    name: "33 character node id",
    code: "ir/node-id-format",
    make: () => {
      const ir = clone(minimalArchitecture());
      const longId = `a${"b".repeat(32)}`;
      ir.nodes[0].id = longId;
      ir.edges[0].from = longId;
      return ir;
    },
  },
  {
    name: "duplicate node id",
    code: "ir/duplicate-id",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes.push({ id: "web", label: "Second web", kind: "service" });
      return ir;
    },
  },
  {
    name: "duplicate group id",
    code: "ir/duplicate-id",
    make: () => {
      const ir = withGroups();
      ir.groups.push({ id: "edge", label: "Edge again", kind: "zone", nodes: ["db"] });
      return ir;
    },
  },
  {
    name: "unknown node kind",
    code: "ir/unknown-kind",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].kind = "server";
      return ir;
    },
  },
  {
    name: "unknown edge kind",
    code: "ir/unknown-kind",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges[0].kind = "sync";
      return ir;
    },
  },
  {
    name: "unknown group kind",
    code: "ir/unknown-kind",
    make: () => {
      const ir = withGroups();
      ir.groups[0].kind = "cluster";
      return ir;
    },
  },
  {
    name: "fragment group outside sequence",
    code: "ir/fragment-non-sequence",
    make: () => {
      const ir = withGroups();
      ir.groups[0].kind = "fragment";
      return ir;
    },
  },
  {
    name: "dangling edge reference",
    code: "ir/dangling-ref",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges[0].to = "ghost";
      return ir;
    },
  },
  {
    name: "self edge",
    code: "ir/self-edge",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges[0].to = "web";
      return ir;
    },
  },
  {
    name: "duplicate edge",
    code: "ir/duplicate-edge",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges.push({ ...ir.edges[0] });
      return ir;
    },
  },
  {
    name: "empty group",
    code: "ir/group-empty",
    make: () => {
      const ir = withGroups();
      ir.groups[0].nodes = [];
      return ir;
    },
  },
  {
    name: "group node not in nodes",
    code: "ir/group-subset",
    make: () => {
      const ir = withGroups();
      ir.groups[0].nodes = ["ghost"];
      return ir;
    },
  },
  {
    name: "node in two groups",
    code: "ir/group-duplicate-node",
    make: () => {
      const ir = withGroups();
      ir.groups.push({ id: "core", label: "Core", kind: "boundary", nodes: ["web"] });
      return ir;
    },
  },
  {
    name: "node listed twice in one group",
    code: "ir/group-duplicate-node",
    make: () => {
      const ir = withGroups();
      ir.groups[0].nodes = ["web", "web"];
      return ir;
    },
  },
  {
    name: "bad group id format",
    code: "ir/group-id-format",
    make: () => {
      const ir = withGroups();
      ir.groups[0].id = "Edge_Zone";
      return ir;
    },
  },
  {
    name: "node group not declared",
    code: "ir/unknown-group",
    make: () => {
      const ir = withGroups();
      ir.nodes[0].group = "ghost";
      return ir;
    },
  },
  {
    name: "empty node label",
    code: "ir/label-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].label = "  ";
      return ir;
    },
  },
  {
    name: "81 character node label",
    code: "ir/label-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].label = "x".repeat(81);
      return ir;
    },
  },
  {
    name: "81 character group label",
    code: "ir/label-length",
    make: () => {
      const ir = withGroups();
      ir.groups[0].label = "x".repeat(81);
      return ir;
    },
  },
  {
    name: "141 character note",
    code: "ir/note-length",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.notes = ["x".repeat(141)];
      return ir;
    },
  },
  {
    name: "five notes",
    code: "ir/notes-count",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.notes = ["a", "b", "c", "d", "e"];
      return ir;
    },
  },
];

const WARNING_CASES = [
  {
    name: "long node label",
    code: "ir/node-label-long",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].label = "x".repeat(LIMITS.nodeLabelSoft + 1);
      return ir;
    },
  },
  {
    name: "long sublabel",
    code: "ir/sublabel-long",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.nodes[0].sublabel = "x".repeat(LIMITS.sublabelSoft + 1);
      return ir;
    },
  },
  {
    name: "long edge label",
    code: "ir/edge-label-long",
    make: () => {
      const ir = clone(minimalArchitecture());
      ir.edges[0].label = "x".repeat(LIMITS.edgeLabelSoft + 1);
      return ir;
    },
  },
  {
    name: "direction ignored for sequence",
    code: "ir/direction-ignored",
    make: () => {
      const ir = clone(minimalSequence());
      ir.direction = "LR";
      return ir;
    },
  },
  {
    name: "node.group mismatch with group.nodes",
    code: "ir/group-mismatch",
    make: () => {
      const ir = withGroups();
      ir.groups[0].nodes = ["db"];
      return ir; // web declares group "edge" but edge.nodes lists only db
    },
  },
];

test("valid minimal IRs pass for all ten diagram types", () => {
  assert.deepEqual([...DIAGRAM_TYPES].sort(), ["architecture", "class", "dataflow", "erd", "lifecycle", "sequence", "timeline", "tree", "waterfall", "workflow"]);
  for (const type of DIAGRAM_TYPES) {
    const ir = validIrFor(type);
    const result = validate(ir);
    assert.equal(result.ok, true, `${type}: expected ok, got ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
    assert.ok(Array.isArray(result.warnings));
  }
});

test("rich sequence fixture (subtitle, direction, fragment group, notes) passes", () => {
  const result = validate(richIr());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  // direction is declared (and ignored) for a sequence: warning only, no error.
  assert.ok(result.warnings.every((warning) => warning.code === "ir/direction-ignored"), JSON.stringify(result.warnings));
});

test("edges may be omitted (0..80 is the rule)", () => {
  const ir = clone(minimalArchitecture());
  delete ir.edges;
  const result = validate(ir);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("contract examples in examples/ validate clean when present", (t) => {
  const files = exampleFiles();
  if (files.length === 0) {
    t.skip("examples/ is empty — lead is writing fixtures in parallel");
    return;
  }
  for (const file of files) {
    const ir = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = validate(ir);
    assert.equal(result.ok, true, `${path.basename(file)}: ${JSON.stringify(result.errors, null, 2)}`);
    assert.equal(result.warnings.length, 0, `${path.basename(file)} should have no warnings: ${JSON.stringify(result.warnings)}`);
  }
});

test("boundary values accept the max and reject max + 1", () => {
  const fortyNodes = clone(minimalArchitecture());
  fortyNodes.nodes = makeNodes(LIMITS.nodesMax);
  fortyNodes.edges = [];
  assert.equal(validate(fortyNodes).ok, true, "40 nodes should pass");

  const fortyOneNodes = clone(fortyNodes);
  fortyOneNodes.nodes = makeNodes(LIMITS.nodesMax + 1);
  assert.equal(validate(fortyOneNodes).ok, false, "41 nodes should fail");

  const eightyEdges = clone(minimalArchitecture());
  eightyEdges.edges = Array.from({ length: LIMITS.edgesMax }, (_, index) => ({ from: "web", to: "db", label: `call-${index}`, kind: "main" }));
  assert.equal(validate(eightyEdges).ok, true, "80 edges should pass");

  const eightyOneEdges = clone(eightyEdges);
  eightyOneEdges.edges.push({ from: "db", to: "web", label: "extra", kind: "main" });
  assert.equal(validate(eightyOneEdges).ok, false, "81 edges should fail");

  const title80 = clone(minimalArchitecture());
  title80.title = "😀".repeat(LIMITS.titleMax);
  assert.equal(validate(title80).ok, true, "80 character (unicode) title should pass");

  const title81 = clone(minimalArchitecture());
  title81.title = "x".repeat(LIMITS.titleMax + 1);
  assert.equal(validate(title81).ok, false, "81 character title should fail");

  const sub120 = clone(minimalArchitecture());
  sub120.subtitle = "s".repeat(LIMITS.subtitleMax);
  assert.equal(validate(sub120).ok, true, "120 character subtitle should pass");

  const id32 = clone(minimalArchitecture());
  id32.nodes[0].id = `a${"b".repeat(31)}`;
  id32.edges[0].from = id32.nodes[0].id;
  assert.equal(validate(id32).ok, true, "32 character id should pass");

  const notes4 = clone(minimalArchitecture());
  notes4.notes = ["a", "b", "c", "d"];
  assert.equal(validate(notes4).ok, true, "4 notes should pass");

  const note140 = clone(minimalArchitecture());
  note140.notes = ["x".repeat(LIMITS.noteMax)];
  assert.equal(validate(note140).ok, true, "140 character note should pass");

  const note141 = clone(minimalArchitecture());
  note141.notes = ["x".repeat(LIMITS.noteMax + 1)];
  assert.equal(validate(note141).ok, false, "141 character note should fail");

  const label80 = clone(minimalArchitecture());
  label80.nodes[0].label = "x".repeat(LIMITS.nodeLabelMax);
  assert.equal(validate(label80).ok, true, "80 character node label should pass");

  const label81 = clone(minimalArchitecture());
  label81.nodes[0].label = "x".repeat(LIMITS.nodeLabelMax + 1);
  assert.equal(validate(label81).ok, false, "81 character node label should fail");
});

test("error matrix: every error code is triggered by a broken fixture, with path + hint", () => {
  const covered = new Set();
  for (const testCase of ERROR_CASES) {
    const result = validate(testCase.make());
    assert.equal(result.ok, false, `${testCase.name}: expected ok=false`);
    const match = result.errors.find((error) => error.code === testCase.code);
    assert.ok(match, `${testCase.name}: expected code ${testCase.code}, got ${result.errors.map((error) => error.code).join(", ")}`);
    assert.equal(typeof match.path, "string", `${testCase.name}: path must be a string`);
    assert.equal(typeof match.hint, "string", `${testCase.name}: hint must be a string`);
    assert.ok(match.hint.length >= 15, `${testCase.name}: hint is not actionable enough: "${match.hint}"`);
    assert.ok(match.message.length > 0, `${testCase.name}: message is empty`);
    covered.add(testCase.code);
  }
  // The matrix must cover the codes the contract's error shape advertises.
  for (const requiredCode of [
    "ir/unknown-key",
    "ir/required",
    "ir/type",
    "ir/title-length",
    "ir/nodes-count",
    "ir/node-id-format",
    "ir/duplicate-id",
    "ir/unknown-kind",
    "ir/dangling-ref",
    "ir/self-edge",
    "ir/duplicate-edge",
    "ir/group-subset",
    "ir/group-duplicate-node",
    "ir/label-length",
    "ir/edges-count",
    "ir/note-length",
    "ir/notes-count",
  ]) {
    assert.ok(covered.has(requiredCode), `error code ${requiredCode} has no fixture in the matrix`);
  }
});

test("warning matrix: soft issues warn but do not fail validation", () => {
  for (const testCase of WARNING_CASES) {
    const result = validate(testCase.make());
    assert.equal(result.ok, true, `${testCase.name}: warnings must not reject the IR (${JSON.stringify(result.errors)})`);
    const match = result.warnings.find((warning) => warning.code === testCase.code);
    assert.ok(match, `${testCase.name}: expected warning ${testCase.code}, got ${result.warnings.map((warning) => warning.code).join(", ")}`);
    assert.equal(typeof match.path, "string");
  }
});

test("result shape matches the contract exactly", () => {
  const broken = {
    title: 5,
    type: "nope",
    bogus: true,
    nodes: [
      { id: "Web", label: "x".repeat(41), kind: "server", extra: 1 },
      { id: "Web", label: 7 },
    ],
    edges: [{ from: "ghost", to: "ghost", label: "x".repeat(40) }],
    notes: ["x".repeat(141)],
  };
  const result = validate(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 3);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ["code", "hint", "message", "path"]);
    assert.equal(typeof error.code, "string");
    assert.equal(typeof error.message, "string");
    assert.equal(typeof error.path, "string");
    assert.equal(typeof error.hint, "string");
    assert.ok(error.code.startsWith("ir/"));
  }
  for (const warning of result.warnings) {
    assert.deepEqual(Object.keys(warning).sort(), ["code", "message", "path"]);
    assert.equal(typeof warning.code, "string");
    assert.equal(typeof warning.message, "string");
    assert.equal(typeof warning.path, "string");
    assert.ok(warning.code.startsWith("ir/"));
  }
});

test("validator never throws on hostile input", () => {
  for (const hostile of [null, undefined, 42, "diagram", [], [{ id: "x" }], true, { title: {} }, { nodes: [null] }]) {
    const result = validate(hostile);
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
    if (!result.ok) assert.ok(result.errors.length > 0);
  }
});

test("validator does not mutate the input IR", () => {
  const ir = deepFreeze(clone(richIr()));
  const before = JSON.stringify(ir);
  const result = validate(ir);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(JSON.stringify(ir), before);
});

test("validator output is deterministic", () => {
  const ir = clone(minimalArchitecture());
  ir.title = "x".repeat(81);
  ir.nodes[0].kind = "server";
  const first = JSON.stringify(validate(ir));
  const second = JSON.stringify(validate(clone(ir)));
  assert.equal(first, second);
});

test("unknown-key hints suggest the likely typo", () => {
  const ir = clone(minimalArchitecture());
  ir.titel = ir.title;
  delete ir.title;
  const result = validate(ir);
  const unknown = result.errors.find((error) => error.code === "ir/unknown-key");
  assert.ok(unknown);
  assert.match(unknown.hint, /rename it to "title"/);
});

test("ID pattern is exactly the contract regex", () => {
  const idRegex = new RegExp(ID_PATTERN);
  for (const good of ["a", "web", "web-", "api-gateway", `a${"b".repeat(31)}`, "n0"]) {
    assert.ok(idRegex.test(good), `${good} should be a valid id`);
  }
  for (const bad of ["", "Web", "1web", "web_api", `a${"b".repeat(32)}`, "-web", "web.app"]) {
    assert.equal(idRegex.test(bad), false, `${JSON.stringify(bad)} should be an invalid id`);
  }
});

test("enum constants match the contract", () => {
  assert.deepEqual([...NODE_KINDS], ["service", "datastore", "actor", "external", "queue", "compute", "security", "state", "note"]);
  assert.deepEqual([...EDGE_KINDS], ["main", "return", "async", "security", "message", "data"]);
  assert.deepEqual([...GROUP_KINDS], ["zone", "boundary", "fragment"]);
  assert.deepEqual([...DIRECTIONS], ["TB", "LR"]);
  assert.equal(LIMITS.nodesMax, 40);
  assert.equal(LIMITS.edgesMax, 80);
  assert.equal(LIMITS.titleMax, 80);
  assert.equal(LIMITS.subtitleMax, 120);
  assert.equal(LIMITS.notesMax, 4);
  assert.equal(LIMITS.noteMax, 140);
});
