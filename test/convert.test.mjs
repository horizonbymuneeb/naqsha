// Mermaid ingest suite (owner: convert). Every fixture under test/mermaid/ must
// convert to IR that the real validator accepts with no fix pass, plus targeted
// checks for dialect coverage, auto type selection, warnings and error lines.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { convertMermaid } from "../src/convert/mermaid.mjs";
import { toMermaid } from "../src/convert/to-mermaid.mjs";
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
    { text: "gantt\n  title A plan\n  section One\n  Task :a1, 2026-01-01, 30d", code: "convert/unsupported-diagram" },
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

/* ------------------------------------------------------------------------- */
/* v1.2 dialects: erDiagram and classDiagram                                 */
/* ------------------------------------------------------------------------- */

const ERD_SAMPLE = `---
title: Shop schema
subtitle: customers, orders and their lines
---
erDiagram
  direction LR
  CUSTOMER["Customer Table"] {
    uuid id PK
    text email UK
    uuid referrer_id FK "customer.id"
  }
  ORDER {
    uuid id PK
    uuid customer_id FK
    numeric(10,2) total
    timestamptz created_at
    text[] tags
  }
  LINE-ITEM {
    uuid order_id FK
    text sku
    char-varying note
  }
  CUSTOMER ||--o{ ORDER : "places"
  ORDER ||--|{ LINE-ITEM : "contains"
  CUSTOMER }o--o{ ORDER : "also views"
  ORDER ||--|| LINE-ITEM : "one to one"
`;

const CLASS_SAMPLE = `---
title: Engine Modules
subtitle: who calls whom inside the engine
---
classDiagram
  direction TB
  class Renderer {
    <<interface>>
    + render(ir): string
  }
  class Native["NativeRenderer"] {
    + render(ir): string
    - layout: LayoutPlan
  }
  <<abstract>> Base
  Renderer : + mode: string
  <<interface>> Validator
  Renderer <|.. Native
  Base <|-- Native
  Deliverer *-- Renderer
  Deliverer --> Gate : uses
  Gate ..> Renderer
`;

test("erDiagram: entities, aliases, attributes, keys and cardinality", () => {
  const result = convertMermaid(ERD_SAMPLE);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.errors.length, 0);
  const ir = result.ir;

  assert.equal(ir.type, "erd");
  assert.equal(ir.direction, "LR");
  assert.equal(ir.title, "Shop schema");
  assert.equal(ir.subtitle, "customers, orders and their lines");
  assert.deepEqual(ir.nodes.map((node) => node.id), ["customer", "order", "line-item"]);
  assert.deepEqual(ir.nodes.map((node) => node.label), ["Customer Table", "ORDER", "LINE-ITEM"]);

  assert.deepEqual(ir.nodes[0].attributes, [
    { name: "id", type: "uuid", key: "pk" },
    { name: "email", type: "text", key: "unique" },
    { name: "referrer_id", type: "uuid", key: "fk", ref: "customer.id" },
  ]);
  assert.deepEqual(ir.nodes[1].attributes.map((attr) => [attr.name, attr.type]), [
    ["id", "uuid"],
    ["customer_id", "uuid"],
    ["total", "numeric(10,2)"],
    ["created_at", "timestamptz"],
    ["tags", "text[]"],
  ]);
  assert.equal(ir.nodes[2].attributes[2].type, "char-varying");
  for (const node of ir.nodes) assert.equal(node.kind, undefined, "ERD nodes do not need a kind");

  assert.deepEqual(ir.edges.map((edge) => [edge.from, edge.to, edge.label || "", edge.cardinality]), [
    ["customer", "order", "places", "1:n"],
    ["order", "line-item", "contains", "1:n"],
    ["customer", "order", "also views", "n:m"],
    ["order", "line-item", "one to one", "1:1"],
  ]);
  assertCleanWarnings(result);
  assert.equal(validate(ir).ok, true, JSON.stringify(validate(ir).errors));
});

