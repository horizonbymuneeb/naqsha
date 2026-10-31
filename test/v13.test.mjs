// Lint, schema, export and serve — the v1.3 surface.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  ROOT,
  findChrome,
  looksLikeStackTrace,
  minimalArchitecture,
  mkScratch,
  parseJsonStdout,
  pipelineReady,
  runCli,
  writeJsonFile,
} from "./helpers.mjs";

const scratch = mkScratch("v13");

const cleanPath = writeJsonFile(path.join(scratch, "clean.json"), {
  title: "Clean",
  type: "workflow",
  nodes: [
    { id: "a", label: "Start", kind: "compute" },
    { id: "b", label: "Middle", kind: "compute" },
    { id: "c", label: "End", kind: "state" },
  ],
  edges: [
    { from: "a", to: "b", label: "next", kind: "main" },
    { from: "b", to: "c", label: "done", kind: "main" },
  ],
});

const messyPath = writeJsonFile(path.join(scratch, "messy.json"), {
  title: "Messy",
  type: "workflow",
  nodes: [
    { id: "a", label: "A", kind: "compute" },
    { id: "a", label: "A again", kind: "compute" },
    { id: "b", kind: "compute" },
    { id: "island", label: "Nobody links me", kind: "state" },
    { id: "snake_case_id", label: "snake_case_id", kind: "state" },
  ],
  edges: [
    { from: "a", to: "ghost", kind: "main" },
    { from: "a", to: "a", kind: "main" },
  ],
});

// ---------------------------------------------------------------- lint ----

test("lint: a clean diagram exits 0 and reports nothing", () => {
  const run = runCli(["lint", cleanPath]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /clean — nothing to fix/);
  assert.equal(looksLikeStackTrace(run.stderr), false);
});

test("lint: duplicate ids and dangling edges are errors", () => {
  const run = runCli(["lint", messyPath, "--json"]);
  assert.equal(run.status, 1);
  const payload = parseJsonStdout(run);
  assert.equal(payload.ok, false);
  const codes = payload.errors.map((error) => error.code);
  assert.ok(codes.includes("lint/duplicate-id"), codes.join(","));
  assert.ok(codes.includes("lint/dangling-edge"), codes.join(","));
});

test("lint: advisory findings are warnings, not errors", () => {
  const payload = parseJsonStdout(runCli(["lint", messyPath, "--json"]));
  const codes = payload.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("lint/self-loop"), codes.join(","));
  assert.ok(codes.includes("lint/unlabeled-node"), codes.join(","));
  assert.ok(codes.includes("lint/orphan-node"), codes.join(","));
  assert.ok(codes.includes("lint/label-is-id"), codes.join(","));
});

test("lint: --strict fails on warnings for an otherwise valid diagram", () => {
  const warningOnly = writeJsonFile(path.join(scratch, "warning-only.json"), {
    title: "Warning only",
    type: "architecture",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
      { id: "orphan", label: "Orphan", kind: "service" },
    ],
    edges: [{ from: "a", to: "b", label: "calls", kind: "main" }],
  });
  assert.equal(runCli(["lint", warningOnly]).status, 0);
  assert.equal(runCli(["lint", warningOnly, "--strict"]).status, 1);
});

test("lint: --max-nodes lowers the readability ceiling", () => {
  const payload = parseJsonStdout(runCli(["lint", cleanPath, "--max-nodes", "2", "--json"]));
  assert.ok(payload.warnings.some((warning) => warning.code === "lint/too-many-nodes"));
});

test("lint: cycles are flagged for workflow diagrams only", () => {
  const cyclic = writeJsonFile(path.join(scratch, "cyclic.json"), {
    title: "Cycle",
    type: "workflow",
    nodes: [
      { id: "a", label: "A", kind: "compute" },
      { id: "b", label: "B", kind: "compute" },
    ],
    edges: [
      { from: "a", to: "b", label: "go", kind: "main" },
      { from: "b", to: "a", label: "back", kind: "main" },
    ],
  });
  const workflow = parseJsonStdout(runCli(["lint", cyclic, "--json"]));
  assert.ok(workflow.warnings.some((warning) => warning.code === "lint/cycle"));

  const architecture = { ...JSON.parse(fs.readFileSync(cyclic, "utf8")), type: "architecture" };
  const architecturePath = writeJsonFile(path.join(scratch, "cycle-arch.json"), architecture);
  const arch = parseJsonStdout(runCli(["lint", architecturePath, "--json"]));
  assert.equal(arch.warnings.some((warning) => warning.code === "lint/cycle"), false);
});

test("lint: missing input is a clean failure, not a stack trace", () => {
  const run = runCli(["lint", path.join(scratch, "nope.json"), "--json"]);
  assert.equal(run.status, 1);
  assert.equal(looksLikeStackTrace(run.stderr), false);
  const payload = parseJsonStdout(run);
  assert.equal(payload.ok, false);
});

// -------------------------------------------------------------- schema ----

test("schema: prints the bundled IR schema", () => {
  const run = runCli(["schema"]);
  assert.equal(run.status, 0, run.stderr);
  const schema = JSON.parse(run.stdout);
  assert.match(schema.$schema, /json-schema\.org/);
  assert.match(schema.$id, /naqsha/);
  assert.ok(schema.properties.nodes);
});

test("schema: --out writes the same document", () => {
  const target = path.join(scratch, "ir.schema.json");
  const run = runCli(["schema", "--out", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), JSON.parse(runCli(["schema"]).stdout));
});

// -------------------------------------------------------------- export ----

test("export: unknown output extension still defaults to SVG", { skip: !pipelineReady }, () => {
  const chrome = findChrome();
  if (!chrome) {
    const run = runCli(["export", cleanPath, path.join(scratch, "out.svg")]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no usable Chrome/i);
    return;
  }
  const target = path.join(scratch, "diagram.export.svg");
  const run = runCli(["export", cleanPath, target]);
  assert.equal(run.status, 0, run.stderr);
  const svg = fs.readFileSync(target, "utf8");
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<svg/);
  assert.match(svg, /class="node/);
  assert.match(svg, /<\/svg>\s*$/);
});

// --------------------------------------------------------------- serve ----

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("serve: renders, reports health and exposes a revision", { skip: !pipelineReady, timeout: 30000 }, async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(ROOT, "src/cli/naqsha.mjs"), "serve", cleanPath, "--port", "0", "--json", "--no-watch"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const payload = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("serve did not announce a URL in time")), 20000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
      child.on("error", reject);
    });

    assert.equal(payload.ok, true);
    assert.ok(payload.port > 0);

    const page = await get(`http://127.0.0.1:${payload.port}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<!doctype html>/i);

    const health = await get(`http://127.0.0.1:${payload.port}/healthz`);
    assert.equal(health.body.trim(), "ok");

    const revision = await get(`http://127.0.0.1:${payload.port}/__naqsha/rev`);
    assert.match(revision.body.trim(), /^\d+$/);

    const missing = await get(`http://127.0.0.1:${payload.port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill("SIGTERM");
  }
});

// ------------------------------------------------------------- viewer ----

test("viewer: shipped HTML exposes the new UI hooks", { skip: !pipelineReady }, () => {
  const target = path.join(scratch, "ui.html");
  const run = runCli(["render", cleanPath, target]);
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(target, "utf8");
  assert.match(html, /id="minimap-toggle"/);
  assert.match(html, /id="copy-png"/);
  assert.match(html, /minimap on or off/);
  assert.match(html, /Copy PNG to clipboard/);
});
