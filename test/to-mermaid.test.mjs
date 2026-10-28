// Mermaid export suite (owner: convert). `toMermaid(ir)` must produce valid,
// deterministic Mermaid for every Naqsha diagram type:
//
//   architecture / workflow -> flowchart      (round-trips through convertMermaid)
//   sequence                -> sequenceDiagram
//   erd                     -> erDiagram      (native dialect, attributes + cardinality)
//   class                   -> classDiagram   (native dialect, members + relation markers)
//   tree / timeline / waterfall / dataflow / lifecycle -> flowchart fallback with a
//                                                       to-mermaid/type-simplified warning
//
// The hard round-trip test runs over every examples/*.json IR and every
// test/mermaid/*.mmd flowchart/sequence fixture (converted to IR first), because
// a README export is only useful if it keeps the diagram content. The two
// relational dialects are asserted structurally here; their ingest round trip is
// owned by the Mermaid-ingest suite.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toMermaid } from "../src/convert/to-mermaid.mjs";
import { convertMermaid } from "../src/convert/mermaid.mjs";
import { validate, DIAGRAM_TYPES } from "../src/validate/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const FIXTURES_DIR = path.join(ROOT, "test", "mermaid");

const IR_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => path.join(EXAMPLES_DIR, name));
const IR_NAMES = IR_FILES.map((file) => path.relative(ROOT, file));
const FIXTURE_NAMES = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".mmd"))
  .sort();
const EXAMPLES = IR_FILES.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const exampleIr = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), "utf8"));

const NATIVE_FLOW_TYPES = new Set(["architecture", "workflow"]);
const SIMPLIFIED_TYPES = new Set(["tree", "timeline", "waterfall", "dataflow", "lifecycle"]);
const FLOW_EXAMPLES = EXAMPLES.filter((ir) => NATIVE_FLOW_TYPES.has(ir.type));
const SIMPLIFIED_EXAMPLES = EXAMPLES.filter((ir) => SIMPLIFIED_TYPES.has(ir.type));
const ERD_EXAMPLES = EXAMPLES.filter((ir) => ir.type === "erd");
const CLASS_EXAMPLES = EXAMPLES.filter((ir) => ir.type === "class");
const SEQUENCE_EXAMPLES = EXAMPLES.filter((ir) => ir.type === "sequence");
const HEADER_RE = /^(flowchart (TD|LR)|sequenceDiagram|erDiagram|classDiagram)$/;

const ER_CARDINALITY = { "1:1": "||--||", "1:n": "||--o{", "n:m": "}o--o{" };
const CLASS_MARKER = { association: "-->", composition: "*--", dependency: "..>" };

const sortedLabels = (ir) => ir.nodes.map((node) => node.label).sort();
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const mermaidId = (id) => id.replace(/-/g, "_");

/** Round-trip helper: IR -> Mermaid -> IR. */
function roundTrip(ir) {
  const out = toMermaid(ir);
  assert.equal(out.ok, true, `toMermaid() failed for "${ir.title}": ${JSON.stringify(out.warnings)}`);
  assert.equal(typeof out.mermaid, "string");
  return { out, back: convertMermaid(out.mermaid) };
}

/** Shared shape checks for every generated .mmd. */
function assertMermaidShape(text, label) {
  assert.ok(text.length > 0, `${label}: empty output`);
  assert.ok(text.endsWith("\n"), `${label}: output must end with a trailing newline`);
  assert.ok(!text.endsWith("\n\n"), `${label}: exactly one trailing newline expected`);
  assert.ok(!text.includes("\r"), `${label}: output must not contain carriage returns`);
  for (const [index, line] of text.split("\n").entries()) {
    assert.equal(line, line.replace(/[ \t]+$/, ""), `${label}: trailing whitespace on line ${index + 1}: ${JSON.stringify(line)}`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line), `${label}: control character on line ${index + 1}`);
  }
  const first = text.split("\n").find((line) => line.trim() !== "" && line.trim() !== "---" && !/^(title|subtitle):/.test(line.trim()));
  assert.match(first, HEADER_RE, `${label}: first diagram line must be a Mermaid header, got ${JSON.stringify(first)}`);
}

const diagramLine = (text) =>
  text.split("\n").find((line) => line.trim() !== "" && line.trim() !== "---" && !/^(title|subtitle):/.test(line.trim()));

/** Deterministic for the same IR, and the input IR is never touched. */
function assertDeterministicAndPure(ir, label, options) {
  const before = JSON.stringify(ir);
  const first = toMermaid(ir, options);
  const second = toMermaid(JSON.parse(JSON.stringify(ir)), options);
  assert.deepEqual(second, first, `${label}: same IR must give byte-identical output and warnings`);
  assert.equal(JSON.stringify(ir), before, `${label}: input IR was mutated`);
  return first;
}

function assertWarning(warnings, code, label) {
  assert.ok(
    warnings.some((warning) => warning.code === code),
    `${label}: expected warning ${code}, got ${JSON.stringify(warnings.map((warning) => warning.code))}`,
  );
}

function assertWarningShape(warnings, label) {
  assert.ok(Array.isArray(warnings), `${label}: warnings must be an array`);
  for (const warning of warnings) {
    assert.equal(typeof warning.code, "string", `${label}: warning code must be a string`);
    assert.equal(typeof warning.message, "string", `${label}: warning message must be a string`);
  }
}

/** Front matter keeps title/subtitle through the export. */
function assertFrontMatter(out, ir, label) {
  const lines = out.mermaid.split("\n");
  if (ir.title) assert.ok(lines.some((line) => line.startsWith("title: ") && line.includes(ir.title)), `${label}: title expected in front matter`);
  if (ir.subtitle) assert.ok(lines.some((line) => line.startsWith("subtitle: ") && line.includes(ir.subtitle)), `${label}: subtitle expected in front matter`);
}

