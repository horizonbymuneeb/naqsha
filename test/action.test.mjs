// The GitHub Action's renderer, exercised in a throwaway git repo.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, mkScratch, minimalArchitecture, pipelineReady, writeJsonFile } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "scripts", "ci-render.mjs");
const CLI = path.join(ROOT, "src", "cli", "naqsha.mjs");

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function runScript(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir()}:${process.env.PATH}` },
  });
}

let shim = null;
function shimDir() {
  if (shim !== null) return shim;
  shim = path.join(mkScratch("shim"), "bin");
  fs.mkdirSync(shim, { recursive: true });
  const target = path.join(shim, "naqsha");
  fs.writeFileSync(target, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return shim;
}

function makeRepo() {
  const dir = mkScratch("action");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "ci@example.com"]);
  git(dir, ["config", "user.name", "CI"]);
  writeJsonFile(path.join(dir, "one.naqsha.json"), minimalArchitecture());
  writeJsonFile(path.join(dir, "nested", "two.naqsha.json"), {
    ...minimalArchitecture(),
    title: "Second",
  });
  return dir;
}

test("ci-render: renders every matched diagram", { skip: !pipelineReady }, () => {
  const dir = makeRepo();
  const run = runScript(dir, ["--input", "**/*.naqsha.json", "--out-dir", "out", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout.trim().split("\n").pop());
  assert.equal(receipt.rendered, 2);
  assert.equal(receipt.failed, 0);
  assert.ok(fs.existsSync(path.join(dir, "out", "one.html")));
  assert.ok(fs.existsSync(path.join(dir, "out", "two.html")));
});

test("ci-render: --check passes on a clean tree and fails when a diagram is stale", { skip: !pipelineReady }, () => {
  const dir = makeRepo();
  assert.equal(runScript(dir, ["--input", "**/*.naqsha.json", "--out-dir", "out"]).status, 0);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "rendered"]);

  const clean = runScript(dir, ["--input", "**/*.naqsha.json", "--out-dir", "out", "--check"]);
  assert.equal(clean.status, 0, clean.stderr);

  const dark = runScript(dir, ["--input", "**/*.naqsha.json", "--out-dir", "out", "--check", "--mode", "dark"]);
  assert.equal(dark.status, 1);
  assert.match(dark.stderr, /stale/);
});

test("ci-render: lint failures fail the run", { skip: !pipelineReady }, () => {
  const dir = makeRepo();
  writeJsonFile(path.join(dir, "broken.naqsha.json"), {
    title: "Broken",
    type: "architecture",
    nodes: [
      { id: "a", label: "A", kind: "service" },
      { id: "a", label: "A again", kind: "service" },
    ],
    edges: [{ from: "a", to: "a", label: "loop", kind: "main" }],
  });
  const run = runScript(dir, ["--input", "broken.naqsha.json", "--out-dir", "out", "--lint", "--json"]);
  assert.equal(run.status, 1);
  const receipt = JSON.parse(run.stdout.trim().split("\n").pop());
  assert.equal(receipt.failed, 1);
  assert.match(receipt.results[0].errors.join("\n"), /lint\/duplicate-id/);
});

test("ci-render: an empty glob is a usage error", () => {
  const dir = makeRepo();
  const run = runScript(dir, ["--input", "nothing/*.json", "--out-dir", "out"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no input files matched/);
});

test("action metadata: action.yml is a composite action with the documented inputs", () => {
  const text = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
  assert.match(text, /using:\s*"composite"/);
  for (const input of ["input", "out-dir", "mode", "lint", "check", "commit", "version"]) {
    assert.match(text, new RegExp(`\\n\\s{2}${input}:`), `action.yml is missing the ${input} input`);
  }
  assert.match(text, /ci-render\.mjs/);
});