test("erDiagram: implicit entities, many-to-one swap, self-relations and limits", () => {
  const implicit = convertMermaid("erDiagram\n  A ||--o{ B : x\n  B { uuid id PK }");
  assert.equal(implicit.ok, true);
  assert.ok(implicit.warnings.some((warning) => warning.code === "convert/erd-entity"));
  assert.deepEqual(implicit.ir.nodes[0].attributes, [{ name: "id", type: "uuid" }]);
  assert.equal(validate(implicit.ir).ok, true);

  const swapped = convertMermaid("erDiagram\n  ORDER }o--|| CUSTOMER : belongs\n  ORDER { uuid id PK }\n  CUSTOMER { uuid id PK }");
  assert.deepEqual(swapped.ir.edges.map((edge) => [edge.from, edge.to, edge.cardinality]), [["customer", "order", "1:n"]]);
  assert.ok(swapped.warnings.some((warning) => warning.code === "convert/erd-direction"));
  assert.equal(validate(swapped.ir).ok, true);

  const self = convertMermaid("erDiagram\n  PERSON }o--o{ PERSON : manages\n  PERSON { uuid id PK }");
  assert.equal(self.ok, true);
  assert.equal(self.ir.edges.length, 0);
  assert.ok(self.warnings.some((warning) => warning.code === "convert/self-edge"));

  const rows = Array.from({ length: 13 }, (_, index) => `    text col_${index}`).join("\n");
  const limited = convertMermaid(`erDiagram\n  A {\n${rows}\n  }\n  A ||--|| B : x`);
  assert.equal(limited.ir.nodes[0].attributes.length, 12);
  assert.ok(limited.warnings.some((warning) => warning.code === "convert/erd-attributes"));
  assert.equal(validate(limited.ir).ok, true);

  const merged = convertMermaid("erDiagram\n  A { uuid id PK }\n  A { text name }");
  assert.equal(merged.ir.nodes.length, 1);
  assert.equal(merged.ir.nodes[0].attributes.length, 2);
  assert.ok(merged.warnings.some((warning) => warning.code === "convert/unsupported"));
  assert.equal(validate(merged.ir).ok, true);
});

test("classDiagram: classes, members, stereotypes and relation direction", () => {
  const result = convertMermaid(CLASS_SAMPLE);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const ir = result.ir;

  assert.equal(ir.type, "class");
  assert.equal(ir.direction, "TB");
  assert.equal(ir.title, "Engine Modules");
  assert.deepEqual(ir.nodes.map((node) => node.id), ["renderer", "native", "base", "validator", "deliverer", "gate"]);
  assert.deepEqual(ir.nodes.map((node) => node.label), ["Renderer", "NativeRenderer", "Base", "Validator", "Deliverer", "Gate"]);
  assert.deepEqual(ir.nodes.map((node) => node.stereotype || null), ["interface", null, "abstract", "interface", null, null]);
  assert.deepEqual(ir.nodes[0].members, ["+ render(ir): string", "+ mode: string"]);
  assert.deepEqual(ir.nodes[1].members, ["+ render(ir): string", "- layout: LayoutPlan"]);
  assert.equal(ir.nodes[2].members, undefined);

  assert.deepEqual(ir.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.label || ""]), [
    ["native", "renderer", "implements", ""],
    ["native", "base", "extends", ""],
    ["deliverer", "renderer", "composition", ""],
    ["deliverer", "gate", "association", "uses"],
    ["gate", "renderer", "dependency", ""],
  ]);
  assertCleanWarnings(result);
  assert.equal(validate(ir).ok, true, JSON.stringify(validate(ir).errors));
});

test("classDiagram: every relation operator maps to the documented kind and direction", () => {
  const table = [
    ["<|--", "extends", "b", "a"],
    ["<|..", "implements", "b", "a"],
    ["--|>", "extends", "a", "b"],
    ["..|>", "implements", "a", "b"],
    ["*--", "composition", "a", "b"],
    ["--*", "composition", "b", "a"],
    ["o--", "association", "a", "b"],
    ["--o", "association", "b", "a"],
    ["-->", "association", "a", "b"],
    ["<--", "association", "b", "a"],
    ["..>", "dependency", "a", "b"],
    ["<..", "dependency", "b", "a"],
    ["--", "association", "a", "b"],
    ["..", "dependency", "a", "b"],
  ];
  for (const [operator, kind, from, to] of table) {
    const result = convertMermaid(`classDiagram\n  A ${operator} B : rel`);
    assert.equal(result.ok, true, agentFor(result));
    assert.equal(validate(result.ir).ok, true, `${operator}: ${JSON.stringify(validate(result.ir).errors)}`);
    assert.deepEqual(result.ir.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.label]), [[from, to, kind, "rel"]], `${operator} should mean ${kind}`);
  }

  const multiplicity = convertMermaid('classDiagram\n  A "1" --> "*" B : calls');
  assert.equal(multiplicity.ok, true);
  assert.deepEqual(multiplicity.ir.edges.map((edge) => [edge.from, edge.to, edge.kind]), [["a", "b", "association"]]);
  assert.ok(multiplicity.warnings.some((warning) => warning.code === "convert/class-multiplicity"));

  const aggregation = convertMermaid("classDiagram\n  A o-- B : has");
  assert.equal(aggregation.ir.edges[0].kind, "association");
  assert.ok(aggregation.warnings.some((warning) => warning.code === "convert/class-aggregation"));
});