/* ------------------------------------------------------------------------- */
/* Flowchart / sequence round trips (the dialects convertMermaid reads)      */
/* ------------------------------------------------------------------------- */

function assertFlowchartRoundTrip(ir, label) {
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, label);
  assert.equal(back.ok, true, `${label}: convertMermaid() rejected the export: ${JSON.stringify(back.errors)}`);
  const validation = validate(back.ir);
  assert.equal(validation.ok, true, `${label}: round-tripped IR is invalid: ${JSON.stringify(validation.errors)}`);
  assert.deepEqual(sortedLabels(back.ir), sortedLabels(ir), `${label}: node label multiset changed`);
  assert.equal(back.ir.nodes.length, ir.nodes.length, `${label}: node count changed`);
  assert.equal((back.ir.edges || []).length, (ir.edges || []).length, `${label}: edge count changed`);
  assert.equal(back.ir.title, ir.title, `${label}: title should survive the front matter`);
  if (ir.subtitle) assert.equal(back.ir.subtitle, ir.subtitle, `${label}: subtitle should survive the front matter`);
  assert.ok(back.ir.type === "architecture" || back.ir.type === "workflow", `${label}: flowchart dialects may swap, nothing else`);
  assert.equal(back.ir.direction || "TB", ir.direction || "TB", `${label}: direction must survive (TB is the default)`);
  assert.deepEqual(
    (back.ir.groups || []).map((group) => [group.id, group.label, [...group.nodes].sort()]),
    (ir.groups || []).map((group) => [group.id, group.label, [...group.nodes].sort()]),
    `${label}: group ids, labels and membership must survive`,
  );
  const subgraphCount = out.mermaid.split("\n").filter((line) => line.trim().startsWith("subgraph ")).length;
  assert.equal(subgraphCount, (ir.groups || []).length, `${label}: one subgraph per author group expected`);
}

function assertSequenceRoundTrip(ir, label) {
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, label);
  assert.equal(back.ok, true, `${label}: convertMermaid() rejected the export: ${JSON.stringify(back.errors)}`);
  assert.equal(validate(back.ir).ok, true, `${label}: round-tripped IR is invalid`);
  assert.deepEqual(sortedLabels(back.ir), sortedLabels(ir), `${label}: participant label multiset changed`);
  assert.equal(back.ir.title, ir.title, `${label}: title should survive the front matter`);
  assert.equal(back.ir.type, "sequence");
  assert.deepEqual(
    back.ir.nodes.map((node) => node.id),
    ir.nodes.map((node) => node.id),
    `${label}: participant ids and order must survive`,
  );
  assert.deepEqual(
    back.ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
    ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
    `${label}: message from/to/label and order must survive`,
  );
}

/** The five types without a Mermaid dialect keep the flowchart fallback. */
function assertSimplifiedRoundTrip(ir, label) {
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, label);
  assert.equal(diagramLine(out.mermaid), ir.direction === "LR" ? "flowchart LR" : "flowchart TD", `${label}: fallback must stay a flowchart`);
  assertWarning(out.warnings, "to-mermaid/type-simplified", label);
  const simplified = out.warnings.find((warning) => warning.code === "to-mermaid/type-simplified");
  assert.ok(simplified.message.includes(`"${ir.type}"`), `${label}: the simplified warning must name the type`);
  assertFrontMatter(out, ir, label);
  assert.equal(back.ok, true, `${label}: flowchart fallback should still convert back: ${JSON.stringify(back.errors)}`);
  assert.deepEqual(sortedLabels(back.ir), sortedLabels(ir), `${label}: node label multiset changed in the fallback`);
  assert.equal(back.ir.nodes.length, ir.nodes.length, `${label}: node count changed in the fallback`);
  assert.equal((back.ir.edges || []).length, (ir.edges || []).length, `${label}: edge count changed in the fallback`);
  if ((ir.notes || []).length > 0) assertWarning(out.warnings, "to-mermaid/notes-dropped", label);
}

/* ------------------------------------------------------------------------- */
/* ERD structure (native erDiagram; ingesting it back is the other owner's)  */
/* ------------------------------------------------------------------------- */

