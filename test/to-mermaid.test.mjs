// Mermaid export suite (owner: convert). `toMermaid(ir)` must produce valid,
// deterministic Mermaid that our own `convertMermaid()` reads back into the same
// diagram: node-label multiset, node count and edge count survive the round trip.
//
// The hard round-trip test runs over every examples/*.json IR, the demo IR and
// every test/mermaid/*.mmd fixture (converted to IR first), because a README
// export is only useful if it keeps the diagram content.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toMermaid } from "../src/convert/to-mermaid.mjs";
import { convertMermaid } from "../src/convert/mermaid.mjs";
import { validate } from "../src/validate/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const DEMO_DIR = path.join(ROOT, "examples");
const FIXTURES_DIR = path.join(ROOT, "test", "mermaid");

const IR_FILES = [
  ...fs
    .readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(EXAMPLES_DIR, name)),
  path.join(DEMO_DIR, "engine-repo.architecture.json"),
];
const IR_NAMES = IR_FILES.map((file) => path.relative(ROOT, file));
const FIXTURE_NAMES = fs
  .readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".mmd"))
  .sort();
const EXAMPLES = IR_FILES.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const FLOW_EXAMPLES = EXAMPLES.filter((ir) => ir.type !== "sequence");
const SEQUENCE_EXAMPLES = EXAMPLES.filter((ir) => ir.type === "sequence");

const sortedLabels = (ir) => ir.nodes.map((node) => node.label).sort();
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");

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
  assert.match(first, /^(flowchart (TD|LR)|sequenceDiagram)$/, `${label}: first diagram line must be a Mermaid header, got ${JSON.stringify(first)}`);
}

/** Hard round-trip assertions (contract §IR → Mermaid). */
function assertRoundTrip(ir, label) {
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, label);
  assert.equal(back.ok, true, `${label}: convertMermaid() rejected the export: ${JSON.stringify(back.errors)}`);
  const validation = validate(back.ir);
  assert.equal(validation.ok, true, `${label}: round-tripped IR is invalid: ${JSON.stringify(validation.errors)}`);
  assert.deepEqual(sortedLabels(back.ir), sortedLabels(ir), `${label}: node label multiset changed`);
  assert.equal(back.ir.nodes.length, ir.nodes.length, `${label}: node count changed`);
  assert.equal((back.ir.edges || []).length, (ir.edges || []).length, `${label}: edge count changed`);
  // Deterministic: same IR -> byte-identical Mermaid.
  assert.equal(toMermaid(ir).mermaid, out.mermaid, `${label}: output is not deterministic`);
  return { out, back };
}

/* ------------------------------------------------------------------------- */
/* Hard round trip: real inputs                                              */
/* ------------------------------------------------------------------------- */

for (const [index, file] of IR_FILES.entries()) {
  const name = IR_NAMES[index];
  test(`round-trips ${name} through Mermaid`, () => {
    const ir = JSON.parse(fs.readFileSync(file, "utf8"));
    const { out, back } = assertRoundTrip(ir, name);
    assert.equal(back.ir.title, ir.title, `${name}: title should survive the front matter`);
    if (ir.subtitle) assert.equal(back.ir.subtitle, ir.subtitle, `${name}: subtitle should survive the front matter`);
    assert.ok(Array.isArray(out.warnings));
    for (const warning of out.warnings) {
      assert.equal(typeof warning.code, "string", `${name}: warning code must be a string`);
      assert.equal(typeof warning.message, "string", `${name}: warning message must be a string`);
    }
    if (ir.type === "sequence") {
      assert.equal(back.ir.type, "sequence");
      assert.deepEqual(
        back.ir.nodes.map((node) => node.id),
        ir.nodes.map((node) => node.id),
        `${name}: participant ids and order must survive`,
      );
      assert.deepEqual(
        back.ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
        ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
        `${name}: message from/to/label and order must survive`,
      );
    } else {
      assert.ok(back.ir.type === "architecture" || back.ir.type === "workflow", `${name}: flowchart dialects may swap, nothing else`);
      assert.equal(back.ir.direction || "TB", ir.direction || "TB", `${name}: direction must survive (TB is the default)`);
      assert.deepEqual(
        (back.ir.groups || []).map((group) => [group.id, group.label, [...group.nodes].sort()]),
        (ir.groups || []).map((group) => [group.id, group.label, [...group.nodes].sort()]),
        `${name}: group ids, labels and membership must survive`,
      );
      const authorGroups = ir.groups || [];
      const subgraphCount = out.mermaid.split("\n").filter((line) => line.trim().startsWith("subgraph ")).length;
      assert.equal(subgraphCount, authorGroups.length, `${name}: one subgraph per author group expected`);
    }
  });
}

