// Shared test helpers for the Naqsha CLI/validator suites (owner: cli).
// Scratch space lives under /tmp/cli-test as agreed in the task brief.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli", "naqsha.mjs");
export const EXAMPLES_DIR = path.join(ROOT, "examples");
export const SCRATCH_ROOT = "/tmp/cli-test";

export const layoutReady = fs.existsSync(path.join(ROOT, "src", "layout", "index.mjs"));
export const composeReady = fs.existsSync(path.join(ROOT, "src", "view", "compose.mjs"));
export const pipelineReady = layoutReady && composeReady;

export function exampleFiles() {
  try {
    return fs
      .readdirSync(EXAMPLES_DIR)
      .filter((name) => /\.json$/i.test(name))
      .sort()
      .map((name) => path.join(EXAMPLES_DIR, name));
  } catch {
    return [];
  }
}

export function mkScratch(name) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

export function runEntry(entry, args, options = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

/** stdout must be one single JSON object — no banners, no second line. */
export function parseJsonStdout(run) {
  const text = run.stdout.trim();
  assert.notEqual(text, "", `expected JSON on stdout, got nothing (stderr: ${run.stderr.trim()})`);
  assert.equal(run.stdout.trim().split("\n").length, 1, `expected exactly one JSON line on stdout, got: ${text}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`stdout is not valid JSON: ${text}\n${error.message}`);
  }
}

/** True when stderr looks like an uncaught Node stack trace (we never want these). */
export function looksLikeStackTrace(text) {
  return /^\s+at .+:\d+:\d+\)?$/m.test(text);
}

// ---------------------------------------------------------------------------
// IR fixtures
// ---------------------------------------------------------------------------

export function minimalArchitecture() {
  return {
    title: "Checkout service map",
    type: "architecture",
    nodes: [
      { id: "web", label: "Web App", kind: "service" },
      { id: "db", label: "Database", kind: "datastore" },
    ],
    edges: [{ from: "web", to: "db", label: "query", kind: "main" }],
  };
}

export function minimalWorkflow() {
  return {
    title: "Deploy pipeline",
    type: "workflow",
    nodes: [
      { id: "build", label: "Build", kind: "compute" },
      { id: "ship", label: "Ship", kind: "state" },
    ],
    edges: [{ from: "build", to: "ship", label: "pass", kind: "main" }],
  };
}

export function minimalSequence() {
  return {
    title: "Login handshake",
    type: "sequence",
    nodes: [
      { id: "user", label: "User", kind: "actor" },
      { id: "auth", label: "Auth API", kind: "service" },
    ],
    edges: [{ from: "user", to: "auth", label: "POST /login", kind: "message" }],
  };
}

export function validIrFor(type) {
  if (type === "workflow") return minimalWorkflow();
  if (type === "sequence") return minimalSequence();
  if (type === "erd") {
    return { title: "ERD", type: "erd", nodes: [
      { id: "a", label: "a", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      { id: "b", label: "b", attributes: [{ name: "a_id", type: "uuid", key: "fk", ref: "a.id" }] },
    ], edges: [{ from: "a", to: "b", cardinality: "1:n" }] };
  }
  if (type === "class") {
    return { title: "Class", type: "class", nodes: [
      { id: "base", label: "Base", members: ["+ run(): void"] },
      { id: "impl", label: "Impl", stereotype: "class", members: ["+ run(): void"] },
    ], edges: [{ from: "impl", to: "base", kind: "extends" }] };
  }
  if (type === "tree") {
    return { title: "Tree", type: "tree", nodes: [
      { id: "root", label: "root" }, { id: "leaf", label: "leaf" },
    ], edges: [{ from: "root", to: "leaf" }] };
  }
  if (type === "timeline") {
    return { title: "Timeline", type: "timeline", nodes: [
      { id: "a", label: "a", at: "2026-01-01" }, { id: "b", label: "b", at: "2026-02-01" },
    ], edges: [] };
  }
  if (type === "waterfall") {
    return { title: "Waterfall", type: "waterfall", nodes: [
      { id: "dns", label: "dns", start: 0, duration: 40 },
      { id: "tls", label: "tls", start: 40, duration: 60 },
    ], edges: [] };
  }
  if (type === "dataflow") {
    return { title: "Dataflow", type: "dataflow", nodes: [
      { id: "in", label: "in", stage: "collect" }, { id: "out", label: "out", stage: "serve" },
    ], edges: [{ from: "in", to: "out" }] };
  }
  if (type === "lifecycle") {
    return { title: "Lifecycle", type: "lifecycle", nodes: [
      { id: "draft", label: "draft" }, { id: "done", label: "done" },
    ], edges: [{ from: "draft", to: "done", label: "finish" }] };
  }
  return minimalArchitecture();
}

export function richIr() {
  return {
    title: "Rich fixture",
    subtitle: "production · 2026-10",
    type: "sequence",
    direction: "TB",
    nodes: [
      { id: "user", label: "User", sublabel: "browser", kind: "actor" },
      { id: "web", label: "Web App", kind: "service" },
      { id: "api", label: "API", kind: "service" },
      { id: "redis", label: "Redis", kind: "datastore" },
    ],
    groups: [{ id: "fallback", label: "fallback", kind: "fragment", nodes: ["api", "redis"] }],
    edges: [
      { from: "user", to: "web", label: "open", kind: "main" },
      { from: "web", to: "api", label: "GET /x", kind: "main" },
      { from: "api", to: "redis", label: "read", kind: "main" },
    ],
    notes: ["Fragment groups are sequence-only.", "Cache fill is async."],
  };
}

// ---------------------------------------------------------------------------
// stub pipeline project (geometry-free; works before layout/view land)
// ---------------------------------------------------------------------------

const STUB_LAYOUT = `// test stub: deterministic fake layout (never shipped)
export function layout(ir) {
  const nodes = (ir.nodes || []).map((node, index) => ({
    ...node,
    shape: "card",
    x: 40 + index * 200,
    y: 60,
    w: 168,
    h: 64,
  }));
  const edges = (ir.edges || []).map((edge, index) => ({
    id: "e" + (index + 1),
    ...edge,
    dashed: edge.kind === "return",
    arrow: "end",
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  }));
  return {
    sceneVersion: 1,
    type: ir.type,
    direction: ir.direction || "TB",
    width: 800,
    height: 600,
    title: ir.title,
    subtitle: ir.subtitle,
    notes: ir.notes || [],
    nodes,
    groups: [],
    edges,
    legend: [],
    meta: { padding: 24, sceneVersion: 1 },
  };
}
`;

const STUB_COMPOSE = `// test stub: deterministic fake composer (never shipped)
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function compose({ scene, options }) {
  const mode = options && options.mode ? options.mode : "auto";
  const title = String(scene.title).replace(/[&<>"]/g, (char) => ESC[char]);
  const nodes = scene.nodes.map((node) => "<li>" + String(node.label) + "</li>").join("");
  const edges = scene.edges.map((edge) => "<li>" + edge.from + " -&gt; " + edge.to + "</li>").join("");
  return "<!doctype html>\\n<html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><title>" + title +
    "</title></head><body data-mode=\\"" + mode + "\\"><h1>" + title + "</h1><ul>" + nodes + "</ul><ul>" + edges + "</ul></body></html>";
}
`;

/**
 * Build a throwaway Naqsha tree in /tmp/cli-test with our real CLI+validator
 * and stub (or omitted) layout/view modules.
 */
export function makeStubProject(name, { withLayout = true, withCompose = true, examples = null } = {}) {
  const dir = mkScratch(name);
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, "cli"), { recursive: true });
  fs.mkdirSync(path.join(src, "validate"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "src", "cli", "naqsha.mjs"), path.join(src, "cli", "naqsha.mjs"));
  fs.copyFileSync(path.join(ROOT, "src", "validate", "index.mjs"), path.join(src, "validate", "index.mjs"));
  if (withLayout) {
    fs.mkdirSync(path.join(src, "layout"), { recursive: true });
    fs.writeFileSync(path.join(src, "layout", "index.mjs"), STUB_LAYOUT);
  }
  if (withCompose) {
    fs.mkdirSync(path.join(src, "view"), { recursive: true });
    fs.writeFileSync(path.join(src, "view", "compose.mjs"), STUB_COMPOSE);
  }
  const project = {
    dir,
    cli: path.join(src, "cli", "naqsha.mjs"),
    layout: path.join(src, "layout", "index.mjs"),
    compose: path.join(src, "view", "compose.mjs"),
    examplesDir: path.join(dir, "examples"),
  };
  if (examples !== null) {
    fs.mkdirSync(project.examplesDir, { recursive: true });
    for (const [fileName, ir] of Object.entries(examples)) {
      writeJsonFile(path.join(project.examplesDir, fileName), ir);
    }
  }
  return project;
}

// ---------------------------------------------------------------------------
// chrome discovery (mirrors the CLI, for conditional screenshot tests)
// ---------------------------------------------------------------------------

export function findChrome() {
  if (process.env.NAQSHA_CHROME) return process.env.NAQSHA_CHROME;
  const fixed = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/local/bin/chromium",
    "/snap/bin/chromium",
  ];
  const candidates = [...fixed];
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache", "ms-playwright")].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-")) continue;
      const directory = path.join(root, entry);
      candidates.push(path.join(directory, "chrome"));
      let subdirectories = [];
      try {
        subdirectories = fs.readdirSync(directory).sort();
      } catch {
        subdirectories = [];
      }
      for (const subdirectory of subdirectories) {
        if (!subdirectory.startsWith("chrome-")) continue;
        candidates.push(path.join(directory, subdirectory, "chrome"));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