function assertErdExport(ir, label) {
  const out = assertDeterministicAndPure(ir, label);
  assertMermaidShape(out.mermaid, label);
  assertWarningShape(out.warnings, label);
  assert.equal(diagramLine(out.mermaid), "erDiagram", `${label}: an erDiagram header is expected`);
  assert.ok(!out.mermaid.includes("flowchart "), `${label}: no flowchart fallback for erd`);
  assert.ok(!out.warnings.some((warning) => warning.code === "to-mermaid/type-simplified"), `${label}: erd has a native dialect now`);
  assertFrontMatter(out, ir, label);
  if (ir.direction) assert.ok(out.mermaid.includes(`  direction ${ir.direction}`), `${label}: direction line expected`);

  const lines = out.mermaid.split("\n");
  const declarations = lines.filter((line) => /^  [A-Za-z0-9_]+(\[".*"\])? \{$/.test(line));
  assert.equal(declarations.length, ir.nodes.length, `${label}: one entity block per node`);
  const rowLines = lines.filter((line) => /^    [A-Za-z0-9_()[\]-]+ [A-Za-z0-9_()[\]-]+( PK| FK| UK)?$/.test(line));
  const expectedRows = ir.nodes.reduce((sum, node) => sum + (node.attributes || []).length, 0);
  assert.equal(rowLines.length, expectedRows, `${label}: one attribute row per IR attribute`);
  const totalChars = rowLines.join("\n").length;

  for (const node of ir.nodes) {
    const id = mermaidId(node.id);
    const declaration = declarations.find((line) => line.trim().startsWith(`${id}[`) || line.trim().startsWith(`${id} `));
    assert.ok(declaration, `${label}: entity ${node.id} should have a block`);
    const labelNeedsAlias = node.label !== id;
    assert.equal(declaration.includes(`["${node.label}"]`), labelNeedsAlias, `${label}: alias only when the label differs for ${node.id}`);
  }
  const marks = rowLines.join("\n");
  const countMark = (mark) => (marks.match(new RegExp(` ${mark}$`, "gm")) || []).length;
  const expectedMarks = (key) => ir.nodes.reduce((sum, node) => sum + (node.attributes || []).filter((attr) => attr.key === key).length, 0);
  assert.equal(countMark("PK"), expectedMarks("pk"), `${label}: PK marks`);
  assert.equal(countMark("FK"), expectedMarks("fk"), `${label}: FK marks`);
  assert.equal(countMark("UK"), expectedMarks("unique"), `${label}: UK marks`);
  assert.equal(totalChars > 0, expectedRows > 0, "sanity");

  const relations = lines.filter((line) => /^  [A-Za-z0-9_]+ (\|\|--\|\||\|\|--o\{|\}o--o\{) [A-Za-z0-9_]+ : ".*"$/.test(line));
  assert.equal(relations.length, (ir.edges || []).length, `${label}: one relation per IR edge`);
  for (const [index, edge] of (ir.edges || []).entries()) {
    const token = ER_CARDINALITY[edge.cardinality];
    const expected = `  ${mermaidId(edge.from)} ${token} ${mermaidId(edge.to)} : "${edge.label || ""}"`;
    assert.equal(relations[index], expected, `${label}: relation ${index} must keep cardinality, order and label`);
  }
  if ((ir.notes || []).length > 0) assertWarning(out.warnings, "to-mermaid/notes-dropped", label);
  const refs = ir.nodes.reduce((sum, node) => sum + (node.attributes || []).filter((attr) => attr.ref).length, 0);
  if (refs > 0) assertWarning(out.warnings, "to-mermaid/erd-ref-dropped", label);
}

/* ------------------------------------------------------------------------- */
/* Class structure (native classDiagram; ingesting it back is the other owner's) */
/* ------------------------------------------------------------------------- */

function assertClassExport(ir, label) {
  const out = assertDeterministicAndPure(ir, label);
  assertMermaidShape(out.mermaid, label);
  assertWarningShape(out.warnings, label);
  assert.equal(diagramLine(out.mermaid), "classDiagram", `${label}: a classDiagram header is expected`);
  assert.ok(!out.mermaid.includes("flowchart "), `${label}: no flowchart fallback for class`);
  assert.ok(!out.warnings.some((warning) => warning.code === "to-mermaid/type-simplified"), `${label}: class has a native dialect now`);
  assertFrontMatter(out, ir, label);
  if (ir.direction) assert.ok(out.mermaid.includes(`  direction ${ir.direction}`), `${label}: direction line expected`);

  const lines = out.mermaid.split("\n");
  const declaredClasses = lines.filter((line) => /^  class [A-Za-z0-9_]+(\[".*"\])?( \{)?$/.test(line));
  assert.equal(declaredClasses.length, ir.nodes.length, `${label}: one class per node`);
  const memberLines = lines.filter((line) => /^    \S/.test(line));
  const expectedMembers = ir.nodes.reduce((sum, node) => sum + (node.members || []).length, 0);
  assert.equal(memberLines.length, expectedMembers, `${label}: one member row per IR member`);
  for (const node of ir.nodes) {
    const id = mermaidId(node.id);
    const declaration = declaredClasses.find((line) => line.trim().startsWith(`class ${id}[`) || line.trim().startsWith(`class ${id} `));
    assert.ok(declaration, `${label}: class ${node.id} should be declared`);
    assert.equal(declaration.includes(`["${node.label}"]`), node.label !== id, `${label}: alias only when the label differs for ${node.id}`);
    for (const member of node.members || []) assert.ok(out.mermaid.includes(`    ${member}`), `${label}: member "${member}" should be emitted verbatim`);
  }
  const stereotypeLines = lines.filter((line) => /^  <<(interface|abstract)>> [A-Za-z0-9_]+$/.test(line));
  const expectedStereotypes = ir.nodes.filter((node) => node.stereotype === "interface" || node.stereotype === "abstract");
  assert.equal(stereotypeLines.length, expectedStereotypes.length, `${label}: one stereotype line per stereotyped class`);
  for (const node of expectedStereotypes) assert.ok(stereotypeLines.includes(`  <<${node.stereotype}>> ${mermaidId(node.id)}`), `${label}: stereotype ${node.id}`);

  const relationLines = lines.filter((line) => /^  [A-Za-z0-9_]+ (<\|--|<\|\.\.|-->|\*--|\.\.>)/.test(line));
  assert.equal(relationLines.length, (ir.edges || []).length, `${label}: one relation per IR edge`);
  const rendered = relationLines.map((line) => line.trim());
  for (const edge of ir.edges || []) {
    const from = mermaidId(edge.from);
    const to = mermaidId(edge.to);
    const kind = edge.kind || "association";
    const expected = kind === "extends"
      ? `${to} <|-- ${from}`
      : kind === "implements"
        ? `${to} <|.. ${from}`
        : kind === "association"
          ? `${from} --> ${to}`
          : kind === "composition"
            ? `${from} *-- ${to}`
            : kind === "dependency"
              ? `${from} ..> ${to}`
              : null;
    assert.ok(expected, `${label}: unexpected class relation kind ${kind}`);
    const compound = `${expected}${edge.label ? ` : ${edge.label}` : ""}`;
    assert.ok(rendered.includes(compound), `${label}: relation "${compound}" expected`);
  }
  if ((ir.notes || []).length > 0) assertWarning(out.warnings, "to-mermaid/notes-dropped", label);
}

/* ------------------------------------------------------------------------- */
/* One export test per real example IR                                      */
/* ------------------------------------------------------------------------- */

for (const [index, file] of IR_FILES.entries()) {
  const name = IR_NAMES[index];
  test(`exports ${name}`, () => {
    const ir = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = toMermaid(ir);
    assert.equal(out.ok, true, `${name}: export failed: ${JSON.stringify(out.warnings)}`);
    assert.equal(typeof out.mermaid, "string");
    assertWarningShape(out.warnings, name);
    if (NATIVE_FLOW_TYPES.has(ir.type)) assertFlowchartRoundTrip(ir, name);
    else if (ir.type === "sequence") assertSequenceRoundTrip(ir, name);
    else if (SIMPLIFIED_TYPES.has(ir.type)) assertSimplifiedRoundTrip(ir, name);
    else if (ir.type === "erd") assertErdExport(ir, name);
    else if (ir.type === "class") assertClassExport(ir, name);
    else assert.fail(`${name}: unhandled diagram type ${ir.type}`);
  });
}

/* ------------------------------------------------------------------------- */
/* Fallback coverage: exactly five types, no native dialect                 */
/* ------------------------------------------------------------------------- */

test("the five types without a Mermaid dialect fall back to a flowchart with an explicit warning", () => {
  assert.deepEqual(
    [...new Set(SIMPLIFIED_EXAMPLES.map((ir) => ir.type))].sort(),
    ["dataflow", "lifecycle", "timeline", "tree", "waterfall"],
    "expected one example per fallback type",
  );
  for (const ir of SIMPLIFIED_EXAMPLES) {
    const out = toMermaid(ir);
    assert.equal(out.ok, true, `${ir.type}: export failed`);
    assert.equal(diagramLine(out.mermaid), "flowchart TD", `${ir.type}: fallback is a TD flowchart`);
    assertWarning(out.warnings, "to-mermaid/type-simplified", ir.type);
    assert.ok(!out.mermaid.includes("erDiagram") && !out.mermaid.includes("classDiagram"), `${ir.type}: no native header`);
  }
});

/* ------------------------------------------------------------------------- */
/* Mermaid fixtures already shipped with the project                        */
/* ------------------------------------------------------------------------- */

test("every flowchart/sequence test/mermaid fixture survives IR -> Mermaid -> IR", () => {
  assert.ok(FIXTURE_NAMES.length >= 9, "expected the shipped Mermaid fixtures");
  let checked = 0;
  for (const name of FIXTURE_NAMES) {
    const source = readFixture(name);
    const header = source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && line !== "---" && !/^(title|subtitle):/.test(line))
      .toLowerCase();
    // erDiagram/classDiagram fixtures belong to the ingest suite's round trip.
    if (header.startsWith("erdiagram") || header.startsWith("classdiagram")) continue;
    checked += 1;
    const first = convertMermaid(source);
    assert.equal(first.ok, true, `${name}: fixture must convert to IR first`);
    if (first.ir.type === "sequence") assertSequenceRoundTrip(first.ir, `fixture ${name}`);
    else assertFlowchartRoundTrip(first.ir, `fixture ${name}`);
  }
  assert.ok(checked >= 9, "expected at least the original nine fixtures to be covered");
});

/* ------------------------------------------------------------------------- */
/* ERD dialect                                                               */
/* ------------------------------------------------------------------------- */

test("erd exports erDiagram with entity blocks, PK/FK/UK attribute marks and quoted relations", () => {
  const ir = exampleIr("ir-schema.erd.json");
  const { out } = roundTrip(ir);
  const text = out.mermaid;
  assert.equal(diagramLine(text), "erDiagram");
  assert.ok(text.includes("  diagram {\n    int4 schema_version PK\n"), "PK attribute row expected");
  assert.ok(text.includes("  connection {\n    text id PK\n    text from FK\n    text to FK\n"), "FK rows expected");
  assert.ok(text.includes("    boundary_kind kind\n"), "custom type token expected");
  assert.ok(text.includes("    text[] wraps\n"), "array type token expected");
  assert.ok(text.includes('  source["source_ref"] {\n'), "alias expected when the label differs from the id");
  assert.ok(text.includes('  diagram ||--o{ component : "same document"'), "labelled 1:n relation expected");
  assert.ok(text.includes('  diagram ||--o{ boundary : ""'), "unlabelled relation gets an empty role");
  assert.equal(text.split("\n").filter((line) => /^  [a-z_]+ (\|\|--\|\||\|\|--o\{|\}o--o\{) [a-z_]+ : /.test(line)).length, ir.edges.length);
  assertWarning(out.warnings, "to-mermaid/erd-ref-dropped");
  assertWarning(out.warnings, "to-mermaid/notes-dropped");
});

test("erd cardinality maps 1:1, 1:n and n:m to their Mermaid tokens", () => {
  const ir = {
    title: "Cards",
    type: "erd",
    nodes: [
      { id: "a", label: "a", attributes: [{ name: "id", type: "int", key: "pk" }] },
      { id: "b", label: "b", attributes: [{ name: "id", type: "int", key: "pk" }] },
    ],
    edges: [
      { from: "a", to: "b", label: "one", cardinality: "1:1" },
      { from: "b", to: "a", label: "many", cardinality: "1:n" },
      { from: "a", to: "b", label: "both", cardinality: "n:m" },
    ],
  };
  const out = assertDeterministicAndPure(ir, "erd-cards");
  assert.ok(out.mermaid.includes('  a ||--|| b : "one"'));
  assert.ok(out.mermaid.includes('  b ||--o{ a : "many"'));
  assert.ok(out.mermaid.includes('  a }o--o{ b : "both"'));
});

test("erd sanitizes unwriteable attribute words and ids with a warning", () => {
  const ir = {
    title: "Hostile ERD",
    type: "erd",
    direction: "LR",
    nodes: [
      {
        id: "orders-db",
        label: "Orders DB",
        attributes: [
          { name: "id", type: "uuid", key: "pk" },
          { name: "customer id", type: "timestamp with time zone", key: "fk", ref: "customers.id" },
          { name: "4byte", type: "weird type!", key: "unique" },
        ],
      },
      { id: "customers", label: "customers", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
    ],
    edges: [{ from: "customers", to: "orders-db", label: "places", cardinality: "1:n" }],
  };
  const out = assertDeterministicAndPure(ir, "erd-hostile");
  assert.ok(out.mermaid.includes('  orders_db["Orders DB"] {'), "sanitized id keeps its readable alias");
  assert.ok(out.mermaid.includes("    uuid id PK"));
  assert.ok(out.mermaid.includes("    timestamp_with_time_zone customer_id FK"), "attribute words are folded to a single token");
  assert.ok(out.mermaid.includes("    weird_type column_4byte UK"), "numeric-leading words get a prefix");
  assert.ok(out.mermaid.includes("  direction LR"));
  assert.ok(out.mermaid.includes('  customers ||--o{ orders_db : "places"'));
  assertWarning(out.warnings, "to-mermaid/erd-attribute-sanitized");
  assertWarning(out.warnings, "to-mermaid/erd-ref-dropped");
  // orders-db -> orders_db is the reversible scheme, so no id warning is needed.
  assert.ok(!out.warnings.some((warning) => warning.code === "to-mermaid/id-normalized"));
});

test("erd/class report groups, notes, walkthrough and sublabels only when information is dropped", () => {
  const ir = {
    title: "Lossy ERD",
    type: "erd",
    groups: [{ id: "g", label: "Group", kind: "zone", nodes: ["a"] }],
    notes: ["a note"],
    walkthrough: [{ title: "Step", text: "Look here", focus: ["a"] }],
    nodes: [
      { id: "a", label: "A", sublabel: "sub", attributes: [{ name: "id", type: "int", key: "pk" }] },
      { id: "b", label: "B", attributes: [{ name: "id", type: "int" }] },
    ],
    edges: [{ from: "a", to: "b", cardinality: "1:n" }],
  };
  const out = assertDeterministicAndPure(ir, "lossy-erd");
  for (const code of [
    "to-mermaid/groups-dropped",
    "to-mermaid/notes-dropped",
    "to-mermaid/walkthrough-dropped",
    "to-mermaid/sublabel-dropped",
  ]) {
    assertWarning(out.warnings, code, "lossy-erd");
  }
  // Nothing is lost for a clean ERD/class diagram beyond the dialect itself.
  const cleanErd = exampleIr("ir-schema.erd.json");
  const cleanOut = toMermaid(cleanErd);
  assert.ok(!cleanOut.warnings.some((warning) => warning.code === "to-mermaid/groups-dropped" || warning.code === "to-mermaid/walkthrough-dropped"));
  const cleanClass = toMermaid(exampleIr("engine-modules.class.json"));
  assert.deepEqual(cleanClass.warnings, [], "a fully expressible class IR should export with no warnings");
});

/* ------------------------------------------------------------------------- */
/* Class dialect                                                             */
/* ------------------------------------------------------------------------- */

test("class exports classDiagram with verbatim members, stereotypes and UML relation markers", () => {
  const ir = exampleIr("engine-modules.class.json");
  const { out } = roundTrip(ir);
  const text = out.mermaid;
  assert.equal(diagramLine(text), "classDiagram");
  assert.ok(text.includes('  class renderer["Renderer"] {\n    + render(ir): string\n    + mode: string\n  }'), "class block with verbatim members expected");
  assert.ok(text.includes('  class native["NativeRenderer"] {\n    + render(ir): string\n    - layout: LayoutPlan\n'), "second class block expected");
  assert.ok(text.includes("  <<interface>> renderer"), "interface stereotype line expected");
  assert.ok(text.includes("  <<interface>> validator"), "second interface stereotype expected");
  assert.ok(text.includes("  renderer <|.. native"), "implements points at the parent (renderer)");
  assert.ok(text.includes("  renderer <|.. explainer"), "second implements relation expected");
  assert.ok(text.includes("  renderer --> layout : geometry"), "association with label expected");
  assert.ok(text.includes("  renderer ..> validator : rules"), "dependency with label expected");
  assert.ok(text.includes("  deliverer *-- renderer"), "composition keeps the IR direction");
  assert.equal(text.split("\n").filter((line) => /^  class /.test(line)).length, ir.nodes.length);
  assert.equal(text.split("\n").filter((line) => /^  <<(interface|abstract)>> /.test(line)).length, 2);
});

test("class relation markers follow the five UML kinds and extends/implements point at the parent", () => {
  const ir = {
    title: "Relations",
    type: "class",
    nodes: [
      { id: "child", label: "Child", members: [] },
      { id: "base", label: "Base", stereotype: "interface", members: ["+ run(): void"] },
      { id: "part", label: "Part", members: [] },
      { id: "other", label: "Other", members: [] },
    ],
    edges: [
      { from: "child", to: "base", kind: "implements" },
      { from: "child", to: "other", kind: "extends", label: "extends base" },
      { from: "child", to: "part", kind: "association" },
      { from: "child", to: "other", kind: "composition" },
      { from: "child", to: "base", kind: "dependency", label: "uses rules" },
    ],
  };
  const out = assertDeterministicAndPure(ir, "class-relations");
  assert.ok(out.mermaid.includes("  base <|.. child"), "implements: triangle on the parent (left)");
  assert.ok(out.mermaid.includes("  other <|-- child : extends base"), "extends: triangle on the parent (left)");
  assert.ok(out.mermaid.includes("  child --> part"), "association keeps direction");
  assert.ok(out.mermaid.includes("  child *-- other"), "composition keeps direction");
  assert.ok(out.mermaid.includes("  child ..> base : uses rules"), "dependency keeps direction");
  assert.ok(out.mermaid.includes("  <<interface>> base"));
});

test("class stereotypes: interface/abstract get a line, class/null do not", () => {
  const ir = {
    title: "Stereotypes",
    type: "class",
    nodes: [
      { id: "iface", label: "Iface", stereotype: "interface", members: ["+ run(): void"] },
      { id: "abs", label: "Abs", stereotype: "abstract", members: ["# hook(): void"] },
      { id: "plain", label: "Plain", stereotype: "class", members: ["+ x: int"] },
      { id: "none", label: "None", members: [] },
    ],
    edges: [{ from: "plain", to: "iface", kind: "implements" }],
  };
  const out = assertDeterministicAndPure(ir, "class-stereotypes");
  assert.ok(out.mermaid.includes("  <<interface>> iface"));
  assert.ok(out.mermaid.includes("  <<abstract>> abs"));
  assert.ok(!out.mermaid.includes("<<interface>> plain"));
  assert.ok(!out.mermaid.includes("<<abstract>> plain"));
  assert.ok(out.mermaid.includes("  class none"));
  assert.ok(out.mermaid.includes("  iface <|.. plain"));
});

test("class members with braces/stereotype shapes and generic relation kinds are sanitized with warnings", () => {
  const ir = {
    title: "Hostile class",
    type: "class",
    nodes: [
      { id: "a", label: "A", members: ["+ map: Map~string~", "+ weird {brace} member", "<<interface>>"] },
      { id: "b", label: "B", members: ["+ render(ir): string"] },
    ],
    edges: [
      { from: "a", to: "b", kind: "main", label: "uses: layout" },
    ],
  };
  const out = assertDeterministicAndPure(ir, "class-hostile");
  assert.ok(out.mermaid.includes("    + map: Map~string~"), "generics must stay intact");
  assert.ok(out.mermaid.includes("    + weird (brace) member"), "braces are folded so the class block stays open");
  assert.ok(out.mermaid.includes("    ((interface))"), "stereotype lookalike member is not swallowed");
  assert.ok(out.mermaid.includes("  a --> b : uses - layout"), "generic kind degrades to association; ':' folded in the label");
  assertWarning(out.warnings, "to-mermaid/class-member-sanitized");
  assertWarning(out.warnings, "to-mermaid/class-edge-kind");
  assertWarning(out.warnings, "to-mermaid/label-sanitized");
});

test("class direction line and empty class blocks are valid Mermaid", () => {
  const ir = {
    title: "Directions",
    type: "class",
    direction: "LR",
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B", members: [] },
    ],
    edges: [{ from: "a", to: "b", kind: "association" }],
  };
  const out = assertDeterministicAndPure(ir, "class-direction");
  assert.ok(out.mermaid.includes("  direction LR"));
  assert.ok(out.mermaid.includes('  class a["A"]\n'));
  assert.ok(out.mermaid.includes('  class b["B"]\n'));
  assert.ok(out.mermaid.includes("  a --> b"));
});

/* ------------------------------------------------------------------------- */
/* Escaping and hostile labels (flowchart)                                   */
/* ------------------------------------------------------------------------- */

test("quotes, angle brackets and ampersands are entity-escaped and decode back in the round trip", () => {
  const ir = {
    title: "Escaping",
    type: "architecture",
    nodes: [
      { id: "plain", label: "Plain", kind: "service" },
      { id: "tricky", label: 'Say "hi" & <bye>', kind: "actor" },
      { id: "brackets", label: "Brackets [x] (y) {z}", kind: "security" },
      { id: "pipes", label: "Pipe | and ; semicolon", kind: "datastore" },
      { id: "flag", label: "New\nline\ttab", kind: "note" },
    ],
    groups: [{ id: "grp", label: "Group (one) [b]", kind: "zone", nodes: ["plain"] }],
    edges: [
      { from: "plain", to: "tricky", label: 'edge with "quotes" & <gt>', kind: "main" },
      { from: "tricky", to: "brackets", label: "pipe | label", kind: "async" },
      { from: "brackets", to: "pipes", label: "semicolon ; label", kind: "security" },
      { from: "pipes", to: "flag", label: "unbalanced ( bracket", kind: "return" },
    ],
  };
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, "escaping");
  assert.ok(out.mermaid.includes("&quot;"), "quotes must be entity-escaped");
  assert.ok(out.mermaid.includes("&amp;"), "ampersands must be entity-escaped");
  const expected = ir.nodes.map((node) => (node.label.includes("\n") ? "New line tab" : node.label)).sort();
  assert.deepEqual(sortedLabels(back.ir), expected);
  assert.equal(back.ir.edges.length, ir.edges.length);
  assertWarning(out.warnings, "to-mermaid/label-collapsed");
  assert.deepEqual(back.ir.groups.map((group) => group.label), ["Group (one) [b]"]);
});

test("statement separators ; and | never leak raw into a sequence source", () => {
  const ir = {
    title: "Separators",
    type: "sequence",
    nodes: [
      { id: "a", label: 'A "quoted"', kind: "actor" },
      { id: "b", label: "B & co", kind: "service" },
    ],
    notes: ["note with ; and & and <tag>"],
    edges: [
      { from: "a", to: "b", label: "select; where", kind: "main" },
      { from: "b", to: "a", label: 'render "ok"', kind: "return" },
    ],
  };
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, "separators");
  assert.equal(back.ok, true);
  const messageLines = out.mermaid.split("\n").filter((line) => /^\s+[A-Za-z0-9_]+(-->>|->>|--x|-\)|->)[A-Za-z0-9_]+/.test(line));
  assert.equal(messageLines.length, ir.edges.length);
  assertWarning(out.warnings, "to-mermaid/text-sanitized");
});

