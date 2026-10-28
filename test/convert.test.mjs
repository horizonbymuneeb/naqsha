// Mermaid ingest suite (owner: convert). Every fixture under test/mermaid/ must
// convert to IR that the real validator accepts with no fix pass, plus targeted
// checks for dialect coverage, auto type selection, warnings and error lines.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { convertMermaid } from "../src/convert/mermaid.mjs";
import { validate, DIAGRAM_TYPES, DIRECTIONS, ID_PATTERN } from "../src/validate/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(ROOT, "test", "mermaid");
const FIXTURE_NAMES = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".mmd"))
  .sort();
const ID_RE = new RegExp(ID_PATTERN);
const ROOT_KEYS = ["title", "subtitle", "type", "direction", "locale", "nodes", "edges", "groups", "notes", "walkthrough"];

const readFixture = (name) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const convert = (name, options) => convertMermaid(readFixture(name), options);
const chars = (text) => Array.from(text).length;

function edgeOf(ir, from, to, label) {
  return ir.edges.find((edge) => edge.from === from && edge.to === to && (label === undefined || edge.label === label));
}

function warningCodes(result) {
  return result.warnings.map((warning) => warning.code);
}

function assertCleanWarnings(result) {
  for (const warning of result.warnings) {
    assert.equal(typeof warning.code, "string");
    assert.equal(typeof warning.message, "string");
    assert.ok(Number.isInteger(warning.line) && warning.line >= 1, `warning line must be 1-based, got ${warning.line}`);
  }
}

const EXPECTED_AUTO_TYPES = {
  "decision.mmd": "workflow",
  "edge-styles.mmd": "workflow",
  "flowchart-lr.mmd": "workflow",
  "flowchart-td.mmd": "workflow",
  "messy.mmd": "workflow",
  "sequence-alt.mmd": "sequence",
  "sequence-loop.mmd": "sequence",
  "store-shapes.mmd": "workflow",
  "subgraph.mmd": "architecture",
};

test("test/mermaid ships at least 8 Mermaid fixtures", () => {
  assert.ok(FIXTURE_NAMES.length >= 8, `expected >= 8 fixtures, found ${FIXTURE_NAMES.length}`);
  for (const name of FIXTURE_NAMES) assert.ok(name.endsWith(".mmd"));
});

test("every Mermaid fixture converts to IR that validate() accepts unmodified", () => {
  for (const name of FIXTURE_NAMES) {
    const result = convert(name);
    assert.equal(result.errors.length, 0, `${name}: unexpected errors ${JSON.stringify(result.errors)}`);
    assert.equal(result.ok, true, `${name}: ok should be true`);
    assert.ok(result.ir && typeof result.ir === "object", `${name}: ir missing`);
    assert.ok(Array.isArray(result.warnings));

    const ir = result.ir;
    assert.ok(DIAGRAM_TYPES.includes(ir.type), `${name}: bad type ${ir.type}`);
    assert.equal(typeof ir.title, "string");
    assert.ok(chars(ir.title) >= 1 && chars(ir.title) <= 80, `${name}: title length ${chars(ir.title)}`);
    for (const key of Object.keys(ir)) assert.ok(ROOT_KEYS.includes(key), `${name}: IR has unknown root key "${key}"`);

    assert.ok(ir.nodes.length >= 1 && ir.nodes.length <= 40, `${name}: node count ${ir.nodes.length}`);
    assert.ok(Array.isArray(ir.edges) && ir.edges.length <= 80, `${name}: edge count ${ir.edges.length}`);

    const ids = new Set();
    for (const node of ir.nodes) {
      assert.match(node.id, ID_RE, `${name}: node id "${node.id}" is not IR-safe`);
      assert.ok(!ids.has(node.id), `${name}: duplicate node id "${node.id}"`);
      ids.add(node.id);
      assert.equal(typeof node.label, "string");
      assert.ok(chars(node.label) >= 1 && chars(node.label) <= 80, `${name}: node label too long`);
      assert.equal(typeof node.kind, "string");
    }
    for (const edge of ir.edges) {
      assert.ok(ids.has(edge.from), `${name}: edge from unknown node "${edge.from}"`);
      assert.ok(ids.has(edge.to), `${name}: edge to unknown node "${edge.to}"`);
      assert.notEqual(edge.from, edge.to, `${name}: self edge allowed through`);
    }
    if (ir.type === "sequence") assert.equal(ir.direction, undefined, `${name}: sequence must not carry direction`);
    else assert.ok(DIRECTIONS.includes(ir.direction), `${name}: bad direction ${ir.direction}`);

    if (ir.groups) {
      const seen = new Set();
      for (const group of ir.groups) {
        assert.match(group.id, ID_RE, `${name}: bad group id "${group.id}"`);
        assert.ok(group.nodes.length >= 1);
        for (const id of group.nodes) {
          assert.ok(ids.has(id), `${name}: group references unknown node "${id}"`);
          assert.ok(!seen.has(id), `${name}: node "${id}" is in two groups`);
          seen.add(id);
        }
      }
      for (const node of ir.nodes) {
        if (node.group) assert.ok(ir.groups.some((group) => group.id === node.group), `${name}: node group "${node.group}" not declared`);
      }
    }

    const verdict = validate(ir);
    assert.equal(verdict.ok, true, `${name}: validate() rejected converted IR: ${JSON.stringify(verdict.errors)}`);
  }
});