function agentFor(result) {
  return result.ok ? "ok" : JSON.stringify(result.errors);
}

test("classDiagram: members, generics, junk and limits", () => {
  const generic = convertMermaid("classDiagram\n  class List~T~ {\n    + add(T item) void\n  }");
  assert.equal(generic.ok, true);
  assert.equal(generic.ir.nodes[0].id, "list");
  assert.equal(generic.ir.nodes[0].label, "List<T>");
  assert.equal(validate(generic.ir).ok, true);

  const members = Array.from({ length: 14 }, (_, index) => `    + method${index}(): void`).join("\n");
  const limited = convertMermaid(`classDiagram\n  class Big {\n${members}\n  }`);
  assert.equal(limited.ir.nodes[0].members.length, 12);
  assert.ok(limited.warnings.some((warning) => warning.code === "convert/class-members"));

  const long = convertMermaid(`classDiagram\n  class Long {\n    + ${"veryLongMethodName".repeat(5)}(): void\n  }`);
  assert.ok(chars(long.ir.nodes[0].members[0]) <= 60);
  assert.ok(long.warnings.some((warning) => warning.code === "convert/class-members"));

  const junk = convertMermaid("classDiagram\n  class A {\n    + x: int\n  }\n  note for A \"hello\"\n  style A fill:#f00\n  classDef bad fill:#f00\n  A <|-- B");
  assert.equal(junk.ok, true);
  assert.equal(validate(junk.ir).ok, true);
  const codes = warningCodes(junk);
  assert.ok(codes.includes("convert/unsupported"));

  const self = convertMermaid("classDiagram\n  class A\n  A <|-- A");
  assert.equal(self.ok, true);
  assert.equal(self.ir.edges.length, 0);
  assert.ok(self.warnings.some((warning) => warning.code === "convert/self-edge"));
});

test("v1.2 dialects: malformed input warns and never throws", () => {
  const inputs = [
    "erDiagram",
    "erDiagram\n  }",
    "erDiagram\n  A ----> B : x",
    "erDiagram\n  A {\n    uuid id PK",
    "erDiagram\n  @@@ ###",
    "erDiagram\n  A { }",
    "erDiagram\n  A ||--o{ B : x\n  A { uuid id PK }",
    "classDiagram",
    "classDiagram\n  class { }",
    "classDiagram\n  <<interface>>",
    "classDiagram\n  ####\n  A <|-- B",
    "classDiagram\n  class A {\n    + unbalanced((",
  ];
  for (const text of inputs) {
    let result;
    assert.doesNotThrow(() => {
      result = convertMermaid(text);
    }, `threw on ${JSON.stringify(text)}`);
    assert.deepEqual(Object.keys(result).sort(), ["errors", "ir", "ok", "warnings"]);
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
    for (const entry of [...result.errors, ...result.warnings]) {
      assert.ok(Number.isInteger(entry.line) && entry.line >= 1, `line must be 1-based: ${JSON.stringify(entry)}`);
    }
    if (result.ok) assert.equal(validate(result.ir).ok, true, `${JSON.stringify(text)} produced invalid IR: ${JSON.stringify(validate(result.ir).errors)}`);
  }
});