test("node ids are sanitized to [A-Za-z0-9_] yet come back unchanged for valid IR ids", () => {
  const ir = {
    title: "Ids",
    type: "architecture",
    nodes: [
      { id: "orders-db", label: "Orders DB", kind: "datastore" },
      { id: "api-gateway", label: "API Gateway", kind: "security" },
      { id: "style", label: "Style Word", kind: "service" },
    ],
    edges: [{ from: "orders-db", to: "api-gateway", label: "read", kind: "data" }],
  };
  const { out, back } = roundTrip(ir);
  assert.ok(out.mermaid.includes("orders_db[(Orders DB)]"), "hyphenated ids become underscore ids");
  assert.ok(/^\s+n_style\[/m.test(out.mermaid), "ids that Mermaid reads as a directive get an n_ prefix");
  assert.ok(back.ir.nodes.some((node) => node.id === "orders-db"));
  assert.ok(back.ir.nodes.some((node) => node.id === "api-gateway"));
  assertWarning(out.warnings, "to-mermaid/id-normalized");
});

/* ------------------------------------------------------------------------- */
/* Sequence dialect coverage                                                 */
/* ------------------------------------------------------------------------- */

test("sequence export declares participants and messages in IR order", () => {
  for (const ir of SEQUENCE_EXAMPLES) {
    assertSequenceRoundTrip(ir, ir.title);
    const out = toMermaid(ir);
    const lines = out.mermaid.split("\n");
    const declarations = lines.filter((line) => /^\s+(participant|actor) /.test(line));
    assert.equal(declarations.length, ir.nodes.length, "one declaration per participant");
    ir.nodes.forEach((node, index) => {
      assert.ok(declarations[index].includes(` ${node.id} as ${node.label}`), `participant ${node.id} should be declared in IR order`);
      if (node.kind === "actor") assert.match(declarations[index], /^\s+actor /);
    });
  }
});

test("sequence arrows follow the kind mapping (->> main/data, -->> return, -) async, --x security, -> message)", () => {
  const ir = {
    title: "Arrows",
    type: "sequence",
    nodes: [
      { id: "a", label: "A", kind: "actor" },
      { id: "b", label: "B", kind: "service" },
    ],
    edges: [
      { from: "a", to: "b", label: "main", kind: "main" },
      { from: "a", to: "b", label: "data", kind: "data" },
      { from: "b", to: "a", label: "return", kind: "return" },
      { from: "a", to: "b", label: "async", kind: "async" },
      { from: "b", to: "a", label: "security", kind: "security" },
      { from: "b", to: "a", label: "message", kind: "message" },
    ],
  };
  const { mermaid } = roundTrip(ir).out;
  assert.ok(mermaid.includes("a->>b: main"));
  assert.ok(mermaid.includes("a->>b: data"));
  assert.ok(mermaid.includes("b-->>a: return"));
  assert.ok(mermaid.includes("a-)b: async"));
  assert.ok(mermaid.includes("b--xa: security"));
  assert.ok(mermaid.includes("b->a: message"));
});

test("fragment groups become loop blocks around the messages fully inside them", () => {
  const ir = {
    title: "Retry with a fragment",
    type: "sequence",
    nodes: [
      { id: "client", label: "Client", kind: "actor" },
      { id: "api", label: "API", kind: "service" },
    ],
    edges: [
      { from: "client", to: "api", label: "GET /", kind: "main" },
      { from: "api", to: "client", label: "503", kind: "return" },
      { from: "client", to: "api", label: "GET /", kind: "main" },
      { from: "api", to: "client", label: "200", kind: "return" },
    ],
    groups: [{ id: "retry", label: "retry once", kind: "fragment", nodes: ["client", "api"] }],
  };
  const { out } = roundTrip(ir);
  const lines = out.mermaid.split("\n");
  const openAt = lines.findIndex((line) => line.trim() === "loop retry once");
  const closeAt = lines.findIndex((line, index) => index > openAt && line.trim() === "end");
  assert.ok(openAt > 0 && closeAt > openAt, "a loop retry once ... end block is expected");
  assert.ok(closeAt - openAt >= 4, "all four messages sit inside the block");
});

test("non-adjacent fragment messages become several blocks instead of reordering messages", () => {
  const ir = {
    title: "Split fragment",
    type: "sequence",
    nodes: [
      { id: "u", label: "U", kind: "actor" },
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
    ],
    groups: [{ id: "frag", label: "retry", kind: "fragment", nodes: ["a", "b"] }],
    edges: [
      { from: "u", to: "a", label: "start", kind: "main" },
      { from: "a", to: "b", label: "one", kind: "main" },
      { from: "u", to: "a", label: "again", kind: "main" },
      { from: "b", to: "a", label: "two", kind: "return" },
    ],
  };
  const { out, back } = roundTrip(ir);
  const blockCount = out.mermaid.split("\n").filter((line) => line.trim() === "loop retry").length;
  assert.equal(blockCount, 2, "two non-adjacent runs -> two loop blocks");
  assertWarning(out.warnings, "to-mermaid/fragment-split");
  assert.deepEqual(
    back.ir.edges.map((edge) => edge.label),
    ir.edges.map((edge) => edge.label),
    "message order survives the split",
  );
});

test("unlabeled sequence messages export a bare colon so Mermaid accepts them", () => {
  const ir = {
    title: "No labels",
    type: "sequence",
    nodes: [
      { id: "a", label: "A", kind: "actor" },
      { id: "b", label: "B", kind: "service" },
    ],
    edges: [
      { from: "a", to: "b", kind: "main" },
      { from: "b", to: "a", kind: "return" },
    ],
  };
  const { out, back } = roundTrip(ir);
  const messageLines = out.mermaid.split("\n").filter((line) => /^\s+[A-Za-z0-9_]+(-->>|->>|--x|-\)|->)/.test(line));
  assert.deepEqual(messageLines.map((line) => line.trim()), ["a->>b:", "b-->>a:"]);
  assert.deepEqual(
    back.ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
    [
      ["a", "b", ""],
      ["b", "a", ""],
    ],
  );
});