test("auto type selection: sequence / architecture / workflow", () => {
  for (const name of FIXTURE_NAMES) {
    assert.equal(convert(name).ir.type, EXPECTED_AUTO_TYPES[name], `${name}: wrong auto type`);
  }
  // One subgraph is still a workflow; two push it to architecture.
  const one = convertMermaid("flowchart TD\n subgraph one [One]\n  A --> B\n end\n");
  assert.equal(one.ir.type, "workflow");
  const two = convertMermaid("flowchart TD\n subgraph one [One]\n  A --> B\n end\n subgraph two [Two]\n  C --> D\n end\n B --> C\n");
  assert.equal(two.ir.type, "architecture");
  assert.equal(validate(two.ir).ok, true);
});

test("direction: TD/TB stay TB, LR stays LR, BT/RL are mapped with a warning", () => {
  assert.equal(convert("flowchart-td.mmd").ir.direction, "TB");
  assert.equal(convert("flowchart-lr.mmd").ir.direction, "LR");

  const bt = convertMermaid("flowchart BT\n A --> B");
  assert.equal(bt.ir.direction, "TB");
  assert.ok(warningCodes(bt).includes("convert/direction-mapped"));
  assert.equal(validate(bt.ir).ok, true);

  const rl = convertMermaid("graph RL\n A --> B");
  assert.equal(rl.ir.direction, "LR");
  assert.ok(warningCodes(rl).includes("convert/direction-mapped"));

  const none = convertMermaid("flowchart\n A --> B");
  assert.equal(none.ir.direction, "TB");
  assert.equal(none.warnings.length, 0);
});

test("flowchart node shapes map to IR kinds", () => {
  const td = convert("flowchart-td.mmd").ir;
  assert.equal(td.nodes.find((node) => node.id === "a").kind, "actor"); // Browser
  assert.equal(td.nodes.find((node) => node.id === "b").kind, "security"); // API Gateway
  assert.equal(td.nodes.find((node) => node.id === "c").kind, "state"); // {Decision} diamond
  assert.equal(td.nodes.find((node) => node.id === "f").kind, "datastore"); // [(Store)] cylinder
  assert.equal(td.nodes.find((node) => node.id === "g").kind, "state"); // ((Pill)) circle

  const stores = convert("store-shapes.mmd").ir;
  for (const id of ["cache", "store", "db"]) {
    assert.equal(stores.nodes.find((node) => node.id === id).kind, "datastore", `${id} should be a datastore`);
  }
  assert.equal(stores.nodes.find((node) => node.id === "api").kind, "state"); // circle pill

  const lr = convert("flowchart-lr.mmd").ir;
  assert.equal(lr.nodes.find((node) => node.id === "start").kind, "state"); // ([Start]) stadium
  assert.equal(lr.nodes.find((node) => node.id === "schema").kind, "state"); // ((Schema)) circle
});

test("edge spellings map to the documented edge kinds and keep their labels", () => {
  const ir = convert("edge-styles.mmd").ir;

  const get = edgeOf(ir, "a", "b");
  assert.equal(get.kind, "main");
  assert.equal(get.label, "GET /cart");

  assert.equal(edgeOf(ir, "b", "c", "query").kind, "data"); // label keyword promotes to data
  assert.equal(edgeOf(ir, "c", "d", "miss").kind, "async"); // -.-> stays async
  assert.equal(edgeOf(ir, "d", "e").kind, "main"); // ==>
  assert.equal(edgeOf(ir, "e", "f").kind, "message"); // ---
  assert.equal(edgeOf(ir, "f", "g").kind, "return"); // --x
  assert.equal(edgeOf(ir, "b", "h").kind, "message"); // ---

  const decision = convert("decision.mmd").ir;
  assert.equal(edgeOf(decision, "b", "c", "yes").kind, "main");
  assert.equal(edgeOf(decision, "b", "d", "no").kind, "main");
});

