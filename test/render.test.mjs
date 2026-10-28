import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  exampleFiles,
  looksLikeStackTrace,
  makeStubProject,
  minimalArchitecture,
  minimalSequence,
  parseJsonStdout,
  pipelineReady,
  runCli,
  runEntry,
  validIrFor,
} from "./helpers.mjs";

const scratch = path.join("/tmp/cli-test", "render");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const stub = makeStubProject("render-stub", {
  examples: {
    "architecture.json": minimalArchitecture(),
    "sequence.json": minimalSequence(),
  },
});
const architecturePath = path.join(stub.examplesDir, "architecture.json");

function readExampleHtml(file) {
  return fs.readFileSync(file, "utf8");
}

test("render --json: atomic write + exact receipt shape (stub pipeline)", () => {
  const output = path.join(stub.dir, "architecture.html");
  const run = runEntry(stub.cli, ["render", architecturePath, output, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1, "receipt must be one JSON line");
  const receipt = parseJsonStdout(run);
  assert.deepEqual(Object.keys(receipt).sort(), ["bytes", "edges", "input", "nodes", "ok", "output"]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.input, architecturePath);
  assert.equal(receipt.output, output);
  assert.equal(receipt.nodes, 2);
  assert.equal(receipt.edges, 1);

  const html = readExampleHtml(output);
  assert.equal(receipt.bytes, Buffer.byteLength(html));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Checkout service map/);

  const tempLeftovers = fs.readdirSync(stub.dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(tempLeftovers, [], "atomic write must not leave temp files behind");
});

test("render human output reports the output path and counts", () => {
  const output = path.join(stub.dir, "human.html");
  const run = runEntry(stub.cli, ["render", architecturePath, output]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^rendered /);
  assert.match(run.stdout, /architecture\.json -> /);
  assert.match(run.stdout, /bytes, 2 nodes, 1 edges/);
});

test("render --mode reaches compose (light/dark/auto)", () => {
  for (const mode of ["light", "dark", "auto"]) {
    const output = path.join(stub.dir, `mode-${mode}.html`);
    const run = runEntry(stub.cli, ["render", architecturePath, output, "--mode", mode]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(readExampleHtml(output), new RegExp(`data-mode="${mode}"`));
  }
});

test("render is deterministic: two runs are byte-identical", () => {
  const first = path.join(stub.dir, "det-a.html");
  const second = path.join(stub.dir, "det-b.html");
  assert.equal(runEntry(stub.cli, ["render", architecturePath, first]).status, 0);
  assert.equal(runEntry(stub.cli, ["render", architecturePath, second]).status, 0);
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
});

test("render failure on invalid IR: exit 1, validator shape, no output file", () => {
  const broken = minimalArchitecture();
  delete broken.title;
  const brokenPath = path.join(stub.examplesDir, "broken.json");
  fs.writeFileSync(brokenPath, JSON.stringify(broken));
  const output = path.join(stub.dir, "never.html");

  const run = runEntry(stub.cli, ["render", brokenPath, output, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.errors[0].code, "ir/required");
  assert.deepEqual(Object.keys(receipt.errors[0]).sort(), ["code", "hint", "message", "path"]);
  assert.equal(fs.existsSync(output), false, "invalid IR must not produce an HTML file");

  const humanRun = runEntry(stub.cli, ["render", brokenPath, output]);
  assert.equal(humanRun.status, 1);
  assert.match(humanRun.stderr, /error ir\/required/);
  assert.equal(fs.existsSync(output), false);
});

test("render failure on invalid JSON: ir/json-syntax, exit 1", () => {
  const brokenPath = path.join(stub.examplesDir, "bad-json.json");
  fs.writeFileSync(brokenPath, "{ not json ");
  const output = path.join(stub.dir, "bad.html");
  const run = runEntry(stub.cli, ["render", brokenPath, output, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.errors[0].code, "ir/json-syntax");
  assert.equal(fs.existsSync(output), false);
});

test("render refuses a missing output directory (does not create it)", () => {
  const output = path.join(stub.dir, "not-created", "nested", "out.html");
  const run = runEntry(stub.cli, ["render", architecturePath, output, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.errors[0].code, "cli/output-dir");
  assert.equal(fs.existsSync(path.dirname(output)), false, "render must not create directories outside the requested file");
});

test("render pipeline not ready: missing layout prints one clear line and exits 2", () => {
  const project = makeStubProject("render-no-layout", {
    withLayout: false,
    withCompose: true,
    examples: { "valid.json": validIrFor("architecture") },
  });
  const output = path.join(project.dir, "out.html");
  const run = runEntry(project.cli, ["render", path.join(project.examplesDir, "valid.json"), output]);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /^render pipeline not ready: src\/layout\/index\.mjs$/m);
  assert.equal(looksLikeStackTrace(run.stderr), false);
  assert.equal(run.stdout.trim(), "");
  assert.equal(fs.existsSync(output), false);
});

test("render pipeline not ready: missing compose prints one clear line and exits 2", () => {
  const project = makeStubProject("render-no-compose", {
    withLayout: true,
    withCompose: false,
    examples: { "valid.json": validIrFor("workflow") },
  });
  const output = path.join(project.dir, "out.html");
  const run = runEntry(project.cli, ["render", path.join(project.examplesDir, "valid.json"), output]);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /^render pipeline not ready: src\/view\/compose\.mjs$/m);
  assert.equal(looksLikeStackTrace(run.stderr), false);
  assert.equal(fs.existsSync(output), false);
});

test("real pipeline: every examples/*.json renders to <=140KB deterministic HTML", (t) => {
  const files = exampleFiles();
  if (!pipelineReady) {
    t.skip("render pending: src/layout/index.mjs and/or src/view/compose.mjs do not exist yet (parallel writers)");
    return;
  }
  if (files.length === 0) {
    t.skip("examples/ is empty — lead is writing fixtures in parallel");
    return;
  }
  const outputDirectory = path.join(scratch, "real");
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });

  for (const file of files) {
    const base = path.basename(file, ".json");
    const first = path.join(outputDirectory, `${base}.html`);
    const second = path.join(outputDirectory, `${base}.again.html`);

    const run = runCli(["render", file, first, "--json"]);
    assert.equal(run.status, 0, `${base}: ${run.stdout}${run.stderr}`);
    const receipt = parseJsonStdout(run);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.output, first);
    assert.ok(receipt.nodes > 0, `${base}: nodes should be > 0`);
    assert.ok(receipt.edges >= 0);

    const stats = fs.statSync(first);
    assert.equal(receipt.bytes, stats.size);
    assert.ok(stats.size > 0, `${base}: output is empty`);
    assert.ok(stats.size <= 140 * 1024, `${base}: HTML is ${stats.size} bytes, contract cap is 140 KB`);

    const html = fs.readFileSync(first, "utf8");
    assert.match(html, /^\s*<(!doctype|html)/i, `${base}: output should be an HTML document`);

    const again = runCli(["render", file, second, "--json"]);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second), `${base}: render must be byte-identical across runs`);
    assert.ok(ROOT.length > 0);
  }
});

test("real pipeline: invalid IR still fails before rendering", (t) => {
  if (!pipelineReady) {
    t.skip("render pending: layout/view modules do not exist yet (parallel writers)");
    return;
  }
  const brokenPath = path.join(scratch, "real-broken.json");
  fs.writeFileSync(brokenPath, JSON.stringify({ title: "Broken", type: "architecture", nodes: [] }));
  const output = path.join(scratch, "real-broken.html");
  const run = runCli(["render", brokenPath, output, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.errors[0].code, "ir/nodes-count");
  assert.equal(fs.existsSync(output), false);
});