test("type override: v1.2 dialects keep their native type with a warning", () => {
  const erdForced = convertMermaid("erDiagram\n  A { uuid id PK }", { type: "workflow" });
  assert.equal(erdForced.ir.type, "erd");
  assert.ok(warningCodes(erdForced).includes("convert/type-mismatch"));

  const classForced = convertMermaid("classDiagram\n  class A", { type: "architecture" });
  assert.equal(classForced.ir.type, "class");
  assert.ok(warningCodes(classForced).includes("convert/type-mismatch"));

  const flowToErd = convertMermaid("flowchart TD\n  A --> B", { type: "erd" });
  assert.equal(flowToErd.ok, false);
  assert.equal(flowToErd.errors[0].code, "convert/type-mismatch");

  const seqToClass = convertMermaid("sequenceDiagram\n  A->>B: hi", { type: "class" });
  assert.equal(seqToClass.ok, false);
  assert.equal(seqToClass.errors[0].code, "convert/type-mismatch");
});

test("v1.2 conversion is deterministic", () => {
  for (const text of [ERD_SAMPLE, CLASS_SAMPLE]) {
    assert.equal(JSON.stringify(convertMermaid(text)), JSON.stringify(convertMermaid(text)));
  }
});

/* ------------------------------------------------------------------------- */
/* Round trip: examples -> native Mermaid -> IR                              */
/* ------------------------------------------------------------------------- */

const ROUND_TRIP_CASES = [
  { file: "ir-schema.erd.json", dialect: "erDiagram", type: "erd" },
  { file: "engine-modules.class.json", dialect: "classDiagram", type: "class" },
];

test("round-trips the ERD and class examples through native Mermaid", () => {
  for (const { file, dialect, type } of ROUND_TRIP_CASES) {
    const ir = JSON.parse(fs.readFileSync(path.join(ROOT, "examples", file), "utf8"));
    assert.equal(ir.type, type);
    const exported = toMermaid(ir);
    assert.equal(exported.ok, true, `${file}: export failed ${JSON.stringify(exported.warnings)}`);
    assert.match(exported.mermaid, new RegExp(`^${dialect}$`, "m"), `${file}: expected a native ${dialect} export`);
    assert.doesNotMatch(exported.mermaid, /^flowchart /m, `${file}: export fell back to a flowchart`);

    const back = convertMermaid(exported.mermaid);
    assert.equal(back.ok, true, `${file}: ingest rejected the export: ${JSON.stringify(back.errors)}`);
    const backIr = back.ir;
    assert.equal(backIr.type, type, `${file}: type changed`);
    assert.equal(validate(backIr).ok, true, `${file}: round-tripped IR is invalid: ${JSON.stringify(validate(backIr).errors)}`);

    assert.equal(backIr.title, ir.title, `${file}: title should survive the front matter`);
    if (ir.subtitle) assert.equal(backIr.subtitle, ir.subtitle, `${file}: subtitle should survive the front matter`);
    if (ir.direction) assert.equal(backIr.direction, ir.direction, `${file}: direction should survive`);
    assert.deepEqual(backIr.nodes.map((node) => node.id), ir.nodes.map((node) => node.id), `${file}: node ids and order changed`);
    assert.deepEqual(backIr.nodes.map((node) => node.label), ir.nodes.map((node) => node.label), `${file}: node labels changed`);
    assert.equal((backIr.edges || []).length, (ir.edges || []).length, `${file}: edge count changed`);

    if (type === "erd") {
      const attrs = (source) => source.nodes.map((node) => node.attributes.map((attr) => [attr.name, attr.type, attr.key ?? null]));
      assert.deepEqual(attrs(backIr), attrs(ir), `${file}: attributes (name/type/key) changed`);
      assert.deepEqual(
        backIr.edges.map((edge) => [edge.from, edge.to, edge.label || "", edge.cardinality]),
        ir.edges.map((edge) => [edge.from, edge.to, edge.label || "", edge.cardinality]),
        `${file}: relationships or cardinalities changed`,
      );
    } else {
      assert.deepEqual(backIr.nodes.map((node) => node.members || []), ir.nodes.map((node) => node.members || []), `${file}: members changed`);
      assert.deepEqual(backIr.nodes.map((node) => node.stereotype || null), ir.nodes.map((node) => node.stereotype || null), `${file}: stereotypes changed`);
      assert.deepEqual(
        backIr.edges.map((edge) => [edge.from, edge.to, edge.kind ?? "association", edge.label || ""]),
        ir.edges.map((edge) => [edge.from, edge.to, edge.kind ?? "association", edge.label || ""]),
        `${file}: relation kinds, labels or order changed`,
      );
    }
    assert.equal(JSON.stringify(convertMermaid(exported.mermaid)), JSON.stringify(back), `${file}: ingest is not deterministic`);
  }
});
