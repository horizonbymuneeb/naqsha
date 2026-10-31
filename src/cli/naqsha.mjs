#!/usr/bin/env node
// Naqsha CLI — one small JSON file in, one self-contained interactive HTML out.
//
//   naqsha validate <in.json> [--json]
//   naqsha render   <in.json> <out.html> [--mode light|dark|auto] [--json]
//   naqsha demo     <outdir> [--mode light|dark|auto] [--json]
//   naqsha types    [--json]
//   naqsha doctor   [--json]
//   naqsha screenshot <html> <out.png> [--width 1440] [--height 980]
//   naqsha diff     <base.json> <head.json> <out.html> [--mode] [--json]
//   naqsha path     <in.json> <from-id> <to-id> [--json]
//   naqsha convert  <in.mmd> <out.json> [--type] [--json]
//   naqsha mermaid  <in.json> <out.mmd> [--json]
//   naqsha fix      <in.json> [--write | --out <file>] [--json]
//   naqsha version | --version       print the CLI version
//
// Zero dependencies, Node >= 18, ESM. Contract: src/CONTRACT.md §4.
// Exit codes: 0 ok, 1 validation/render/runtime failure, 2 usage error
// (and 2 for "render pipeline not ready", i.e. layout/view modules missing).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const VALIDATE_MODULE = new URL("../validate/index.mjs", import.meta.url);
const LAYOUT_MODULE = new URL("../layout/index.mjs", import.meta.url);
const COMPOSE_MODULE = new URL("../view/compose.mjs", import.meta.url);
const DIFF_MODULE = new URL("../diff/index.mjs", import.meta.url);
const CONVERT_MODULE = new URL("../convert/mermaid.mjs", import.meta.url);
const REPAIR_MODULE = new URL("../repair/index.mjs", import.meta.url);
const TO_MERMAID_MODULE = new URL("../convert/to-mermaid.mjs", import.meta.url);

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const NAQSHA_CHROME_ENV = "NAQSHA_CHROME";
const REJECTED_CHROME = path.resolve("/usr/bin/chromium-browser"); // snap shim: never accept

const USAGE = `naqsha — JSON in, self-contained interactive HTML out

Usage:
  naqsha validate <in.json> [--json]
  naqsha render   <in.json> <out.html> [--mode light|dark|auto] [--json]
  naqsha demo     <outdir> [--mode light|dark|auto] [--json]
  naqsha types    [--json]
  naqsha doctor   [--json]
  naqsha screenshot <html> <out.png> [--width 1440] [--height 980]
  naqsha diff     <base.json> <head.json> <out.html> [--mode light|dark|auto] [--json]
  naqsha path     <in.json> <from-id> <to-id> [--json]
  naqsha convert  <in.mmd> <out.json> [--type auto|workflow|architecture|sequence] [--json]
  naqsha mermaid  <in.json> <out.mmd> [--json]
  naqsha fix      <in.json> [--write | --out <file>] [--json]
  naqsha install-skill [--agent all|dsh|claude|codex|hermes|opencode|cursor|gemini]
                       [--prefix DIR] [--no-verify] [--list]
  naqsha version | --version       print the CLI version

Examples:
  naqsha render examples/engine-repo.architecture.json diagram.html
  naqsha diff   examples/engine-repo.v31.architecture.json examples/engine-repo.architecture.json diff.html

Exit codes: 0 ok · 1 validation/render failure · 2 usage error
`;

const BUILTIN_IR = Object.freeze({
  title: "Naqsha doctor smoke test",
  type: "architecture",
  direction: "TB",
  nodes: [
    { id: "web", label: "Web App", kind: "service" },
    { id: "db", label: "Database", kind: "datastore" },
  ],
  edges: [{ from: "web", to: "db", label: "query", kind: "data" }],
});

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const emitJson = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const display = (absolutePath) => path.relative(process.cwd(), absolutePath) || absolutePath;

