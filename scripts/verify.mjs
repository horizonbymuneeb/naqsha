#!/usr/bin/env node
// naqsha acceptance harness: renders every example, then checks the artifact as
// a reader would (size, no network, determinism, layout sanity) and in a real
// browser (overflow, console errors, screenshot).
//
//   node scripts/verify.mjs [--chrome /path/to/chrome] [--out /tmp/naqsha-verify]
//
// Exit 0 only when every check passes.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(opt('out', join(process.env.TMPDIR || '/tmp', 'naqsha-verify')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = detectChrome(opt('chrome', process.env.NAQSHA_CHROME || ''));

function detectChrome(explicit) {
  const candidates = [explicit];
  try {
    const roots = [join(process.env.HOME, '.cache', 'ms-playwright')];
    for (const r of roots) {
      for (const d of readdirSync(r)) {
        if (!d.startsWith('chromium-')) continue;
        candidates.push(join(r, d, 'chrome-linux-arm64', 'chrome'), join(r, d, 'chrome-linux', 'chrome'), join(r, d, 'chrome-linux64', 'chrome'));
      }
    }
  } catch { /* no playwright cache */ }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  return candidates.find((c) => c && spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0) || null;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  return Boolean(ok);
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(ROOT, 'docs'), { recursive: true });

// ---------------------------------------------------------------- pipeline
const cli = join(ROOT, 'src', 'cli', 'naqsha.mjs');
const examples = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.json')).sort();
const artifacts = [];
const demoFiles = (() => {
  try { return readdirSync(join(ROOT, 'demo')).filter((f) => f.endsWith('.json')).sort().map((f) => ['demo', f]); }
  catch { return []; }
})();
const allInputs = [
  ...examples.map((f) => ['examples', f]),
  ...demoFiles,
];