/* ------------------------------------------------------------------------- */
/* Hard round trip: the Mermaid fixtures this project already ships          */
/* ------------------------------------------------------------------------- */

test("every test/mermaid fixture survives IR -> Mermaid -> IR", () => {
  assert.ok(FIXTURE_NAMES.length >= 9, "expected the shipped Mermaid fixtures");
  for (const name of FIXTURE_NAMES) {
    const source = readFixture(name);
    const first = convertMermaid(source);
    assert.equal(first.ok, true, `${name}: fixture must convert to IR first`);
    const { back } = assertRoundTrip(first.ir, `fixture ${name}`);
    assert.deepEqual(sortedLabels(back.ir), sortedLabels(first.ir), `${name}: labels changed`);
    if (first.ir.groups) {
      assert.deepEqual(
        (back.ir.groups || []).map((group) => [group.id, group.label, [...group.nodes].sort()]),
        first.ir.groups.map((group) => [group.id, group.label, [...group.nodes].sort()]),
        `${name}: group membership changed`,
      );
    }
    if (first.ir.type === "sequence" && first.ir.notes) {
      assert.deepEqual(back.ir.notes, first.ir.notes, `${name}: sequence notes should be re-emitted as Note over`);
    }
  }
});

/* ------------------------------------------------------------------------- */
/* Flowchart dialect                                                         */
/* ------------------------------------------------------------------------- */

test("architecture and workflow export as flowchart TD|LR with front matter", () => {
  for (const ir of FLOW_EXAMPLES) {
    const { mermaid } = toMermaid(ir);
    const lines = mermaid.split("\n");
    assert.equal(lines[0], "---", "front matter with the title is expected");
    assert.ok(lines.includes(`title: ${ir.title}`), `title line expected for ${ir.title}`);
    assert.ok(lines.includes(ir.direction === "LR" ? "flowchart LR" : "flowchart TD"), `direction header expected for ${ir.title}`);
    assert.equal(lines.filter((line) => line.startsWith("flowchart ")).length, 1);
  }
  // TB -> TD (Mermaid spells top-down as TD; the ingest maps both to TB).
  assert.match(toMermaid({ ...FLOW_EXAMPLES[0], direction: "TB" }).mermaid, /^flowchart TD$/m);
  assert.match(toMermaid({ ...FLOW_EXAMPLES[0], direction: "LR" }).mermaid, /^flowchart LR$/m);
});

test("one subgraph per IR group, labeled and wrapping its members", () => {
  for (const ir of FLOW_EXAMPLES) {
    if (!ir.groups || ir.groups.length === 0) continue;
    const { mermaid } = toMermaid(ir);
    for (const group of ir.groups) {
      const header = mermaid.split("\n").find((line) => line.trim().startsWith(`subgraph ${group.id}[`));
      assert.ok(header, `subgraph ${group.id} expected in ${ir.title}`);
      assert.ok(header.includes(group.label), `subgraph label ${group.label} expected`);
      const lines = mermaid.split("\n");
      const start = lines.indexOf(header);
      const end = lines.findIndex((line, index) => index > start && line.trim() === "end");
      assert.ok(end > start, `subgraph ${group.id} should be closed with end`);
      const inside = lines.slice(start + 1, end).map((line) => line.trim());
      for (const nodeId of group.nodes) {
        const mermaidId = nodeId.replace(/-/g, "_");
        assert.ok(inside.some((line) => line.startsWith(mermaidId)), `node ${nodeId} should sit inside subgraph ${group.id}`);
      }
    }
  }
});