test("sequence notes are emitted as Note over so they survive a paste into Mermaid", () => {
  const ir = {
    title: "Notes",
    type: "sequence",
    nodes: [
      { id: "a", label: "A", kind: "actor" },
      { id: "b", label: "B", kind: "service" },
    ],
    notes: ["browser cache warm", "retry twice"],
    edges: [{ from: "a", to: "b", label: "call", kind: "main" }],
  };
  const { out, back } = roundTrip(ir);
  assert.equal(out.mermaid.split("\n").filter((line) => line.includes("Note over ")).length, 2);
  assert.deepEqual(back.ir.notes, ir.notes);
});

/* ------------------------------------------------------------------------- */
/* Warnings, errors and hygiene                                              */
/* ------------------------------------------------------------------------- */

test("non-expressible IR features produce warnings, never failures", () => {
  const demo = exampleIr("engine-repo.architecture.json");
  const demoOut = toMermaid(demo);
  assert.equal(demoOut.ok, true);
  const codes = demoOut.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("to-mermaid/walkthrough-dropped"), "walkthrough is not expressible in Mermaid");
  assert.ok(codes.includes("to-mermaid/notes-dropped"), "flowchart notes are not expressible in Mermaid");
  assert.ok(codes.includes("to-mermaid/sublabel-dropped"), "sublabels are not expressible in Mermaid");
  assert.ok(demoOut.mermaid.length > 0);

  const diffIr = {
    title: "Diff",
    type: "architecture",
    nodes: [
      { id: "a", label: "A", kind: "service", status: "added" },
      { id: "b", label: "B", kind: "service", status: "changed" },
    ],
    edges: [{ from: "a", to: "b", label: "x", kind: "main", status: "removed" }],
  };
  const diffOut = toMermaid(diffIr);
  assert.equal(diffOut.ok, true, "a diff IR still exports as a plain diagram");
  assertWarning(diffOut.warnings, "to-mermaid/diff-status-dropped");
});