test("subgraph blocks become boundary groups and set node.group", () => {
  const result = convert("subgraph.mmd");
  const ir = result.ir;
  assert.equal(ir.type, "architecture");
  assert.ok(Array.isArray(ir.groups));
  assert.equal(ir.groups.length, 2);
  assert.deepEqual(ir.groups.map((group) => group.kind), ["boundary", "boundary"]);
  assert.deepEqual(ir.groups.map((group) => group.label), ["Edge Layer", "Application Core"]);
  assert.deepEqual(ir.groups[0].nodes.sort(), ["cdn", "gw"]);
  assert.deepEqual(ir.groups[1].nodes.sort(), ["api", "pricing"]);

  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("cdn").group, "edge");
  assert.equal(byId.get("gw").group, "edge");
  assert.equal(byId.get("api").group, "core");
  assert.equal(byId.get("browser").group, undefined);
  assert.equal(validate(ir).ok, true);
});

test("sequence diagram: participants, actors, message kinds, note and loop fragment", () => {
  const result = convert("sequence-loop.mmd");
  const ir = result.ir;

  assert.equal(ir.type, "sequence");
  assert.deepEqual(ir.nodes.map((node) => node.label), ["User", "Admin", "S", "D"]);
  assert.deepEqual(ir.nodes.map((node) => node.kind), ["actor", "actor", "service", "service"]);

  assert.equal(edgeOf(ir, "u", "s", "open dashboard").kind, "main");
  assert.equal(edgeOf(ir, "s", "u", "cached page").kind, "return"); // -->>
  assert.equal(edgeOf(ir, "d", "s", "rows").kind, "return");
  assert.equal(edgeOf(ir, "s", "d", "invalidate").kind, "return"); // --x
  assert.equal(edgeOf(ir, "s", "d", "fetch metrics").kind, "data"); // label keyword
  assert.equal(edgeOf(ir, "a", "s", "rotate token").kind, "security"); // label keyword

  assert.deepEqual(ir.notes, ["browser cache warm"]);
  assert.equal(ir.groups.length, 1);
  assert.equal(ir.groups[0].kind, "fragment");
  assert.match(ir.groups[0].label, /^loop/);
  assert.deepEqual(ir.groups[0].nodes.sort(), ["d", "s"]);
  assert.equal(validate(ir).ok, true);
});

test("sequence alt/else and opt become fragments; overlapping fragments warn instead of breaking IR", () => {
  const result = convert("sequence-alt.mmd");
  const ir = result.ir;

  assert.equal(ir.type, "sequence");
  assert.equal(ir.nodes.length, 3);
  assert.equal(ir.groups.length, 1);
  assert.equal(ir.groups[0].kind, "fragment");
  assert.match(ir.groups[0].label, /^alt/);
  assert.equal(edgeOf(ir, "g", "c", "401").kind, "return");
  assert.ok(warningCodes(result).includes("convert/fragment-overlap"), `warnings: ${warningCodes(result)}`);
  assert.equal(validate(ir).ok, true);
});

test("unsupported directives are warnings, never failures", () => {
  const result = convert("messy.mmd");
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  const codes = warningCodes(result);
  assert.ok(codes.includes("convert/unsupported"), `expected unsupported warning, got ${codes}`);
  assert.ok(codes.includes("convert/group-direction"));
  assertCleanWarnings(result);
  assert.equal(validate(result.ir).ok, true);
  // classDef/style/click junk must not leak into ids or labels.
  for (const node of result.ir.nodes) {
    assert.ok(!node.id.includes(":"), `junk leaked into id ${node.id}`);
    assert.ok(!/fill:|stroke:|href/.test(node.label), `junk leaked into label ${node.label}`);
  }
  assert.equal(result.ir.nodes.length, 5);
});