test("node shapes follow the kind mapping (service/queue/compute/state -> [], actor -> ([]), datastore -> [()], security -> {}, note -> > ], external -> [[]])", () => {
  const ir = {
    title: "Kinds",
    type: "workflow",
    nodes: [
      { id: "svc", label: "Service", kind: "service" },
      { id: "que", label: "Queue", kind: "queue" },
      { id: "cmp", label: "Compute", kind: "compute" },
      { id: "st", label: "State", kind: "state" },
      { id: "act", label: "Actor", kind: "actor" },
      { id: "ds", label: "Datastore", kind: "datastore" },
      { id: "sec", label: "Security", kind: "security" },
      { id: "nt", label: "Note", kind: "note" },
      { id: "ext", label: "External", kind: "external" },
    ],
    edges: [{ from: "svc", to: "sec", label: "go", kind: "main" }],
  };
  const { mermaid } = roundTrip(ir).out;
  for (const id of ["svc", "que", "cmp", "st"]) assert.ok(mermaid.includes(`${id}[${ir.nodes.find((n) => n.id === id).label}]`), `rect shape expected for ${id}`);
  assert.ok(mermaid.includes("act([Actor])"), "actor shape expected");
  assert.ok(mermaid.includes("ds[(Datastore)]"), "datastore shape expected");
  assert.ok(mermaid.includes("sec{Security}"), "security diamond expected");
  assert.ok(mermaid.includes("nt>Note]"), "note flag expected");
  assert.ok(mermaid.includes("ext[[External]]"), "external subroutine expected");
});

test("flowchart edge syntax follows the kind mapping (main/data -->, async/return -.->, security/message ==>, labels in pipes)", () => {
  const kinds = ["main", "data", "async", "return", "security", "message"];
  const ir = {
    title: "Kinds",
    type: "workflow",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
    ],
    edges: kinds.map((kind) => ({ from: "a", to: "b", label: kind, kind })),
  };
  const { mermaid } = roundTrip(ir).out;
  assert.ok(mermaid.includes("a -->|main| b"));
  assert.ok(mermaid.includes("a -->|data| b"));
  assert.ok(mermaid.includes("a -.->|async| b"));
  assert.ok(mermaid.includes("a -.->|return| b"));
  assert.ok(mermaid.includes("a ==>|security| b"));
  assert.ok(mermaid.includes("a ==>|message| b"));
});

/* ------------------------------------------------------------------------- */
/* Sequence dialect                                                          */
/* ------------------------------------------------------------------------- */

test("sequence export declares participants and messages in IR order", () => {
  for (const ir of SEQUENCE_EXAMPLES) {
    const { out, back } = roundTrip(ir);
    const lines = out.mermaid.split("\n");
    assert.equal(lines[lines.indexOf("sequenceDiagram") - 1], "---", "front matter is expected before sequenceDiagram");
    const declarations = lines.filter((line) => /^\s+(participant|actor) /.test(line));
    assert.equal(declarations.length, ir.nodes.length, "one declaration per participant");
    ir.nodes.forEach((node, index) => {
      assert.ok(declarations[index].includes(` ${node.id} as ${node.label}`), `participant ${node.id} should be declared in IR order`);
      if (node.kind === "actor") assert.match(declarations[index], /^\s+actor /);
    });
    assert.deepEqual(
      back.ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
      ir.edges.map((edge) => [edge.from, edge.to, edge.label || ""]),
      "messages keep their from/to/label and declaration order",
    );
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
  assert.ok(out.warnings.some((warning) => warning.code === "to-mermaid/fragment-split"));
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
/* Escaping and hostile labels                                               */
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
  assert.ok(!out.mermaid.includes('["Say "hi"'), "no raw quotes inside a label");
  // The one lossy transform is newline/tab collapsing (documented warning).
  const expected = ir.nodes.map((node) => (node.label.includes("\n") ? "New line tab" : node.label)).sort();
  assert.deepEqual(sortedLabels(back.ir), expected);
  assert.equal(back.ir.edges.length, ir.edges.length);
  assert.ok(out.warnings.some((warning) => warning.code === "to-mermaid/label-collapsed"));
  // The group label survives too.
  assert.deepEqual(back.ir.groups.map((group) => group.label), ["Group (one) [b]"]);
});

test("statement separators ; and | never leak raw into the Mermaid source", () => {
  const ir = {
    title: "Separators",
    type: "sequence",
    nodes: [
      { id: "a", label: 'A "quoted"', kind: "actor" },
      { id: "b", label: "B & co", kind: "service" },
    ],
    notes: ['note with ; and & and <tag>'],
    edges: [
      { from: "a", to: "b", label: "select; where", kind: "main" },
      { from: "b", to: "a", label: 'render "ok"', kind: "return" },
    ],
  };
  const { out, back } = roundTrip(ir);
  assertMermaidShape(out.mermaid, "separators");
  assert.equal(back.ok, true);
  // No statement may be split by a raw semicolon from a label: every arrow line
  // is still one message line.
  const messageLines = out.mermaid.split("\n").filter((line) => /^\s+[A-Za-z0-9_]+(-->>|->>|--x|-\)|->)[A-Za-z0-9_]+/.test(line));
  assert.equal(messageLines.length, ir.edges.length);
  assert.ok(out.warnings.some((warning) => warning.code === "to-mermaid/text-sanitized"));
});