for (const [folder, file] of allInputs) {
  const slug = file.replace(/\.json$/, '');
  const input = join(ROOT, folder, file);
  const html = join(OUT, `${slug}.html`);

  const v = spawnSync(process.execPath, [cli, 'validate', input, '--json'], { encoding: 'utf8' });
  check(`validate ${slug}`, v.status === 0, v.stdout.slice(0, 300));

  const r = spawnSync(process.execPath, [cli, 'render', input, html, '--json'], { encoding: 'utf8' });
  const ok = check(`render ${slug}`, r.status === 0 && readFileSync(html, { encoding: 'utf8' }).length > 0, r.stdout.slice(0, 300));
  if (!ok) continue;

  const buf = readFileSync(html);
  check(`size ${slug} <= 160KB`, buf.length <= 160 * 1024, `${buf.length} bytes`);
  const external = (buf.toString().match(/(?:src|href)=["']https?:\/\//g) || []).length;
  check(`offline ${slug}`, external === 0, `${external} external src/href`);
  const truncated = (buf.toString().match(/\u2026/g) || []).length;
  check(`no truncation ${slug}`, truncated === 0, `${truncated} ellipsis glyph(s) in output`);

  const html2 = join(OUT, `${slug}.second.html`);
  spawnSync(process.execPath, [cli, 'render', input, html2, '--json'], { encoding: 'utf8' });
  check(`deterministic ${slug}`, sha(readFileSync(html2)) === sha(buf), sha(buf).slice(0, 12));

  const scene = await layoutScene(input);
  check(`layout ${slug}`, scene.ok, scene.detail);
  artifacts.push({ slug, html });
}

// ------------------------------------------------------- browser evidence
if (!CHROME) {
  check('chrome available', false, 'no real Chrome/Chromium found; set NAQSHA_CHROME');
} else {
  const viewports = [{ name: 'desktop', w: 1440, h: 980 }, { name: 'mobile', w: 390, h: 844 }];
  for (const art of artifacts) {
    for (const vp of viewports) {
      const measured = await measureCdp(CHROME, art.html, vp.w, vp.h);
      check(`overflow ${art.slug} ${vp.name}`, measured.ok && measured.overflow === 0, measured.detail);
      check(`console ${art.slug} ${vp.name}`, measured.ok && measured.errors.length === 0, measured.detail);
      const png = join(ROOT, 'docs', vp.name === 'desktop' ? `shot-${art.slug}.png` : `shot-${art.slug}-mobile.png`);
      shoot(CHROME, art.html, png, vp.w, vp.h);
      check(`screenshot ${art.slug} ${vp.name}`, spawnSync('test', ['-s', png]).status === 0, png);
    }
  }
  // canonical README image
  const first = artifacts[0];
  if (first) shoot(CHROME, first.html, join(ROOT, 'docs', 'shot-desktop.png'), 1440, 980);
}

// --------------------------------------------------------- diff artifact
{
  const base = join(ROOT, 'examples', 'engine-repo.v31.architecture.json');
  const head = join(ROOT, 'examples', 'engine-repo.architecture.json');
  const out = join(OUT, 'drift.html');
  const r = spawnSync(process.execPath, [cli, 'diff', base, head, out, '--json'], { encoding: 'utf8' });
  const ok = check('diff artifact renders', r.status === 0 && readFileSync(out, 'utf8').length > 0, r.stdout.slice(0, 260));
  if (ok) {
    const doc = readFileSync(out, 'utf8');
    check('diff: added + changed classes present', /st-added/.test(doc) && /st-changed/.test(doc), 'st-added/st-changed (this pair has no removals)');
    check('diff: header chips', /diff-chips/.test(doc), 'diff-chips');
    check('diff: no truncation', !/\u2026/.test(doc), '0 ellipsis');
    artifacts.push({ slug: 'drift', html: out });
  }
  const pathResult = spawnSync(process.execPath, [cli, 'path', base, 'agent', 'artifact', '--json'], { encoding: 'utf8' });
  const parsed = (() => { try { return JSON.parse(pathResult.stdout); } catch { return null; } })();
  check('path: resolves a hop list', pathResult.status === 0 && parsed && parsed.hops > 0 && parsed.path[0] === 'agent', parsed ? `${parsed.hops} hops: ${parsed.path.join(' -> ')}` : 'no receipt');
  const badPath = spawnSync(process.execPath, [cli, 'path', base, 'agent', 'nope', '--json'], { encoding: 'utf8' });
  check('path: unknown node fails cleanly', badPath.status === 1, `exit ${badPath.status}`);
}

// ------------------------------------------------------------ mermaid ingest
{
  const fixtures = readdirSync(join(ROOT, 'test', 'mermaid')).filter((f) => f.endsWith('.mmd')).sort();
  let ok = 0;
  for (const fixture of fixtures) {
    const outJson = join(OUT, `conv-${fixture.replace(/\.mmd$/, '')}.json`);
    const r = spawnSync(process.execPath, [cli, 'convert', join(ROOT, 'test', 'mermaid', fixture), outJson, '--json'], { encoding: 'utf8' });
    if (r.status === 0) ok += 1;
  }
  check('convert: every mermaid fixture -> valid IR', ok === fixtures.length, `${ok}/${fixtures.length} fixtures`);
}

// ------------------------------------------------------- mermaid round-trip
{
  const inputs = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.json')).sort();
  let ok = 0;
  const detail = [];
  for (const file of inputs) {
    const mmd = join(OUT, `rt-${file.replace(/\.json$/, '')}.mmd`);
    const json = join(OUT, `rt-${file.replace(/\.json$/, '')}.json`);
    const out = spawnSync(process.execPath, [cli, 'mermaid', join(ROOT, 'examples', file), mmd, '--json'], { encoding: 'utf8' });
    const back = out.status === 0 ? spawnSync(process.execPath, [cli, 'convert', mmd, json, '--json'], { encoding: 'utf8' }) : null;
    if (out.status === 0 && back && back.status === 0) {
      const src = JSON.parse(readFileSync(join(ROOT, 'examples', file), 'utf8'));
      const rt = JSON.parse(readFileSync(json, 'utf8'));
      if (rt.nodes.length === src.nodes.length && (rt.edges || []).length === (src.edges || []).length) ok += 1;
      else detail.push(`${file}: ${rt.nodes.length}/${src.nodes.length} nodes`);
    } else detail.push(`${file}: export/convert failed`);
  }
  check('mermaid: IR -> Mermaid -> IR round-trip', ok === inputs.length, `${ok}/${inputs.length} examples${detail.length ? ` (${detail.join('; ')})` : ''}`);
}

// ------------------------------------------------------------ types catalog
{
  const r = spawnSync(process.execPath, [cli, 'types', '--json'], { encoding: 'utf8' });
  const parsed = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
  check('cli: ten diagram types listed', r.status === 0 && parsed && parsed.types.length === 10, parsed ? parsed.types.map((t) => t.name).join(',') : 'no receipt');
}

// ------------------------------------------------------------- layout sanity
async function layoutScene(input) {
  try {
    const { layout } = await import(pathToFileURL(join(ROOT, 'src', 'layout', 'index.mjs')).href);
    const ir = JSON.parse(readFileSync(input, 'utf8'));
    const a = JSON.stringify(layout(ir));
    const b = JSON.stringify(layout(ir));
    if (a !== b) return { ok: false, detail: 'layout is not deterministic' };
    const scene = JSON.parse(a);
    const W = scene.width, H = scene.height;
    const nodes = scene.nodes;
    for (const n of nodes) {
      if (n.x < 0 || n.y < 0 || n.x + n.w > W + 0.5 || n.y + n.h > H + 0.5) return { ok: false, detail: `node ${n.id} outside canvas` };
    }
    if (ir.type !== 'sequence') {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const p = nodes[i], q = nodes[j];
          const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
          if (overlap) return { ok: false, detail: `nodes ${p.id} and ${q.id} overlap` };
        }
      }
    }
    for (const e of scene.edges || []) {
      for (const pt of e.points || []) {
        if (pt.x < 0 || pt.y < 0 || pt.x > W + 0.5 || pt.y > H + 0.5) return { ok: false, detail: `edge ${e.id} outside canvas` };
      }
    }
    if (scene.axis) {
      const ticks = scene.axis.ticks || [];
      if (ticks.length < 3) return { ok: false, detail: `axis has ${ticks.length} ticks, expected >= 3` };
      for (let i = 1; i < ticks.length; i += 1) {
        if (!(ticks[i].x > ticks[i - 1].x)) return { ok: false, detail: `axis ticks not increasing at ${i}` };
      }
      const labels = ticks.map((t) => String(t.label));
      if (new Set(labels).size !== labels.length) return { ok: false, detail: `axis tick labels repeat: ${labels.join('|')}` };
      if (!(scene.axis.min < scene.axis.max)) return { ok: false, detail: 'axis min not below max' };
    }
    if (scene.type === 'waterfall' && scene.axis) {
      for (const n of nodes) {
        if (!n.bar) return { ok: false, detail: `span ${n.id} has no bar geometry` };
        if (n.bar.start < scene.axis.min - 0.5 || n.bar.start + n.bar.duration > scene.axis.max + 0.5) {
          return { ok: false, detail: `span ${n.id} outside the axis` };
        }
      }
    }
    if (scene.type === 'timeline' && scene.axis) {
      for (const n of nodes) {
        if (typeof n.at !== 'string' && typeof n.at !== 'number') return { ok: false, detail: `event ${n.id} has no at value` };
      }
    }
    return { ok: true, detail: `${W}x${H}, ${nodes.length} nodes, ${(scene.edges || []).length} edges${scene.axis ? `, axis ${scene.axis.ticks.length} ticks` : ''}${scene.lanes ? `, ${scene.lanes.length} lanes` : ''}` };
  } catch (error) {
    return { ok: false, detail: `layout unavailable: ${error.message}` };
  }
}

// -------------------------------------------------------------- chrome glue
function instrumented(html, outPath) {
  const marker = /<\/body>/i;
  const script = `<script>
window.__naqsha = { errors: [] };
addEventListener('error', (e) => window.__naqsha.errors.push(String(e.message || e.target)));
addEventListener('unhandledrejection', (e) => window.__naqsha.errors.push('rejection: ' + String(e.reason)));
addEventListener('load', () => {
  setTimeout(() => {
    const d = document.documentElement;
    const payload = { overflow: d.scrollWidth - innerWidth, sw: d.scrollWidth, iw: innerWidth,
      sh: d.scrollHeight, ih: innerHeight, errors: window.__naqsha.errors };
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'naqsha-measure');
    meta.setAttribute('content', JSON.stringify(payload));
    document.head.appendChild(meta);
  }, 50);
});
</script>`;
  let doc = readFileSync(html, 'utf8');
  doc = marker.test(doc) ? doc.replace(marker, `${script}</body>`) : `${doc}${script}`;
  writeFileSync(outPath, doc);
  return outPath;
}

function measure(chrome, html, w, h) {
  const tmp = join(OUT, `measured-${w}x${h}-${sha(readFileSync(html)).slice(0, 8)}.html`);
  try {
    instrumented(html, tmp);
    const out = execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      `--window-size=${w},${h}`, '--virtual-time-budget=4000', '--dump-dom', `file://${tmp}`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/<meta name="naqsha-measure" content="([^"]*)"/i);
    if (!m) return { ok: false, overflow: null, errors: ['measurement marker missing'], detail: 'no marker' };
    const payload = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    return { ok: true, overflow: payload.overflow, errors: payload.errors || [],
      detail: `sw=${payload.sw} iw=${payload.iw} overflow=${payload.overflow} errors=${(payload.errors || []).length}` };
  } catch (error) {
    return { ok: false, overflow: null, errors: [String(error.message)], detail: String(error.message).slice(0, 200) };
  }
}

