import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  DIAGRAM_TYPES,
  DIRECTIONS,
  NODE_KINDS,
  EDGE_KINDS,
  GROUP_KINDS,
  ID_PATTERN,
  LIMITS,
} from "../src/validate/index.mjs";
import { ROOT } from "./helpers.mjs";

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "validate", "schema.json"), "utf8"));

test("schema is draft 2020-12 JSON Schema for IR v1", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://naqsha.dev/schema/ir-v1.json");
  assert.equal(schema.title, "Naqsha IR v1");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["title", "type", "nodes"]);
});

test("root limits and enums match the validator constants", () => {
  assert.deepEqual(schema.properties.type.enum, [...DIAGRAM_TYPES]);
  assert.deepEqual(schema.properties.direction.enum, [...DIRECTIONS]);
  assert.equal(schema.properties.direction.default, "TB");

  assert.equal(schema.properties.title.minLength, LIMITS.titleMin);
  assert.equal(schema.properties.title.maxLength, LIMITS.titleMax);
  assert.equal(schema.properties.subtitle.maxLength, LIMITS.subtitleMax);

  assert.equal(schema.properties.nodes.minItems, LIMITS.nodesMin);
  assert.equal(schema.properties.nodes.maxItems, LIMITS.nodesMax);
  assert.equal(schema.properties.edges.maxItems, LIMITS.edgesMax);
  assert.equal(schema.properties.notes.maxItems, LIMITS.notesMax);
  assert.equal(schema.properties.notes.items.maxLength, LIMITS.noteMax);
});

test("id pattern is identical in schema and validator", () => {
  assert.equal(schema.$defs.id.pattern, ID_PATTERN);
  const schemaRegex = new RegExp(schema.$defs.id.pattern);
  for (const id of ["a", "web", "api-gateway", "n0"]) assert.ok(schemaRegex.test(id), `${id} should match`);
  for (const id of ["Web", "1web", "web_api", "web."]) assert.equal(schemaRegex.test(id), false, `${id} should not match`);
});

test("node definition matches the contract", () => {
  const node = schema.$defs.node;
  assert.equal(node.type, "object");
  assert.equal(node.additionalProperties, false);
  // kind is required for the legacy types and optional for the v1.2 families
  assert.deepEqual(node.required, ["id", "label"]);
  assert.deepEqual(node.properties.kind.enum, [...NODE_KINDS]);
  assert.equal(node.properties.label.maxLength, LIMITS.nodeLabelMax);
  assert.equal(node.properties.id.$ref, "#/$defs/id");
  assert.deepEqual(Object.keys(node.properties).sort(), ["at", "attributes", "duration", "group", "id", "kind", "label", "lane", "members", "role", "stage", "start", "stereotype", "sublabel"]);
});

test("edge definition matches the contract", () => {
  const edge = schema.$defs.edge;
  assert.equal(edge.additionalProperties, false);
  assert.deepEqual(edge.required, ["from", "to"]);
  assert.deepEqual(edge.properties.kind.enum, [...EDGE_KINDS]);
  assert.equal(edge.properties.label.type, "string");
  assert.deepEqual(Object.keys(edge.properties).sort(), ["cardinality", "from", "kind", "label", "to"]);
});

test("group definition matches the contract (zone | boundary | fragment)", () => {
  const group = schema.$defs.group;
  assert.equal(group.additionalProperties, false);
  assert.deepEqual(group.required, ["id", "label", "nodes"]);
  assert.deepEqual(group.properties.kind.enum, [...GROUP_KINDS]);
  assert.equal(group.properties.kind.default, "zone");
  assert.equal(group.properties.nodes.minItems, 1);
  assert.deepEqual(Object.keys(group.properties).sort(), ["id", "kind", "label", "nodes"]);
});

test("schema encodes the fragment-only-for-sequence rule", () => {
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
  const rule = schema.allOf[0];
  assert.equal(rule.if.properties.type.not.const, "sequence");
  assert.equal(rule.then.properties.groups.items.properties.kind.not.const, "fragment");
});

test("schema parses as JSON and has no $ref that points outside itself", () => {
  const refs = [];
  const walk = (value) => {
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string") refs.push(value.$ref);
    for (const child of Object.values(value)) walk(child);
  };
  walk(schema);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(ref.startsWith("#/$defs/"), `unexpected $ref ${ref}`);
    const name = ref.slice("#/$defs/".length);
    assert.ok(schema.$defs[name], `$ref ${ref} does not resolve`);
  }
});