test("ids are sanitized to [A-Za-z0-9_] yet come back unchanged for valid IR ids", () => {
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
  // orders-db / api-gateway normalize back; the reserved-word id is the only rename.
  assert.ok(back.ir.nodes.some((node) => node.id === "orders-db"));
  assert.ok(back.ir.nodes.some((node) => node.id === "api-gateway"));
  assert.ok(out.warnings.some((warning) => warning.code === "to-mermaid/id-normalized"));
});

/* ------------------------------------------------------------------------- */
/* Warnings (never failures)                                                 */
/* ------------------------------------------------------------------------- */

test("non-expressible IR features produce warnings, never failures", () => {
  const demo = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, "engine-repo.architecture.json"), "utf8"));
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
  assert.ok(diffOut.warnings.some((warning) => warning.code === "to-mermaid/diff-status-dropped"));
});

test("sublabels can be inlined as \"label - sublabel\" on request", () => {
  const demo = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, "engine-repo.architecture.json"), "utf8"));
  const plain = toMermaid(demo);
  assert.ok(plain.warnings.some((warning) => warning.code === "to-mermaid/sublabel-dropped"));
  const inlined = toMermaid(demo, { sublabels: true });
  assert.equal(inlined.ok, true);
  assert.ok(inlined.warnings.some((warning) => warning.code === "to-mermaid/sublabel-inlined"));
  const expected = demo.nodes
    .map((node) => (node.sublabel && `${node.label} - ${node.sublabel}`.length <= 80 ? `${node.label} - ${node.sublabel}` : node.label))
    .sort();
  const back = convertMermaid(inlined.mermaid);
  assert.equal(back.ok, true);
  assert.deepEqual(sortedLabels(back.ir), expected, "inlined sublabels decode back exactly");
});

test("toMermaid never mutates the input IR", () => {
  for (const ir of EXAMPLES) {
    const before = JSON.stringify(ir);
    toMermaid(ir);
    toMermaid(ir, { sublabels: true });
    assert.equal(JSON.stringify(ir), before, `${ir.title}: input IR was mutated`);
  }
  for (const name of FIXTURE_NAMES) {
    const ir = convertMermaid(readFixture(name)).ir;
    const before = JSON.stringify(ir);
    toMermaid(ir);
    assert.equal(JSON.stringify(ir), before, `${name}: input IR was mutated`);
  }
});

test("invalid input returns {ok:false, mermaid:''} with a warning instead of throwing", () => {
  for (const input of [null, undefined, [], "flowchart TD", 42, { title: "x", type: "gantt", nodes: [] }]) {
    const result = toMermaid(input);
    assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(input)}`);
    assert.equal(result.mermaid, "");
    assert.ok(result.warnings.length > 0);
    assert.equal(typeof result.warnings[0].code, "string");
  }
});

/* ------------------------------------------------------------------------- */
/* Output hygiene                                                            */
/* ------------------------------------------------------------------------- */

test("output is deterministic and stable across repeated calls", () => {
  for (const ir of EXAMPLES) {
    const first = toMermaid(ir);
    const second = toMermaid(JSON.parse(JSON.stringify(ir)));
    assert.deepEqual(second, first, `${ir.title}: same IR must give byte-identical output and warnings`);
  }
  for (const name of FIXTURE_NAMES) {
    const ir = convertMermaid(readFixture(name)).ir;
    assert.deepEqual(toMermaid(ir), toMermaid(ir));
  }
});

test("generated Mermaid has no trailing whitespace, no control characters and one final newline", () => {
  for (const ir of EXAMPLES) assertMermaidShape(toMermaid(ir).mermaid, ir.title);
  for (const name of FIXTURE_NAMES) assertMermaidShape(toMermaid(convertMermaid(readFixture(name)).ir).mermaid, name);
  for (const ir of SEQUENCE_EXAMPLES) assertMermaidShape(toMermaid(ir).mermaid, `sequence ${ir.title}`);
});
