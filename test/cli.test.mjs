import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  CLI,
  ROOT,
  exampleFiles,
  findChrome,
  looksLikeStackTrace,
  makeStubProject,
  minimalArchitecture,
  mkScratch,
  parseJsonStdout,
  pipelineReady,
  runCli,
  runEntry,
  validIrFor,
  writeJsonFile,
} from "./helpers.mjs";

const scratch = mkScratch("cli");
const validPath = writeJsonFile(path.join(scratch, "valid.architecture.json"), minimalArchitecture());

const invalidIr = minimalArchitecture();
delete invalidIr.title;
const invalidPath = writeJsonFile(path.join(scratch, "invalid.json"), invalidIr);

const syntaxPath = path.join(scratch, "bad-syntax.json");
fs.writeFileSync(syntaxPath, '{\n  "title": "Broken",\n  "type": "architecture",\n  "nodes": [\n');
const missingPath = path.join(scratch, "does-not-exist.json");
const rejectedChrome = "/usr/bin/chromium-browser";

test("validate: valid IR exits 0 with human output", () => {
  const run = runCli(["validate", validPath]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^valid /);
  assert.match(run.stdout, /2 node\(s\), 1 edge\(s\)/);
});

test("validate --json: one JSON receipt with ok/input/nodes/edges/warnings", () => {
  const run = runCli(["validate", validPath, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(looksLikeStackTrace(run.stderr), false);
  const receipt = parseJsonStdout(run);
  assert.deepEqual(Object.keys(receipt).sort(), ["edges", "errors", "input", "nodes", "ok", "warnings"]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.input, validPath);
  assert.equal(receipt.nodes, 2);
  assert.equal(receipt.edges, 1);
  assert.deepEqual(receipt.errors, []);
  assert.ok(Array.isArray(receipt.warnings));
});

test("validate: broken IR exits 1 with code/path/hint in human output", () => {
  const run = runCli(["validate", invalidPath]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /error ir\/required/);
  assert.match(run.stderr, /hint:/);
  assert.match(run.stderr, /invalid /);
});

test("validate --json: broken IR exits 1 with the exact validator error shape", () => {
  const run = runCli(["validate", invalidPath, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.errors.length > 0, true);
  const [first] = receipt.errors;
  assert.deepEqual(Object.keys(first).sort(), ["code", "hint", "message", "path"]);
  assert.equal(first.code, "ir/required");
  assert.equal(first.path, "title");
  assert.match(first.hint, /title/);
  assert.ok(Array.isArray(receipt.warnings));
});

test("validate: missing input file exits 1 with cli/file-missing", () => {
  const run = runCli(["validate", missingPath, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.errors[0].code, "cli/file-missing");
  assert.match(receipt.errors[0].hint, /JSON IR file/);
});

test("validate: JSON syntax error exits 1 with ir/json-syntax and a strict-JSON hint", () => {
  const run = runCli(["validate", syntaxPath, "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.errors[0].code, "ir/json-syntax");
  assert.match(receipt.errors[0].message, /invalid JSON/);
  assert.match(receipt.errors[0].hint, /strict JSON/);
});

test("validate: every examples/*.json exits 0 when examples exist", (t) => {
  const files = exampleFiles();
  if (files.length === 0) {
    t.skip("examples/ is empty — lead is writing fixtures in parallel");
    return;
  }
  for (const file of files) {
    const run = runCli(["validate", file, "--json"]);
    assert.equal(run.status, 0, `${path.basename(file)}: ${run.stdout}${run.stderr}`);
    const receipt = parseJsonStdout(run);
    assert.equal(receipt.ok, true, `${path.basename(file)}: ${JSON.stringify(receipt.errors)}`);
  }
});

test("usage errors exit 2 (never 1) with a usage line", () => {
  const cases = [
    { name: "no command", args: [], pattern: /Usage:/ },
    { name: "unknown command", args: ["frobnicate"], pattern: /unknown command "frobnicate"/ },
    { name: "validate without file", args: ["validate"], pattern: /missing argument/ },
    { name: "validate too many args", args: ["validate", "a.json", "b.json"], pattern: /too many arguments/ },
    { name: "render without output", args: ["render", "a.json"], pattern: /missing argument/ },
    { name: "bad mode value", args: ["render", "a.json", "b.html", "--mode", "neon"], pattern: /--mode must be one of/ },
    { name: "bad screenshot width", args: ["screenshot", "a.html", "b.png", "--width", "tiny"], pattern: /--width must be an integer/ },
    { name: "unknown flag", args: ["validate", "a.json", "--banana"], pattern: /unknown option "--banana"/ },
    { name: "unknown short flag", args: ["doctor", "-x"], pattern: /unknown option "-x"/ },
  ];
  for (const testCase of cases) {
    const run = runCli(testCase.args);
    assert.equal(run.status, 2, `${testCase.name}: expected exit 2, got ${run.status} (stderr: ${run.stderr})`);
    assert.match(run.stderr, testCase.pattern, `${testCase.name}: stderr ${JSON.stringify(run.stderr)}`);
    assert.match(run.stderr, /Usage:/, `${testCase.name}: should print the usage block`);
    assert.equal(looksLikeStackTrace(run.stderr), false, `${testCase.name}: should not print a stack trace`);
  }
});

test("--help exits 0", () => {
  const run = runCli(["--help"]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /naqsha validate/);
});

test("doctor output is stack-trace free even when the pipeline is not ready (stub project)", () => {
  const project = makeStubProject("doctor-stub", { withLayout: false, withCompose: false });
  const run = runEntry(project.cli, ["doctor", "--json"]);
  assert.equal(run.status, 1);
  assert.equal(looksLikeStackTrace(run.stderr), false, run.stderr);
  const receipt = parseJsonStdout(run);
  assert.deepEqual(receipt.checks.map((check) => check.name), ["node", "chrome", "modules", "render"]);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.checks[0].ok, true);
  assert.equal(receipt.checks[2].ok, false);
  assert.match(receipt.checks[2].detail, /src\/layout\/index\.mjs missing/);
  assert.match(receipt.checks[2].detail, /src\/view\/compose\.mjs missing/);
  assert.equal(receipt.checks[3].ok, false);
});

test("doctor on the real project reports node/chrome/modules/render truthfully", () => {
  const chrome = findChrome();
  const env = chrome ? { NAQSHA_CHROME: chrome } : {};
  const run = runCli(["doctor", "--json"], { env });
  assert.equal(looksLikeStackTrace(run.stderr), false, run.stderr);
  const receipt = parseJsonStdout(run);
  assert.deepEqual(receipt.checks.map((check) => check.name), ["node", "chrome", "modules", "render"]);
  assert.equal(receipt.checks[0].ok, true);
  assert.equal(receipt.checks[1].ok, Boolean(chrome), `chrome check: ${receipt.checks[1].detail}`);
  assert.equal(receipt.checks[2].ok, pipelineReady, `modules check: ${receipt.checks[2].detail}`);
  assert.equal(receipt.checks[3].ok, pipelineReady, `render check: ${receipt.checks[3].detail}`);
  assert.equal(receipt.ok, pipelineReady && Boolean(chrome));
  assert.equal(run.status, receipt.ok ? 0 : 1);
  if (pipelineReady && chrome) {
    assert.match(receipt.checks[3].detail, /bytes, 2 nodes, 1 edges/);
  }
});

test("doctor never accepts /usr/bin/chromium-browser as the chrome binary", () => {
  const run = runCli(["doctor", "--json"], { env: { NAQSHA_CHROME: rejectedChrome } });
  const receipt = parseJsonStdout(run);
  const chromeCheck = receipt.checks.find((check) => check.name === "chrome");
  assert.ok(chromeCheck);
  if (chromeCheck.ok) {
    assert.notEqual(receipt.chrome, rejectedChrome, "the snap shim must never be accepted");
    assert.notEqual(receipt.chrome, path.resolve(rejectedChrome));
  } else {
    assert.match(chromeCheck.detail, /snap shim|not an executable|not found/);
  }
});

test("screenshot: missing html exits 1 with cli/file-missing", () => {
  const run = runCli(["screenshot", path.join(scratch, "missing.html"), path.join(scratch, "out.png"), "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.errors[0].code, "cli/file-missing");
});

test("screenshot: renders a real PNG with the contract's chrome flags", (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip("no Chrome/Chromium available on this box — screenshot test skipped (set NAQSHA_CHROME)");
    return;
  }
  const project = makeStubProject("screenshot", { examples: { "example.json": validIrFor("workflow") } });
  const htmlPath = path.join(project.dir, "out.html");
  const renderRun = runEntry(project.cli, ["render", path.join(project.examplesDir, "example.json"), htmlPath]);
  assert.equal(renderRun.status, 0, renderRun.stderr);

  const pngPath = path.join(project.dir, "out.png");
  const run = runEntry(project.cli, ["screenshot", htmlPath, pngPath, "--width", "390", "--height", "844", "--json"], {
    env: { NAQSHA_CHROME: chrome },
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.width, 390);
  assert.equal(receipt.height, 844);
  assert.equal(receipt.html, htmlPath);
  assert.equal(receipt.output, pngPath);

  const png = fs.readFileSync(pngPath);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "output must be a PNG");
  assert.ok(png.length > 1000, `PNG is suspiciously small: ${png.length} bytes`);
  assert.equal(receipt.bytes, png.length);
  // The rename is synchronous, but a slow CI filesystem can expose the rename to
  // a reader a beat later; poll briefly instead of failing on one sample.
  let leftovers = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    leftovers = fs.readdirSync(project.dir).filter((name) => name.includes(".naqsha-screenshot."));
    if (leftovers.length === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.deepEqual(leftovers, [], `temp screenshot must be renamed away (left: ${leftovers.join(", ")})`);
});

test("screenshot works on the real pipeline when it is ready", (t) => {
  const chrome = findChrome();
  const files = exampleFiles();
  if (!pipelineReady || files.length === 0) {
    t.skip("render pipeline not ready yet (layout/view pending) — screenshot-on-example skipped");
    return;
  }
  if (!chrome) {
    t.skip("no Chrome/Chromium available — screenshot-on-example skipped");
    return;
  }
  const dir = path.join(scratch, "real-screenshot");
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "example.html");
  const renderRun = runCli(["render", files[0], htmlPath, "--json"]);
  assert.equal(renderRun.status, 0, renderRun.stderr);
  const pngPath = path.join(dir, "example.png");
  const run = runCli(["screenshot", htmlPath, pngPath, "--json"], { env: { NAQSHA_CHROME: chrome } });
  assert.equal(run.status, 0, run.stderr);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, true);
  assert.ok(fs.statSync(pngPath).size > 1000);
  assert.equal(ROOT.startsWith("/"), true);
});
