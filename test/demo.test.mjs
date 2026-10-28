import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  exampleFiles,
  makeStubProject,
  minimalArchitecture,
  minimalSequence,
  parseJsonStdout,
  pipelineReady,
  runCli,
  runEntry,
} from "./helpers.mjs";

const scratch = path.join("/tmp/cli-test", "demo");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

test("demo renders every examples/*.json in the project (stub pipeline)", () => {
  const project = makeStubProject("demo-stub", {
    examples: {
      "architecture.json": minimalArchitecture(),
      "sequence.json": minimalSequence(),
    },
  });
  const outdir = path.join(project.dir, "site");
  const run = runEntry(project.cli, ["demo", outdir, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.count, 2);
  assert.equal(receipt.outdir, outdir);
  assert.equal(receipt.files.length, 2);

  for (const fileName of ["architecture.html", "sequence.html"]) {
    const file = path.join(outdir, fileName);
    assert.equal(fs.existsSync(file), true, `${fileName} should exist`);
    assert.ok(fs.statSync(file).size > 0, `${fileName} should not be empty`);
  }
  assert.match(fs.readFileSync(path.join(outdir, "architecture.html"), "utf8"), /Checkout service map/);
  assert.match(fs.readFileSync(path.join(outdir, "sequence.html"), "utf8"), /Login handshake/);

  const humanRun = runEntry(project.cli, ["demo", path.join(project.dir, "site2")]);
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, /^ok\s+/m);
  assert.match(humanRun.stdout, /demo: 2 example\(s\) rendered into /);
});

test("demo with no examples in the project exits 1 with cli/no-examples", () => {
  const project = makeStubProject("demo-empty", {});
  assert.equal(fs.existsSync(project.examplesDir), false, "fixture setup: no examples dir");
  const run = runEntry(project.cli, ["demo", path.join(project.dir, "site"), "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.errors[0].code, "cli/no-examples");
  assert.match(receipt.errors[0].hint, /examples\/\*\.json/);
});

test("demo reports which example failed and still exits 1 (stub pipeline)", () => {
  const broken = minimalArchitecture();
  delete broken.title;
  const project = makeStubProject("demo-broken", {
    examples: {
      "good.json": minimalSequence(),
      "bad.json": broken,
    },
  });
  const run = runEntry(project.cli, ["demo", path.join(project.dir, "site"), "--json"]);
  assert.equal(run.status, 1);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.errors.length > 0);
  assert.equal(receipt.errors[0].code, "ir/required");
  const byName = new Map(receipt.files.map((file) => [path.basename(file.input), file]));
  assert.ok(byName.get("good.json").ok !== false, "the valid example should still render");
  assert.equal(byName.get("bad.json").ok, false);
  assert.equal(fs.existsSync(path.join(project.dir, "site", "good.html")), true);
  assert.equal(fs.existsSync(path.join(project.dir, "site", "bad.html")), false);
});

test("demo with real examples renders every file when the pipeline is ready", (t) => {
  const files = exampleFiles();
  if (!pipelineReady) {
    t.skip("render pipeline not ready (src/layout/index.mjs and/or src/view/compose.mjs missing) — real demo skipped");
    return;
  }
  if (files.length === 0) {
    t.skip("examples/ is empty — lead is writing fixtures in parallel");
    return;
  }
  const outdir = path.join(scratch, "real");
  fs.rmSync(outdir, { recursive: true, force: true });

  const run = runCli(["demo", outdir, "--json"]);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const receipt = parseJsonStdout(run);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.count, files.length);
  assert.equal(receipt.files.length, files.length);

  for (const file of files) {
    const expected = path.join(outdir, `${path.basename(file, ".json")}.html`);
    assert.equal(fs.existsSync(expected), true, `${expected} should exist`);
    assert.ok(fs.statSync(expected).size > 0, `${expected} should not be empty`);
  }

  for (const file of files) {
    const validated = runCli(["validate", file, "--json"]);
    assert.equal(validated.status, 0, `${path.basename(file)}: ${validated.stdout}${validated.stderr}`);
    const validatorReceipt = parseJsonStdout(validated);
    assert.equal(validatorReceipt.ok, true);
  }
});