/** CLI version: package.json wins, the VERSION file is the fallback for the skill payload. */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (pkg.version) return String(pkg.version);
  } catch {
    /* not installed as a package — fall through */
  }
  try {
    return fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

const cliError = (code, message, errorPath, hint) => ({ code, message, path: errorPath, hint });

const failureReceipt = (errors, warnings = []) => ({ ok: false, errors, warnings });

/** Print errors (or a JSON receipt) and return the failure exit code. */
function failWith(flags, errors, label) {
  if (flags && flags.json) emitJson(failureReceipt(errors));
  else {
    printErrorList(errors);
    process.stderr.write(`${label} failed: ${errors.length} error(s)\n`);
  }
  return EXIT_FAIL;
}

function printErrorList(errors, warnings = []) {
  for (const error of errors) {
    process.stderr.write(`error ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}\n`);
    process.stderr.write(`  hint: ${error.hint}\n`);
  }
  for (const warning of warnings) {
    process.stderr.write(`warn ${warning.code}${warning.path ? ` at ${warning.path}` : ""}: ${warning.message}\n`);
  }
}

function jsonErrorPosition(error, text) {
  const message = String(error && error.message ? error.message : "");
  const withLineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (withLineColumn) return `line ${withLineColumn[1]}, column ${withLineColumn[2]}`;
  const withPosition = /position (\d+)/i.exec(message);
  if (withPosition) {
    const index = Number(withPosition[1]);
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    const column = index - before.lastIndexOf("\n");
    return `line ${line}, column ${column}`;
  }
  return null;
}

/** Read + parse a JSON IR file. Never throws. */
function readIrFile(inputPath) {
  let text;
  try {
    text = fs.readFileSync(inputPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        errors: [
          cliError(
            "cli/file-missing",
            `input file not found: ${inputPath}`,
            inputPath,
            "pass the path to an existing JSON IR file, e.g. naqsha validate examples/engine-repo.architecture.json",
          ),
        ],
      };
    }
    return {
      ok: false,
      errors: [cliError("cli/file-read", `cannot read ${inputPath}: ${error.message}`, inputPath, "check that the path is a readable file")],
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const position = jsonErrorPosition(error, text);
    return {
      ok: false,
      errors: [
        cliError(
          "ir/json-syntax",
          `invalid JSON in ${inputPath}: ${error.message}`,
          inputPath,
          `fix the JSON syntax${position ? ` at ${position}` : ""} — the file must be strict JSON: double-quoted keys, no comments, no trailing commas`,
        ),
      ],
    };
  }
}

/** Load src/validate/index.mjs once. */
let validatorPromise = null;
function loadValidator() {
  if (validatorPromise === null) {
    validatorPromise = (async () => {
      const module = await import(VALIDATE_MODULE.href);
      if (typeof module.validate !== "function") {
        throw new Error("src/validate/index.mjs does not export validate(ir)");
      }
      return module;
    })();
  }
  return validatorPromise;
}

/** Load layout+compose once; missing modules become the contract's one-liner. */
let pipelinePromise = null;
function loadPipeline() {
  if (pipelinePromise === null) {
    pipelinePromise = (async () => {
      const modules = [
        { label: "src/layout/index.mjs", url: LAYOUT_MODULE, exportName: "layout" },
        { label: "src/view/compose.mjs", url: COMPOSE_MODULE, exportName: "compose" },
      ];
      for (const module of modules) {
        const file = fileURLToPath(module.url);
        if (!fs.existsSync(file)) {
          return { ok: false, notReady: true, message: `render pipeline not ready: ${module.label}` };
        }
      }
      const loaded = {};
      for (const module of modules) {
        let imported;
        try {
          imported = await import(module.url.href);
        } catch (error) {
          return {
            ok: false,
            notReady: true,
            message: `render pipeline not ready: ${module.label} (${error.message})`,
          };
        }
        if (typeof imported[module.exportName] !== "function") {
          return {
            ok: false,
            notReady: true,
            message: `render pipeline not ready: ${module.label} (no exported ${module.exportName}() function)`,
          };
        }
        loaded[module.exportName] = imported[module.exportName];
      }
      return { ok: true, layout: loaded.layout, compose: loaded.compose };
    })();
  }
  return pipelinePromise;
}

/** Write via a sibling temp file + rename, so readers never see half a file. */
function atomicWrite(outPath, content) {
  const directory = path.dirname(outPath);
  const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(directory, `.naqsha-${path.basename(outPath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp was never created */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

const FLAG_SPECS = Object.freeze({
  json: { kind: "boolean" },
  mode: { kind: "choice", values: ["light", "dark", "auto"] },
  width: { kind: "int", min: 100, max: 8000 },
  height: { kind: "int", min: 100, max: 8000 },
  type: { kind: "choice", values: ["auto", "workflow", "architecture", "sequence"] },
  out: { kind: "string" },
  write: { kind: "boolean" },
  agent: { kind: "string" },
  prefix: { kind: "string" },
  "no-verify": { kind: "boolean" },
  list: { kind: "boolean" },
});

function parseCommandArgs(tokens, { allow, min, max }) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      let name = token.slice(2);
      let value;
      const equalsIndex = name.indexOf("=");
      if (equalsIndex >= 0) {
        value = name.slice(equalsIndex + 1);
        name = name.slice(0, equalsIndex);
      }
      if (!allow.includes(name)) {
        throw new UsageError(`unknown option "--${name}"`);
      }
      const spec = FLAG_SPECS[name];
      if (spec.kind === "boolean") {
        if (value !== undefined) throw new UsageError(`option "--${name}" takes no value`);
        flags[name] = true;
        continue;
      }
      if (value === undefined) {
        if (index + 1 >= tokens.length) throw new UsageError(`option "--${name}" needs a value`);
        index += 1;
        value = tokens[index];
      }
      if (spec.kind === "choice" && !spec.values.includes(value)) {
        throw new UsageError(`--${name} must be one of ${spec.values.join(", ")} (got "${value}")`);
      }
      if (spec.kind === "int") {
        const number = Number(value);
        if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
          throw new UsageError(`--${name} must be an integer between ${spec.min} and ${spec.max} (got "${value}")`);
        }
        flags[name] = number;
      } else {
        flags[name] = value;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`unknown option "${token}"`);
    }
    positionals.push(token);
  }
  if (positionals.length < min) {
    throw new UsageError(`missing argument${min - positionals.length > 1 ? "s" : ""}; expected ${min}, got ${positionals.length}`);
  }
  if (max !== undefined && positionals.length > max) {
    throw new UsageError(`too many arguments: ${positionals.slice(max).map((value) => `"${value}"`).join(" ")}`);
  }
  return { positionals, flags };
}

// ---------------------------------------------------------------------------
// v1.0 pipeline pieces: render an in-memory IR, optional modules
// ---------------------------------------------------------------------------

/** Load a v1.0 module (diff/convert/repair) without crashing when it is absent. */
async function loadOptional(moduleUrl, exportName, label) {
  const file = fileURLToPath(moduleUrl);
  if (!fs.existsSync(file)) {
    return { ok: false, notReady: true, message: `${label} not ready: ${path.relative(ROOT, file)} is missing` };
  }
  let imported;
  try {
    imported = await import(moduleUrl.href);
  } catch (error) {
    return { ok: false, notReady: true, message: `${label} not ready: ${path.relative(ROOT, file)} (${error.message})` };
  }
  if (typeof imported[exportName] !== "function") {
    return { ok: false, notReady: true, message: `${label} not ready: ${path.relative(ROOT, file)} has no exported ${exportName}()` };
  }
  return { ok: true, module: imported };
}

/** Validate -> layout -> compose -> atomic write, from an in-memory IR. */
async function renderIrToFile(ir, output, mode, sceneExtras) {
  const { validate } = await loadValidator();
  const checked = validate(ir);
  if (!checked.ok) return { ok: false, exitCode: EXIT_FAIL, errors: checked.errors, warnings: checked.warnings };

  const pipeline = await loadPipeline();
  if (!pipeline.ok) return { ok: false, exitCode: EXIT_USAGE, notReady: true, message: pipeline.message };

  let scene;
  try {
    scene = pipeline.layout(ir);
  } catch (error) {
    return {
      ok: false, exitCode: EXIT_FAIL, warnings: checked.warnings,
      errors: [cliError("cli/render-failed", `layout failed: ${error && error.message ? error.message : String(error)}`, "", "internal Naqsha bug; re-run with NAQSHA_DEBUG=1 and report it")],
    };
  }
  if (sceneExtras && typeof sceneExtras === "object") Object.assign(scene, sceneExtras);
  let html;
  try {
    html = pipeline.compose({ scene, options: { mode } });
  } catch (error) {
    return {
      ok: false, exitCode: EXIT_FAIL, warnings: checked.warnings,
      errors: [cliError("cli/render-failed", `compose failed: ${error && error.message ? error.message : String(error)}`, "", "internal Naqsha bug; re-run with NAQSHA_DEBUG=1 and report it")],
    };
  }
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false, exitCode: EXIT_FAIL, warnings: checked.warnings,
      errors: [cliError("cli/render-failed", "compose returned no HTML", "", "internal Naqsha bug; src/view/compose.mjs must return the full document")],
    };
  }
  const outDirectory = path.dirname(output);
  if (!fs.existsSync(outDirectory) || !fs.statSync(outDirectory).isDirectory()) {
    return {
      ok: false, exitCode: EXIT_FAIL, warnings: checked.warnings,
      errors: [cliError("cli/output-dir", `output directory does not exist: ${outDirectory}`, output, `create the directory first: mkdir -p "${outDirectory}"`)],
    };
  }
  try {
    atomicWrite(output, html);
  } catch (error) {
    return {
      ok: false, exitCode: EXIT_FAIL, warnings: checked.warnings,
      errors: [cliError("cli/output-write", `cannot write ${output}: ${error.message}`, output, "check write permissions on the output directory")],
    };
  }
  return { ok: true, bytes: Buffer.byteLength(html), scene, warnings: checked.warnings };
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

async function cmdDiff(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "mode"], min: 3, max: 3 });
  const basePath = path.resolve(positionals[0]);
  const headPath = path.resolve(positionals[1]);
  const output = path.resolve(positionals[2]);
  const mode = flags.mode || "auto";

  const base = readIrFile(basePath);
  if (!base.ok) return failWith(flags, base.errors, "diff");
  const head = readIrFile(headPath);
  if (!head.ok) return failWith(flags, head.errors, "diff");

  const { validate } = await loadValidator();
  const baseChecked = validate(base.value);
  if (!baseChecked.ok) {
    return failWith(flags, baseChecked.errors.map((error) => ({ ...error, path: `base:${error.path}` })), "diff");
  }
  const headChecked = validate(head.value);
  if (!headChecked.ok) {
    return failWith(flags, headChecked.errors.map((error) => ({ ...error, path: `head:${error.path}` })), "diff");
  }

  const engine = await loadOptional(DIFF_MODULE, "diff", "diff engine");
  if (!engine.ok) { process.stderr.write(`${engine.message}\n`); return EXIT_USAGE; }

  let result;
  try {
    result = engine.module.diff(base.value, head.value);
  } catch (error) {
    return failWith(flags, [cliError("cli/diff-failed", `diff failed: ${error && error.message ? error.message : String(error)}`, "", "internal diff bug; re-run with NAQSHA_DEBUG=1")], "diff");
  }
  if (!result || !result.ir) {
    return failWith(flags, [cliError("cli/diff-failed", "diff() returned no merged IR", "", "internal diff bug; report it")], "diff");
  }

  const rendered = await renderIrToFile(result.ir, output, mode, {
    diff: {
      base: base.value.title,
      head: head.value.title,
      ...(result.summary || {}),
    },
  });
  if (!rendered.ok) {
    if (rendered.notReady) { process.stderr.write(`${rendered.message}\n`); return EXIT_USAGE; }
    return failWith(flags, rendered.errors, "diff");
  }
  const summary = result.summary || {};
  if (flags.json) {
    emitJson({ ok: true, base: basePath, head: headPath, output, bytes: rendered.bytes, summary, changes: (result.changes || []).length });
  } else {
    const s = summary;
    process.stdout.write(
      `diff ${display(basePath)} -> ${display(headPath)}  (+${s.addedNodes ?? 0} -${s.removedNodes ?? 0} ~${s.changedNodes ?? 0} nodes, ` +
        `+${s.addedEdges ?? 0} -${s.removedEdges ?? 0} ~${s.changedEdges ?? 0} edges)\n  written ${display(output)} (${rendered.bytes} bytes)\n`,
    );
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

async function cmdPath(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json"], min: 3, max: 3 });
  const input = path.resolve(positionals[0]);
  const from = positionals[1];
  const to = positionals[2];
  const loaded = readIrFile(input);
  if (!loaded.ok) return failWith(flags, loaded.errors, "path");
  const engine = await loadOptional(DIFF_MODULE, "shortestPath", "path engine");
  if (!engine.ok) { process.stderr.write(`${engine.message}\n`); return EXIT_USAGE; }
  const result = engine.module.shortestPath(loaded.value, from, to);
  if (flags.json) {
    emitJson({ ok: !!result.ok, input, from, to, path: result.path || [], edges: result.edges || [], hops: result.hops ?? null, reason: result.reason || null });
  } else if (result.ok) {
    process.stdout.write(`${display(input)}: ${from} -> ${to}  ${result.hops} hop(s)\n  ${result.path.join(" -> ")}\n`);
  } else {
    process.stderr.write(`no path ${from} -> ${to}: ${result.reason}\n`);
    process.stderr.write("  hint: both node ids must exist; the shortest path is computed over undirected edges\n");
  }
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// convert (Mermaid -> IR)
// ---------------------------------------------------------------------------

async function cmdConvert(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "type"], min: 2, max: 2 });
  const input = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  const type = flags.type || "auto";
  let text;
  try {
    text = fs.readFileSync(input, "utf8");
  } catch (error) {
    return failWith(flags, [cliError("cli/file-missing", `cannot read ${input}: ${error.message}`, input, "pass an existing Mermaid .mmd file")], "convert");
  }
  const engine = await loadOptional(CONVERT_MODULE, "convertMermaid", "Mermaid converter");
  if (!engine.ok) { process.stderr.write(`${engine.message}\n`); return EXIT_USAGE; }

  let result;
  try {
    result = engine.module.convertMermaid(text, { type });
  } catch (error) {
    return failWith(flags, [cliError("cli/convert-failed", `convert failed: ${error && error.message ? error.message : String(error)}`, "", "internal converter bug; re-run with NAQSHA_DEBUG=1")], "convert");
  }
  if (!result || !result.ok) {
    const errors = (result && result.errors && result.errors.length
      ? result.errors
      : [cliError("cli/convert-failed", "Mermaid input could not be converted", "", "supported dialects: flowchart/graph and sequenceDiagram")]);
    return failWith(flags, errors, "convert");
  }
  const { validate } = await loadValidator();
  const checked = validate(result.ir);
  if (!checked.ok) {
    return failWith(flags, [cliError("cli/convert-invalid", "converter produced an IR that fails validation", "ir", "internal converter bug; report it with the input")], "convert");
  }
  try {
    atomicWrite(output, `${JSON.stringify(result.ir, null, 2)}\n`);
  } catch (error) {
    return failWith(flags, [cliError("cli/output-write", `cannot write ${output}: ${error.message}`, output, "check write permissions")], "convert");
  }
  if (flags.json) {
    emitJson({
      ok: true, input, output, type: result.ir.type,
      nodes: (result.ir.nodes || []).length, edges: (result.ir.edges || []).length,
      warnings: (result.warnings || []).map((w) => ({ code: w.code || "convert/warning", message: w.message || String(w), line: w.line ?? null })),
    });
  } else {
    process.stdout.write(`converted ${display(input)} -> ${display(output)}  (${result.ir.type}, ${(result.ir.nodes || []).length} nodes, ${(result.ir.edges || []).length} edges)\n`);
    for (const w of result.warnings || []) process.stdout.write(`  warn ${w.code || "convert/warning"}${w.line ? ` at line ${w.line}` : ""}: ${w.message || w}\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fix (self-healing IR)
// ---------------------------------------------------------------------------

async function cmdFix(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "write", "out"], min: 1, max: 1 });
  if (flags.write && flags.out) throw new UsageError("--write and --out are mutually exclusive");
  const input = path.resolve(positionals[0]);
  const loaded = readIrFile(input);
  if (!loaded.ok) return failWith(flags, loaded.errors, "fix");
  const engine = await loadOptional(REPAIR_MODULE, "repair", "repair module");
  if (!engine.ok) { process.stderr.write(`${engine.message}\n`); return EXIT_USAGE; }

  let result;
  try {
    result = engine.module.repair(loaded.value);
  } catch (error) {
    return failWith(flags, [cliError("cli/fix-failed", `repair failed: ${error && error.message ? error.message : String(error)}`, "", "internal repair bug; re-run with NAQSHA_DEBUG=1")], "fix");
  }
  const { validate } = await loadValidator();
  const checked = validate(result.ir);
  const changes = result.changes || [];
  const target = flags.write ? input : flags.out ? path.resolve(flags.out) : null;
  if (target) atomicWrite(target, `${JSON.stringify(result.ir, null, 2)}\n`);

  if (flags.json) {
    emitJson({ ok: checked.ok, input, output: target, changes, remainingErrors: checked.errors, warnings: checked.warnings });
  } else if (target) {
    process.stdout.write(`fixed ${display(input)} -> ${display(target)}  (${changes.length} change(s))\n`);
    for (const change of changes) process.stdout.write(`  ${change.code} ${change.path}: ${change.note}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.ir, null, 2)}\n`);
  }
  if (!checked.ok) {
    printErrorList(checked.errors, checked.warnings);
    return EXIT_FAIL;
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// mermaid (IR -> Mermaid, round-trip export)
// ---------------------------------------------------------------------------

async function cmdMermaid(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json"], min: 2, max: 2 });
  const input = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  const loaded = readIrFile(input);
  if (!loaded.ok) return failWith(flags, loaded.errors, "mermaid");
  const { validate } = await loadValidator();
  const checked = validate(loaded.value);
  if (!checked.ok) return failWith(flags, checked.errors, "mermaid");
  const engine = await loadOptional(TO_MERMAID_MODULE, "toMermaid", "Mermaid exporter");
  if (!engine.ok) { process.stderr.write(`${engine.message}\n`); return EXIT_USAGE; }

  let result;
  try {
    result = engine.module.toMermaid(loaded.value);
  } catch (error) {
    return failWith(flags, [cliError("cli/mermaid-failed", `export failed: ${error && error.message ? error.message : String(error)}`, "", "internal exporter bug; re-run with NAQSHA_DEBUG=1")], "mermaid");
  }
  if (!result || result.ok === false || typeof result.mermaid !== "string") {
    return failWith(flags, [cliError("cli/mermaid-failed", "IR could not be expressed as Mermaid", "", "supported types: architecture, workflow, sequence")], "mermaid");
  }
  try {
    atomicWrite(output, result.mermaid.endsWith("\n") ? result.mermaid : `${result.mermaid}\n`);
  } catch (error) {
    return failWith(flags, [cliError("cli/output-write", `cannot write ${output}: ${error.message}`, output, "check write permissions")], "mermaid");
  }
  const warnings = result.warnings || [];
  if (flags.json) {
    emitJson({ ok: true, input, output, bytes: Buffer.byteLength(result.mermaid), warnings });
  } else {
    process.stdout.write(`mermaid ${display(input)} -> ${display(output)}  (${Buffer.byteLength(result.mermaid)} bytes)\n`);
    for (const w of warnings) process.stdout.write(`  warn ${w.code || "mermaid/warning"}: ${w.message || w}\n`);
  }
  return EXIT_OK;
}


// ---------------------------------------------------------------------------
// install-skill
// ---------------------------------------------------------------------------

const INSTALL_AGENTS = ["all", "dsh", "claude", "codex", "hermes", "opencode", "cursor", "gemini"];

function cmdInstallSkill(tokens) {
  const { flags } = parseCommandArgs(tokens, {
    allow: ["agent", "prefix", "no-verify", "list"],
    min: 0,
    max: 0,
  });
  const installer = path.join(ROOT, "install.sh");
  if (!fs.existsSync(installer)) {
    const error = cliError(
      "cli/installer-missing",
      `installer not found: ${installer}`,
      installer,
      "reinstall the package (npm i -g naqsha-cli) or run install.sh from a clone",
    );
    printErrorList([error]);
    return EXIT_FAIL;
  }
  if (flags.agent !== undefined && !INSTALL_AGENTS.includes(flags.agent)) {
    const error = cliError(
      "cli/unknown-agent",
      `unknown agent "${flags.agent}"`,
      "--agent",
      `use one of: ${INSTALL_AGENTS.join(", ")}`,
    );
    printErrorList([error]);
    return EXIT_USAGE;
  }
  const bash = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8", timeout: 10000 });
  if (bash.error || bash.status !== 0) {
    const error = cliError(
      "cli/bash-missing",
      "bash is required to run the installer and was not found",
      "bash",
      "on Windows use WSL or Git Bash, or copy SKILL.md, src/ and examples/ into the agent's skills root manually (see docs/INSTALL.md)",
    );
    printErrorList([error]);
    return EXIT_FAIL;
  }
  const args = [installer];
  if (flags.list === true) args.push("--list");
  if (flags.agent !== undefined) args.push("--agent", flags.agent);
  if (flags.prefix !== undefined) args.push("--prefix", flags.prefix);
  if (flags["no-verify"] === true) args.push("--no-verify");
  const run = spawnSync("bash", args, { stdio: "inherit", env: process.env });
  if (run.error) {
    const error = cliError("cli/installer-failed", `installer failed: ${run.error.message}`, installer, "re-run install.sh directly to see the raw output");
    printErrorList([error]);
    return EXIT_FAIL;
  }
  return typeof run.status === "number" ? run.status : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

function cmdVersion(tokens) {
  parseCommandArgs(tokens, { allow: [], min: 0, max: 0 });
  process.stdout.write(`naqsha ${readVersion()}\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

const TYPE_CATALOG = [
  ["architecture", "services, stores, actors, trust boundaries", "{ nodes: [{id,label,kind}], edges: [{from,to,kind}] }"],
  ["workflow", "ordered steps, decisions, retries", "{ direction: 'LR'|'TB', nodes, edges }"],
  ["sequence", "messages between participants over time", "{ nodes: participants, edges: messages }"],
  ["erd", "tables, columns, keys, cardinality", "{ nodes: [{attributes:[{name,type,key,ref}]}], edges: [{cardinality}] }"],
  ["class", "types, members, inheritance, composition", "{ nodes: [{stereotype, members}], edges: [{kind:'extends'|...}] }"],
  ["tree", "single-parent hierarchy from one root", "{ nodes, edges: [{from:parent,to:child}] }"],
  ["timeline", "dated events on a time axis with lanes", "{ nodes: [{at:'2026-03-01', lane}] }"],
  ["waterfall", "spans with start + duration on one axis", "{ nodes: [{start:0, duration:120, lane}] }"],
  ["dataflow", "pipeline stages, left to right", "{ nodes: [{stage}], edges: flows }"],
  ["lifecycle", "states and transitions, start/end emphasis", "{ nodes: states, edges: [{label:event}] }"],
];

async function cmdTypes(tokens) {
  const { flags } = parseCommandArgs(tokens, { allow: ["json"], min: 0, max: 0 });
  if (flags.json) {
    emitJson({ ok: true, types: TYPE_CATALOG.map(([name, use, shape]) => ({ name, use, shape })) });
  } else {
    process.stdout.write(`naqsha ${readVersion()} — ${TYPE_CATALOG.length} diagram types\n\n`);
    for (const [name, use, shape] of TYPE_CATALOG) {
      process.stdout.write(`  ${name.padEnd(13)} ${use}\n`);
      process.stdout.write(`  ${"".padEnd(13)} ${shape}\n`);
    }
    process.stdout.write('\nrun `naqsha render <input.json> <output.html>`; examples live in examples/\n');
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function cmdValidate(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json"], min: 1, max: 1 });
  const input = path.resolve(positionals[0]);
  const loaded = readIrFile(input);
  if (!loaded.ok) {
    if (flags.json) emitJson(failureReceipt(loaded.errors));
    else {
      printErrorList(loaded.errors);
      process.stderr.write(`validate failed: ${loaded.errors.length} error(s)\n`);
    }
    return EXIT_FAIL;
  }

  const { validate } = await loadValidator();
  const result = validate(loaded.value);
  const nodeCount = Array.isArray(loaded.value.nodes) ? loaded.value.nodes.length : 0;
  const edgeCount = Array.isArray(loaded.value.edges) ? loaded.value.edges.length : 0;

  if (flags.json) {
    if (result.ok) {
      emitJson({ ok: true, input, nodes: nodeCount, edges: edgeCount, errors: [], warnings: result.warnings });
    } else {
      emitJson(failureReceipt(result.errors, result.warnings));
    }
  } else if (result.ok) {
    const warningCount = result.warnings.length;
    process.stdout.write(
      `valid  ${display(input)} — ${nodeCount} node(s), ${edgeCount} edge(s)${warningCount ? `, ${warningCount} warning(s)` : ""}\n`,
    );
    for (const warning of result.warnings) {
      process.stdout.write(`  warn ${warning.code} at ${warning.path}: ${warning.message}\n`);
    }
  } else {
    printErrorList(result.errors, result.warnings);
    process.stderr.write(`invalid ${display(input)} — ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`);
  }
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// render pipeline (shared by render and demo)
// ---------------------------------------------------------------------------

async function renderPipeline({ input, output, mode }) {
  const loaded = readIrFile(input);
  if (!loaded.ok) return { ok: false, exitCode: EXIT_FAIL, errors: loaded.errors, warnings: [] };

  const { validate } = await loadValidator();
  const checked = validate(loaded.value);
  if (!checked.ok) {
    return { ok: false, exitCode: EXIT_FAIL, errors: checked.errors, warnings: checked.warnings };
  }

  const pipeline = await loadPipeline();
  if (!pipeline.ok) {
    return { ok: false, exitCode: EXIT_USAGE, notReady: true, message: pipeline.message };
  }

  let scene;
  try {
    scene = pipeline.layout(loaded.value);
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_FAIL,
      warnings: checked.warnings,
      errors: [
        cliError(
          "cli/render-failed",
          `layout failed: ${error && error.message ? error.message : String(error)}`,
          "",
          "this is an internal Naqsha bug; re-run with NAQSHA_DEBUG=1 to see the stack trace and report it",
        ),
      ],
    };
  }

  let html;
  try {
    html = pipeline.compose({ scene, options: { mode } });
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_FAIL,
      warnings: checked.warnings,
      errors: [
        cliError(
          "cli/render-failed",
          `compose failed: ${error && error.message ? error.message : String(error)}`,
          "",
          "this is an internal Naqsha bug; re-run with NAQSHA_DEBUG=1 to see the stack trace and report it",
        ),
      ],
    };
  }
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_FAIL,
      warnings: checked.warnings,
      errors: [
        cliError(
          "cli/render-failed",
          "compose returned no HTML",
          "",
          "this is an internal Naqsha bug; src/view/compose.mjs must return the complete HTML document as a string",
        ),
      ],
    };
  }

  const outDirectory = path.dirname(output);
  if (!fs.existsSync(outDirectory) || !fs.statSync(outDirectory).isDirectory()) {
    return {
      ok: false,
      exitCode: EXIT_FAIL,
      warnings: checked.warnings,
      errors: [
        cliError(
          "cli/output-dir",
          `output directory does not exist: ${outDirectory}`,
          output,
          `create the directory first: mkdir -p "${outDirectory}"`,
        ),
      ],
    };
  }

  try {
    atomicWrite(output, html);
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_FAIL,
      errors: [
        cliError("cli/output-write", `cannot write ${output}: ${error.message}`, output, "check write permissions on the output directory"),
      ],
      warnings: checked.warnings,
    };
  }

  return {
    ok: true,
    bytes: Buffer.byteLength(html),
    nodes: Array.isArray(loaded.value.nodes) ? loaded.value.nodes.length : 0,
    edges: Array.isArray(loaded.value.edges) ? loaded.value.edges.length : 0,
    warnings: checked.warnings,
    scene,
    html,
  };
}

async function cmdRender(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "mode"], min: 2, max: 2 });
  const input = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  const mode = flags.mode || "auto";

  const result = await renderPipeline({ input, output, mode });
  if (!result.ok) {
    if (result.notReady) {
      process.stderr.write(`${result.message}\n`);
      return EXIT_USAGE;
    }
    if (flags.json) emitJson(failureReceipt(result.errors, result.warnings || []));
    else {
      printErrorList(result.errors, result.warnings || []);
      process.stderr.write(`render failed: ${display(output)} not written (${result.errors.length} error(s))\n`);
    }
    return result.exitCode;
  }

  if (flags.json) {
    emitJson({ ok: true, input, output, bytes: result.bytes, nodes: result.nodes, edges: result.edges });
  } else {
    process.stdout.write(
      `rendered  ${display(input)} -> ${display(output)} (${result.bytes} bytes, ${result.nodes} nodes, ${result.edges} edges)\n`,
    );
    for (const warning of result.warnings) {
      process.stdout.write(`  warn ${warning.code} at ${warning.path}: ${warning.message}\n`);
    }
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// demo
// ---------------------------------------------------------------------------

function listExampleFiles() {
  const examplesDirectory = path.join(ROOT, "examples");
  let names = [];
  try {
    names = fs.readdirSync(examplesDirectory).filter((name) => /\.json$/i.test(name)).sort();
  } catch {
    names = [];
  }
  return { examplesDirectory, files: names };
}

async function cmdDemo(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "mode"], min: 1, max: 1 });
  const outdir = path.resolve(positionals[0]);
  const mode = flags.mode || "auto";
  const { examplesDirectory, files } = listExampleFiles();

  if (files.length === 0) {
    const error = cliError(
      "cli/no-examples",
      `no examples found in ${examplesDirectory}`,
      examplesDirectory,
      'expected at least one examples/*.json IR file, e.g. examples/engine-repo.architecture.json',
    );
    if (flags.json) emitJson(failureReceipt([error]));
    else {
      printErrorList([error]);
      process.stderr.write("demo: nothing to render\n");
    }
    return EXIT_FAIL;
  }

  try {
    fs.mkdirSync(outdir, { recursive: true });
  } catch (error) {
    const failure = cliError("cli/output-dir", `cannot create output directory ${outdir}: ${error.message}`, outdir, "check write permissions and try again");
    if (flags.json) emitJson(failureReceipt([failure]));
    else printErrorList([failure]);
    return EXIT_FAIL;
  }

  const results = [];
  const allErrors = [];
  const allWarnings = [];
  for (const fileName of files) {
    const input = path.join(examplesDirectory, fileName);
    const output = path.join(outdir, fileName.replace(/\.json$/i, ".html"));
    const result = await renderPipeline({ input, output, mode });
    if (result.ok) {
      results.push({ input, output, bytes: result.bytes, nodes: result.nodes, edges: result.edges });
      allWarnings.push(...result.warnings);
      if (!flags.json) {
        process.stdout.write(`ok    ${display(input)} -> ${display(output)} (${result.bytes} bytes)\n`);
        for (const warning of result.warnings) {
          process.stdout.write(`  warn ${warning.code} at ${warning.path}: ${warning.message}\n`);
        }
      }
      continue;
    }
    if (result.notReady) {
      if (flags.json) emitJson({ ok: false, errors: [], warnings: [], files: results, message: result.message });
      else process.stderr.write(`${result.message}\n`);
      return EXIT_USAGE;
    }
    results.push({ input, output, ok: false, errors: result.errors });
    allErrors.push(...result.errors);
    allWarnings.push(...(result.warnings || []));
    if (!flags.json) {
      printErrorList(result.errors, result.warnings || []);
      process.stderr.write(`fail  ${display(input)}\n`);
    }
  }

  const ok = allErrors.length === 0;
  if (flags.json) {
    if (ok) emitJson({ ok: true, outdir, count: results.length, files: results, warnings: allWarnings });
    else emitJson({ ok: false, errors: allErrors, warnings: allWarnings, files: results });
  } else if (ok) {
    process.stdout.write(`demo: ${results.length} example(s) rendered into ${display(outdir)}\n`);
  } else {
    process.stderr.write(`demo: ${allErrors.length} error(s) across ${results.length} example(s)\n`);
  }
  return ok ? EXIT_OK : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// chrome discovery (shared by doctor and screenshot)
// ---------------------------------------------------------------------------

function chromeCandidates() {
  const candidates = [];
  if (process.env[NAQSHA_CHROME_ENV]) candidates.push(process.env[NAQSHA_CHROME_ENV]);
  candidates.push(
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/local/bin/chromium",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  // Playwright's bundled Chromium is a real browser and common on dev boxes.
  const cacheRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache", "ms-playwright")].filter(Boolean);
  for (const root of cacheRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-")) continue; // skip *headless_shell* builds on purpose
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
  return candidates;
}

function resolveChrome() {
  for (const candidate of chromeCandidates()) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (resolved === REJECTED_CHROME) continue; // snap shim: never accepted
    try {
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function chromeFailureDetail() {
  if (process.env[NAQSHA_CHROME_ENV]) {
    return `${NAQSHA_CHROME_ENV}="${process.env[NAQSHA_CHROME_ENV]}" is not an executable Chrome/Chromium binary`;
  }
  const snapNote = fs.existsSync(REJECTED_CHROME)
    ? " (/usr/bin/chromium-browser is the snap shim and is never accepted)"
    : "";
  return `not found — set ${NAQSHA_CHROME_ENV}=/path/to/chrome or install Google Chrome/Chromium${snapNote}`;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(tokens) {
  const { flags } = parseCommandArgs(tokens, { allow: ["json"], min: 0, max: 0 });
  const checks = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "node",
    ok: Number.isInteger(nodeMajor) && nodeMajor >= 18,
    detail: `${process.version} (need >= 18)`,
  });

  const chrome = resolveChrome();
  checks.push({ name: "chrome", ok: chrome !== null, detail: chrome || chromeFailureDetail() });

  let layoutFn = null;
  let composeFn = null;
  const moduleNotes = [];
  for (const [label, url, exportName] of [
    ["src/layout/index.mjs", LAYOUT_MODULE, "layout"],
    ["src/view/compose.mjs", COMPOSE_MODULE, "compose"],
  ]) {
    const file = fileURLToPath(url);
    if (!fs.existsSync(file)) {
      moduleNotes.push(`${label} missing`);
      continue;
    }
    try {
      const imported = await import(url.href);
      if (typeof imported[exportName] !== "function") {
        moduleNotes.push(`${label} exports no ${exportName}()`);
      } else if (exportName === "layout") {
        layoutFn = imported.layout;
        moduleNotes.push(`${label} ok`);
      } else {
        composeFn = imported.compose;
        moduleNotes.push(`${label} ok`);
      }
    } catch (error) {
      moduleNotes.push(`${label} failed to load: ${error && error.message ? error.message : String(error)}`);
    }
  }
  const modulesOk = layoutFn !== null && composeFn !== null;
  checks.push({ name: "modules", ok: modulesOk, detail: moduleNotes.join(" · ") });

  let renderCheck;
  if (modulesOk) {
    try {
      const { validate } = await loadValidator();
      const checked = validate(BUILTIN_IR);
      if (!checked.ok) {
        throw new Error(`built-in example failed validation (${checked.errors[0].code} at ${checked.errors[0].path})`);
      }
      const scene = layoutFn(BUILTIN_IR);
      const html = composeFn({ scene, options: { mode: "auto" } });
      if (typeof html !== "string" || html.length === 0) throw new Error("compose() returned no HTML");
      renderCheck = {
        name: "render",
        ok: true,
        detail: `${Buffer.byteLength(html)} bytes, ${BUILTIN_IR.nodes.length} nodes, ${BUILTIN_IR.edges.length} edges (in memory)`,
      };
    } catch (error) {
      renderCheck = { name: "render", ok: false, detail: `render failed: ${error && error.message ? error.message : String(error)}` };
    }
  } else {
    renderCheck = { name: "render", ok: false, detail: "skipped: layout/view modules are not ready" };
  }
  checks.push(renderCheck);

  const passed = checks.filter((check) => check.ok).length;
  const ok = passed === checks.length;

  if (flags.json) {
    emitJson({ ok, node: process.version, chrome: chrome || null, checks });
  } else {
    process.stdout.write("naqsha doctor\n");
    for (const check of checks) {
      process.stdout.write(`  ${check.name.padEnd(8)} ${check.ok ? "ok  " : "FAIL"}  ${check.detail}\n`);
    }
    process.stdout.write(`doctor: ${ok ? "ok" : "FAIL"} — ${passed}/${checks.length} checks passed\n`);
  }
  return ok ? EXIT_OK : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

async function cmdScreenshot(tokens) {
  const { positionals, flags } = parseCommandArgs(tokens, { allow: ["json", "width", "height"], min: 2, max: 2 });
  const htmlPath = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  const width = flags.width ?? 1440;
  const height = flags.height ?? 980;

  if (!fs.existsSync(htmlPath) || !fs.statSync(htmlPath).isFile()) {
    const error = cliError("cli/file-missing", `HTML file not found: ${htmlPath}`, htmlPath, "render the diagram first, e.g. naqsha render examples/engine-repo.architecture.json out.html");
    if (flags.json) emitJson(failureReceipt([error]));
    else printErrorList([error]);
    return EXIT_FAIL;
  }

  const chrome = resolveChrome();
  if (chrome === null) {
    const error = cliError(
      "cli/no-chrome",
      `no usable Chrome/Chromium found: ${chromeFailureDetail()}`,
      "",
      `install Google Chrome/Chromium or set ${NAQSHA_CHROME_ENV}=/path/to/chrome (never the /usr/bin/chromium-browser snap shim), then run naqsha doctor`,
    );
    if (flags.json) emitJson(failureReceipt([error]));
    else printErrorList([error]);
    return EXIT_FAIL;
  }

  const outDirectory = path.dirname(output);
  if (!fs.existsSync(outDirectory) || !fs.statSync(outDirectory).isDirectory()) {
    const error = cliError("cli/output-dir", `output directory does not exist: ${outDirectory}`, output, `create the directory first: mkdir -p "${outDirectory}"`);
    if (flags.json) emitJson(failureReceipt([error]));
    else printErrorList([error]);
    return EXIT_FAIL;
  }

  const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(outDirectory, `.naqsha-screenshot.${suffix}.png`);
  const url = pathToFileURL(htmlPath).href;
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=4000",
    `--screenshot=${tempPath}`,
    url,
  ];

  const run = spawnSync(chrome, args, { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  let failure = null;
  if (run.error) {
    failure = `could not run ${chrome}: ${run.error.message}`;
  } else if (run.status !== 0) {
    const stderrTail = String(run.stderr || "").trim().split("\n").slice(-3).join(" | ");
    failure = `chrome exited with code ${run.status}${stderrTail ? `: ${stderrTail}` : ""}`;
  } else if (!fs.existsSync(tempPath)) {
    failure = "chrome exited 0 but produced no screenshot file";
  }

  if (failure !== null) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* nothing to clean */
    }
    const error = cliError(
      "cli/chrome-failed",
      `screenshot failed: ${failure}`,
      output,
      `run naqsha doctor to check chrome detection, then retry (html: ${htmlPath})`,
    );
    if (flags.json) emitJson(failureReceipt([error]));
    else printErrorList([error]);
    return EXIT_FAIL;
  }

  const bytes = fs.statSync(tempPath).size;
  try {
    fs.renameSync(tempPath, output);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* nothing to clean */
    }
    const writeError = cliError("cli/output-write", `cannot write ${output}: ${error.message}`, output, "check write permissions on the output directory");
    if (flags.json) emitJson(failureReceipt([writeError]));
    else printErrorList([writeError]);
    return EXIT_FAIL;
  }

  if (flags.json) {
    emitJson({ ok: true, html: htmlPath, output, bytes, width, height, chrome });
  } else {
    process.stdout.write(`screenshot  ${display(output)} (${width}x${height}, ${bytes} bytes) via ${display(chrome)}\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  const [command, ...rest] = argv;
  if (command === "--version") {
    process.stdout.write(`naqsha ${readVersion()}\n`);
    return EXIT_OK;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  switch (command) {
    case "validate":
      return cmdValidate(rest);
    case "render":
      return cmdRender(rest);
    case "demo":
      return cmdDemo(rest);
    case "types":
      return cmdTypes(rest);
    case "version":
      return cmdVersion(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "screenshot":
      return cmdScreenshot(rest);
    case "diff":
      return cmdDiff(rest);
    case "path":
      return cmdPath(rest);
    case "convert":
      return cmdConvert(rest);
    case "mermaid":
      return cmdMermaid(rest);
    case "fix":
      return cmdFix(rest);
    case "install-skill":
      return cmdInstallSkill(rest);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`naqsha: ${error.message}\n\n${USAGE}`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    process.stderr.write(`naqsha: internal error: ${error && error.message ? error.message : String(error)}\n`);
    if (process.env.NAQSHA_DEBUG && error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    } else {
      process.stderr.write("set NAQSHA_DEBUG=1 for a stack trace\n");
    }
    process.exitCode = EXIT_FAIL;
  });