test("sublabels can be inlined as \"label - sublabel\" on request", () => {
  const demo = exampleIr("engine-repo.architecture.json");
  const plain = toMermaid(demo);
  assertWarning(plain.warnings, "to-mermaid/sublabel-dropped");
  const inlined = toMermaid(demo, { sublabels: true });
  assert.equal(inlined.ok, true);
  assertWarning(inlined.warnings, "to-mermaid/sublabel-inlined");
  const expected = demo.nodes
    .map((node) => (node.sublabel && `${node.label} - ${node.sublabel}`.length <= 80 ? `${node.label} - ${node.sublabel}` : node.label))
    .sort();
  const back = convertMermaid(inlined.mermaid);
  assert.equal(back.ok, true);
  assert.deepEqual(sortedLabels(back.ir), expected, "inlined sublabels decode back exactly");
});

test("invalid and unsupported input returns {ok:false, mermaid:''} instead of throwing", () => {
  for (const input of [null, undefined, [], "flowchart TD", 42, { title: "x", type: "gantt", nodes: [] }]) {
    const result = toMermaid(input);
    assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(input)}`);
    assert.equal(result.mermaid, "");
    assert.ok(result.warnings.length > 0);
    assert.equal(typeof result.warnings[0].code, "string");
  }
  const unsupported = toMermaid({ title: "x", type: "gantt", nodes: [] });
  assertWarning(unsupported.warnings, "to-mermaid/unsupported-type");
  const message = unsupported.warnings[0].message;
  for (const type of DIAGRAM_TYPES) assert.ok(message.includes(type), `unsupported-type message should list ${type}`);
  assert.ok(message.includes("gantt"), "the rejected type should be named");
});

test("toMermaid never mutates the input IR", () => {
  for (const ir of EXAMPLES) {
    const before = JSON.stringify(ir);
    toMermaid(ir);
    toMermaid(ir, { sublabels: true });
    assert.equal(JSON.stringify(ir), before, `${ir.title}: input IR was mutated`);
  }
});

/* ------------------------------------------------------------------------- */
/* Output hygiene                                                            */
/* ------------------------------------------------------------------------- */

test("output is deterministic and stable across repeated calls for every example", () => {
  for (const ir of EXAMPLES) assertDeterministicAndPure(ir, ir.title);
  for (const name of FIXTURE_NAMES) {
    const source = readFixture(name);
    const first = convertMermaid(source);
    if (!first.ok) continue;
    assert.deepEqual(toMermaid(first.ir), toMermaid(first.ir), `${name}: fixture export is not deterministic`);
  }
});

test("generated Mermaid has a header, no trailing whitespace, no control characters and one final newline", () => {
  for (const ir of EXAMPLES) assertMermaidShape(toMermaid(ir).mermaid, ir.title);
  for (const name of FIXTURE_NAMES) {
    const first = convertMermaid(readFixture(name));
    if (!first.ok) continue;
    assertMermaidShape(toMermaid(first.ir).mermaid, name);
  }
});
