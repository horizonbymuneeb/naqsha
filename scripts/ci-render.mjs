#!/usr/bin/env node
// Render a tree of Naqsha JSON diagrams in CI.
//
//   node scripts/ci-render.mjs --input "docs/**/*.json" --out-dir dist/diagrams \
//        [--mode auto|light|dark] [--lint] [--lint-strict] [--check] [--commit] [--json]
//
// --check   render, compare against the file on disk, and fail when it is stale.
// --commit  git add + commit the rendered files (needs a writable checkout).
//
// Zero dependencies; the only requirement is the `naqsha` CLI on PATH.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
};

const input = option("input", "docs/**/*.json");
const outDir = option("out-dir", "dist/diagrams");
const mode = option("mode", "auto");
const asJson = flag("json");
const doLint = flag("lint") || flag("lint-strict");
const strictLint = flag("lint-strict");
const check = flag("check");
const commit = flag("commit");

if (!["auto", "light", "dark"].includes(mode)) {
  console.error(`mode must be auto, light or dark (got "${mode}")`);
  process.exit(2);
}

// ---------------------------------------------------------------- globbing --

/** Minimal glob: `*`, `?`, `**`. Enough for CI inputs, no dependencies. */
const segmentPattern = (segment) =>
  new RegExp(
    "^" +
      segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );

function expand(pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/[*?]/.test(normalized)) {
    return fs.existsSync(normalized) && fs.statSync(normalized).isFile() ? [normalized] : [];
  }
  const segments = normalized.split("/");
  const results = [];

  const walk = (directory, index) => {
    if (index >= segments.length) {
      if (fs.existsSync(directory) && fs.statSync(directory).isFile()) results.push(directory);
      return;
    }
    const segment = segments[index];
    if (segment === "**") {
      walk(directory, index + 1);
      for (const entry of safeReaddir(directory)) {
        if (entry.isDirectory()) walk(path.join(directory, entry.name), index);
      }
      return;
    }
    const matcher = segmentPattern(segment);
    for (const entry of safeReaddir(directory)) {
      if (entry.name.startsWith(".")) continue;
      if (!matcher.test(entry.name)) continue;
      walk(path.join(directory, entry.name), index + 1);
    }
  };

  walk(".", 0);
  return results.map((file) => file.replace(/^\.\//, ""));
}

function safeReaddir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- drive --

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

const files = [...new Set(expand(input))].sort();
if (files.length === 0) {
  console.error(`no input files matched "${input}"`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const results = [];
let failed = 0;
let stale = 0;

for (const file of files) {
  const stem = path.basename(file).replace(/\.naqsha\.json$/i, "").replace(/\.json$/i, "");
  const target = path.join(outDir, `${stem}.html`);
  const entry = { input: file, output: target, ok: true, stale: false, lint: null, bytes: 0, errors: [] };

  if (doLint) {
    const lintArgs = ["lint", file, "--json"];
    if (strictLint) lintArgs.push("--strict");
    const lintRun = run("naqsha", lintArgs);
    let receipt = null;
    try {
      receipt = JSON.parse(lintRun.stdout || "{}");
    } catch {
      receipt = null;
    }
    entry.lint = receipt ? { errors: receipt.errors?.length ?? 0, warnings: receipt.warnings?.length ?? 0 } : null;
    if (lintRun.status !== 0) {
      entry.ok = false;
      entry.errors.push("lint failed");
      if (receipt) {
        for (const item of [...(receipt.errors || []), ...(receipt.warnings || [])]) {
          entry.errors.push(`${item.code}: ${item.message}`);
        }
      } else {
        entry.errors.push((lintRun.stderr || "").trim() || "lint failed");
      }
    }
  }

  if (entry.ok) {
    const renderRun = run("naqsha", ["render", file, target, "--mode", mode]);
    if (renderRun.status !== 0) {
      entry.ok = false;
      entry.errors.push((renderRun.stderr || "").trim() || "render failed");
    } else {
      entry.bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
      if (check) {
        // The file has just been overwritten; compare with the committed copy via git.
        const diffRun = run("git", ["diff", "--quiet", "--", target]);
        if (diffRun.status === 1) {
          entry.stale = true;
          stale += 1;
        }
      }
    }
  }

  if (!entry.ok) failed += 1;
  results.push(entry);
  if (!asJson) {
    const mark = !entry.ok ? "FAIL" : entry.stale ? "STALE" : "ok  ";
    const lintNote = entry.lint ? ` [lint ${entry.lint.errors}e/${entry.lint.warnings}w]` : "";
    console.log(`${mark}  ${file} -> ${target} (${entry.bytes} bytes)${lintNote}`);
    for (const error of entry.errors) console.log(`      ${error}`);
  }
}

if (commit && !check) {
  const changed = results.filter((result) => result.ok);
  if (changed.length > 0) {
    run("git", ["add", outDir]);
    const status = run("git", ["status", "--porcelain", "--", outDir]);
    if ((status.stdout || "").trim() !== "") {
      const commitRun = run("git", [
        "commit",
        "-m",
        `docs: re-render ${changed.length} diagram(s) with naqsha`,
      ]);
      if (commitRun.status !== 0) {
        console.error((commitRun.stderr || commitRun.stdout || "git commit failed").trim());
        failed += 1;
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: failed === 0 && stale === 0, rendered: results.length, failed, stale, results }));
}

if (check && stale > 0) {
  console.error(`\n${stale} diagram(s) are stale — run naqsha render and commit the result.`);
}
if (failed > 0) {
  console.error(`\n${failed} diagram(s) failed.`);
}

process.exit(failed > 0 || stale > 0 ? 1 : 0);