test("invalid or unsupported input returns errors with 1-based line numbers", () => {
  const cases = [
    { text: "", code: "convert/empty" },
    { text: "   \n \t \n", code: "convert/empty" },
    { text: "classDiagram\n  A --> B", code: "convert/unsupported-diagram" },
    { text: "flowchart TD\n subgraph x\n end\n", code: "convert/no-nodes" },
    { text: "hello there", code: "convert/unknown-diagram" },
    { text: null, code: "convert/input" },
  ];
  for (const { text, code } of cases) {
    const result = convertMermaid(text);
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(text)}`);
    assert.equal(result.ir, null);
    assert.ok(result.errors.length >= 1);
    assert.equal(result.errors[0].code, code);
    assert.ok(Number.isInteger(result.errors[0].line) && result.errors[0].line >= 1);
    assert.equal(typeof result.errors[0].message, "string");
    assert.ok(Array.isArray(result.warnings));
  }

  const badType = convertMermaid("flowchart TD\n A --> B", { type: "quux" });
  assert.equal(badType.ok, false);
  assert.equal(badType.errors[0].code, "convert/bad-type");
  assert.equal(badType.errors[0].line, 1);
});

test("type option is honoured and contradictions warn", () => {
  const forcedArch = convert("flowchart-td.mmd", { type: "architecture" });
  assert.equal(forcedArch.ir.type, "architecture");
  assert.equal(validate(forcedArch.ir).ok, true);

  const forcedSequence = convert("flowchart-td.mmd", { type: "sequence" });
  assert.equal(forcedSequence.ir.type, "sequence");
  assert.equal(forcedSequence.ir.direction, undefined);
  assert.equal(validate(forcedSequence.ir).ok, true);

  const forcedFlow = convert("sequence-loop.mmd", { type: "workflow" });
  assert.equal(forcedFlow.ir.type, "workflow");
  assert.ok(warningCodes(forcedFlow).includes("convert/type-mismatch"));
  for (const group of forcedFlow.ir.groups || []) assert.equal(group.kind, "boundary");
  assert.equal(validate(forcedFlow.ir).ok, true);
});

test("front matter maps title/subtitle and warns about unsupported keys", () => {
  const fixture = convert("flowchart-lr.mmd");
  assert.equal(fixture.ir.title, "Request Parsing");
  assert.equal(fixture.ir.subtitle, "sample front matter");

  const extra = convertMermaid("---\ntitle: Delivery\ntheme: forest\n---\nflowchart TD\n A --> B");
  assert.equal(extra.ir.title, "Delivery");
  assert.ok(extra.warnings.some((warning) => warning.message.includes("theme")));
  assert.equal(validate(extra.ir).ok, true);
});

test("quoted labels, HTML breaks, entities and escapes are cleaned", () => {
  const result = convertMermaid(
    [
      "flowchart TD",
      '  A["Web App | (edge)"] --> B["line<br/>two"]',
      "  B --> C[Tom &amp; Jerry]",
      '  C --> D["He said \\"hi\\""]',
    ].join("\n"),
  );
  assert.equal(validate(result.ir).ok, true);
  const labels = result.ir.nodes.map((node) => node.label);
  assert.deepEqual(labels, ["Web App | (edge)", "line, two", "Tom & Jerry", 'He said "hi"']);
});

test("chains, fan-out and multi-source statements expand into the expected edges", () => {
  const result = convertMermaid("flowchart LR\n A --> B --> C & D\n E & F --> G");
  assert.equal(result.ok, true);
  assert.equal(result.ir.edges.length, 5);
  assert.equal(result.ir.nodes.length, 7);
  const pairs = result.ir.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(pairs, ["a->b", "b->c", "b->d", "e->g", "f->g"]);
  assert.equal(validate(result.ir).ok, true);
});

test("duplicate and self edges are dropped with line-numbered warnings", () => {
  const result = convertMermaid("flowchart TD\n A --> B\n A --> B\n A --> A\n A --> B & C");
  assert.equal(result.ok, true);
  assert.equal(result.ir.edges.length, 2); // three a->b collapse to one, a->c survives
  const warningPairs = result.warnings.map((warning) => `${warning.code}@${warning.line}`);
  assert.ok(warningPairs.includes("convert/duplicate-edge@3"));
  assert.ok(warningPairs.includes("convert/self-edge@4"));
  assert.equal(validate(result.ir).ok, true);
});

test("over-long labels are truncated to the IR limit", () => {
  const result = convertMermaid(`flowchart TD\n A["${"x".repeat(120)}"] --> B`);
  assert.equal(result.ok, true);
  const label = result.ir.nodes[0].label;
  assert.ok(chars(label) <= 80, `label length ${chars(label)}`);
  assert.ok(warningCodes(result).includes("convert/label-truncated"));
  assert.ok(result.warnings.every((warning) => Number.isInteger(warning.line)));
  assert.equal(validate(result.ir).ok, true);
});

test("semicolon-separated single-line flowchart converts", () => {
  const result = convertMermaid("flowchart TD; A --> B; B --> C;");
  assert.equal(result.ok, true);
  assert.equal(result.ir.nodes.length, 3);
  assert.equal(result.ir.edges.length, 2);
  assert.equal(validate(result.ir).ok, true);
});

test("conversion is deterministic across runs", () => {
  for (const name of FIXTURE_NAMES) {
    const first = JSON.stringify(convert(name));
    const second = JSON.stringify(convert(name));
    assert.equal(first, second, `${name}: conversion is not deterministic`);
  }
  const inline = "flowchart TD\n A --> B & C\n B -.->|miss| D\n C ==> E";
  assert.equal(JSON.stringify(convertMermaid(inline)), JSON.stringify(convertMermaid(inline)));
});

test("result shape is stable for success and failure", () => {
  for (const text of ["flowchart TD\n A --> B", "nonsense", ""]) {
    const result = convertMermaid(text);
    assert.deepEqual(Object.keys(result).sort(), ["errors", "ir", "ok", "warnings"]);
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
  }
});