// Headless Chrome clamps its window width to 500px, so viewport measurements run
// through the DevTools protocol with Emulation.setDeviceMetricsOverride. Node's
// built-in WebSocket keeps this dependency-free.
async function measureCdp(chrome, html, w, h) {
  const dir = join(OUT, `chrome-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      const lines = readFileSync(portFile, 'utf8').split('\n');
      if (lines[0]) port = Number(lines[0]);
    } catch { await sleep(100); }
  }
  if (!port) { child.kill('SIGKILL'); return { ok: false, overflow: null, errors: ['chrome devtools port unavailable'], detail: 'no devtools port' }; }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let seq = 0;
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(String(d.exception?.description || d.text || 'exception'));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    if (msg.method === 'Page.loadEventFired') loadSeen = true;
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  let loadSeen = false;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await send('Page.navigate', { url: `file://${html}` });
  for (let i = 0; i < 50 && !loadSeen; i++) await sleep(100);
  await sleep(350);
  const evaluated = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ overflow: document.documentElement.scrollWidth - innerWidth, sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight, title: document.title })`,
    returnByValue: true,
  });
  ws.close();
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  const value = evaluated.result?.result?.value;
  if (!value) return { ok: false, overflow: null, errors: [...errors, 'evaluate failed'], detail: JSON.stringify(evaluated).slice(0, 200) };
  const payload = JSON.parse(value);
  return { ok: true, overflow: payload.overflow, errors,
    detail: `vp=${w}x${h} sw=${payload.sw} iw=${payload.iw} overflow=${payload.overflow} errors=${errors.length}` };
}

function shoot(chrome, html, png, w, h) {
  // Chrome occasionally loses the screenshot race right after a CDP session on
  // the same box; one retry with a private profile makes it deterministic.
  for (let attempt = 0; attempt < 3; attempt++) {
    rmSync(png, { force: true });
    const profile = join(OUT, `shot-profile-${process.pid}-${attempt}`);
    try {
      execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
        `--user-data-dir=${profile}`, `--window-size=${w},${h}`, '--virtual-time-budget=4000',
        `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
    } catch { /* retry */ }
    rmSync(profile, { recursive: true, force: true });
    if (spawnSync('test', ['-s', png]).status === 0) return;
    execFileSync('sleep', ['0.4']);
  }
}

// ------------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nnaqsha verify — chrome: ${CHROME || 'none'}\n`);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`artifacts: ${OUT}`);
  process.exit(1);
}
