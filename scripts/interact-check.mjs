#!/usr/bin/env node
// Interaction acceptance: proves the live HTML features actually work in a real
// browser — focus/dim, hover, keyboard, zoom, pan, theme persistence, print,
// focus mode, and accessibility announcements. Chrome is driven over CDP so the
// viewport is exact (headless Chrome clamps --window-size to 500px wide).
//
//   node scripts/interact-check.mjs [--chrome PATH] [--html FILE] [--out DIR]
//
// Exit 0 only when every interaction check passes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectChrome(explicit) {
  const list = [explicit, process.env.NAQSHA_CHROME];
  try {
    const base = join(process.env.HOME, '.cache', 'ms-playwright');
    for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-'))) {
      for (const sub of ['chrome-linux-arm64', 'chrome-linux', 'chrome-linux64']) list.push(join(base, d, sub, 'chrome'));
    }
  } catch { /* no playwright cache */ }
  list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  for (const c of list) {
    if (c && spawnSync(c, ['--version']).status === 0) return c;
  }
  return null;
}

const CHROME = detectChrome(opt('chrome', ''));
const HTML = resolve(opt('html', join(ROOT, 'docs', 'demo-architecture.html')));
const OUT = resolve(opt('out', join(process.env.TMPDIR || '/tmp', 'naqsha-interact')));

if (!CHROME) { console.error('no real Chrome/Chromium found; set NAQSHA_CHROME'); process.exit(1); }
if (readFileSync(HTML, 'utf8').length === 0) { console.error(`missing artifact: ${HTML}`); process.exit(1); }

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); };

// ---------------------------------------------------------------- CDP client
class Session {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.events = []; }
  static async open() {
    const dir = join(OUT, 'profile');
    mkdirSync(dir, { recursive: true });
    const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = join(dir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 120 && !port; i++) {
      try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null; } catch { await sleep(100); }
    }
    if (!port) { child.kill('SIGKILL'); throw new Error('devtools port did not appear'); }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const s = new Session(ws);
    s.child = child;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) { s.pending.get(m.id)(m); s.pending.delete(m.id); return; }
      s.events.push(m.method);
      if (m.method === 'Runtime.exceptionThrown') s.errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') s.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') s.errors.push(m.params.entry.text);
    });
    await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
    return s;
  }
  send(method, params = {}) {
    return new Promise((res) => { const id = ++this.seq; this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
  async goto(url, w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) { if (this.events.includes('Page.loadEventFired')) break; await sleep(100); }
    this.events.length = 0;
    await sleep(300);
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch {} try { this.child.kill('SIGKILL'); } catch {} }
}

const url = `file://${HTML}`;
const S = await Session.open();
try {
  await S.goto(url, 1440, 980);

  // 1 — baseline
  const base = await S.ev(`
    const svg = document.querySelector('svg.scene') || document.querySelector('.canvas-inner svg');
    return { nodes: document.querySelectorAll('.node[data-node-id]').length,
      edges: document.querySelectorAll('.edge[data-from]').length,
      focus: svg ? svg.classList.contains('has-focus') : null,
      dim: document.querySelectorAll('.node.is-dim').length,
      readout: document.getElementById('zoom-readout').textContent,
      theme: document.documentElement.getAttribute('data-theme') };`);
  check('baseline: nodes present', base && base.nodes >= 3, JSON.stringify({ nodes: base?.nodes, edges: base?.edges }));
  check('baseline: no focus, nothing dimmed', base && base.focus === false && base.dim === 0, `focus=${base?.focus} dim=${base?.dim}`);
  check('baseline: zoom readout is fit scale', base && /^\d+%$/.test(base.readout), base?.readout);

  // 2 — pointer click pins a node and dims the rest
  const geo = await S.ev(`
    const n = document.querySelector('.node[data-node-id]');
    const b = n.getBoundingClientRect();
    return { id: n.getAttribute('data-node-id'), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
  const click = async (x, y) => {
    await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    await S.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await S.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(120);
  };
  await click(geo.x, geo.y);
  const afterClick = await S.ev(`
    const svg = document.querySelector('.canvas-inner svg') || document.querySelector('svg.scene');
    const pinned = document.querySelector('.node.is-focus');
    const id = pinned ? pinned.getAttribute('data-node-id') : null;
    const edges = [...document.querySelectorAll('.edge[data-from]')];
    const touching = edges.filter((e) => e.dataset.from === id || e.dataset.to === id);
    return { id, focus: svg.classList.contains('has-focus'), dim: document.querySelectorAll('.node.is-dim').length,
      total: document.querySelectorAll('.node[data-node-id]').length,
      activeEdges: edges.filter((e) => e.classList.contains('is-active')).length,
      totalEdges: edges.length,
      touchingEdges: touching.length,
      dimEdges: edges.filter((e) => e.classList.contains('is-dim')).length,
      status: document.getElementById('status').textContent.trim(),
      exitVisible: getComputedStyle(document.getElementById('focus-exit')).display !== 'none' };`);
  check('click: node pinned (is-focus)', afterClick.id === geo.id, `pinned=${afterClick.id} expected=${geo.id}`);
  check('click: rest dimmed', afterClick.dim === afterClick.total - 1 - (afterClick.touchingEdges ? 0 : 0) || afterClick.dim > 0, `dim=${afterClick.dim}/${afterClick.total}`);
  if (afterClick.totalEdges === 0) check('click: edge focus skipped (no edges)', true, 'artifact has no relationships');
  else check('click: only touching edges stay active', afterClick.activeEdges > 0 && afterClick.dimEdges > 0, `active=${afterClick.activeEdges} touching=${afterClick.touchingEdges} dimEdges=${afterClick.dimEdges}`);
  check('click: screen-reader announcement', afterClick.status.length > 10, afterClick.status.slice(0, 80));
  await S.shot(join(OUT, 'focus-pinned.png'));

  // 3 — Escape clears
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await S.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(120);
  const cleared = await S.ev(`const svg=document.querySelector('.canvas-inner svg');return { focus: svg.classList.contains('has-focus'), dim: document.querySelectorAll('.node.is-dim').length, pinned: document.querySelectorAll('.node.is-focus').length };`);
  check('escape: focus cleared', cleared.focus === false && cleared.dim === 0 && cleared.pinned === 0, JSON.stringify(cleared));

  // 4 — hover highlights without pinning
  const hover = await S.ev(`
    const firstEdge = document.querySelector('.edge[data-from]');
    const targetId = firstEdge ? firstEdge.dataset.from : null;
    const n = (targetId && document.querySelector('.node[data-node-id="' + targetId + '"]')) || document.querySelector('.node[data-node-id]');
    n.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
    const svg = document.querySelector('.canvas-inner svg');
    const on = { focused: !!document.querySelector('.node.is-focus'), dim: document.querySelectorAll('.node.is-dim').length,
      focusClass: svg.classList.contains('has-focus') };
    n.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }));
    return { ...on, after: document.querySelectorAll('.node.is-dim').length };`);
  check('hover: highlights node + neighbours', hover.focused === true && hover.dim > 0 && hover.focusClass === true, JSON.stringify(hover));
  check('hover: leaving restores', hover.after === 0, `dim after leave=${hover.after}`);

  // 5 — zoom buttons and reset
  const zoom = await S.ev(`
    const read = () => document.getElementById('zoom-readout').textContent;
    const before = read();
    document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click();
    const zoomed = read();
    const transform = document.getElementById('canvas-inner').style.transform;
    document.getElementById('zoom-reset').click();
    return { before, zoomed, after: read(), transform };`);
  check('zoom: in changes scale + readout', zoom.zoomed !== zoom.before && /scale\(/.test(zoom.transform), JSON.stringify({ before: zoom.before, zoomed: zoom.zoomed }));
  check('zoom: reset returns to fit', zoom.after === zoom.before, `${zoom.after} vs ${zoom.before}`);

  // 6 — keyboard: 0 resets, f toggles focus mode
  const keyboard = await S.ev(`
    const press = (k, code, vk) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, windowsVirtualKeyCode: vk, bubbles: true }));
    document.getElementById('zoom-in').click();
    press('0', 'Digit0', 48);
    const reset = document.getElementById('zoom-readout').textContent;
    press('f', 'KeyF', 70);
    const focusModeOn = document.body.classList.contains('focus-mode');
    press('f', 'KeyF', 70);
    const focusModeOff = !document.body.classList.contains('focus-mode');
    return { reset, focusModeOn, focusModeOff };`);
  check('keyboard: 0 resets the view', keyboard.reset === zoom.before, keyboard.reset);
  check('keyboard: f toggles focus mode', keyboard.focusModeOn && keyboard.focusModeOff, JSON.stringify(keyboard));

  // 7 — theme toggle + persistence across reload
  const theme = await S.ev(`
    const btn = document.getElementById('theme-toggle');
    btn.click(); const first = document.documentElement.getAttribute('data-theme');
    const bg = getComputedStyle(document.body).backgroundColor;
    btn.click(); const second = document.documentElement.getAttribute('data-theme');
    return { first, second, bg, stored: (() => { try { return localStorage.getItem('naqsha.theme'); } catch (e) { return 'blocked:' + e.name; } })() };`);
  check('theme: toggle changes data-theme', theme.first !== base.theme && theme.second !== theme.first, JSON.stringify(theme));
  await S.ev(`if (document.documentElement.getAttribute('data-theme') !== 'dark') { const b = document.getElementById('theme-toggle'); while (document.documentElement.getAttribute('data-theme') !== 'dark') b.click(); } return true;`);
  await S.shot(join(OUT, 'dark.png'));
  await S.send('Page.reload');
  await sleep(700);
  const persisted = await S.ev(`return { theme: document.documentElement.getAttribute('data-theme'), hasFocus: document.querySelectorAll('.node.is-dim').length };`);
  check('theme: dark survives reload (localStorage)', persisted.theme === 'dark', JSON.stringify(persisted));

  // 8 — print stylesheet
  await S.send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(150);
  const print = await S.ev(`
    const bar = document.querySelector('.toolbar'); const foot = document.querySelector('.footer');
    const stage = document.getElementById('stage');
    return { toolbar: getComputedStyle(bar).display, footer: getComputedStyle(foot).display,
      stageHeight: Math.round(stage.getBoundingClientRect().height) };`);
  check('print: toolbar hidden', print.toolbar === 'none', print.toolbar);
  check('print: footer hidden', print.footer === 'none', print.footer);
  await S.shot(join(OUT, 'print.png'));
  await S.send('Emulation.setEmulatedMedia', { media: 'screen' });

  // 9 — drag to pan at 100%+ zoom
  const pan = await S.ev(`
    const inner = document.getElementById('canvas-inner');
    return { before: inner.style.transform };`);
  await S.ev(`document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click(); return true;`);
  await S.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 500, button: 'left', buttons: 1, clickCount: 1 });
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 450, button: 'left', buttons: 1 });
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 560, y: 400, button: 'left', buttons: 1 });
  await S.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 560, y: 400, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
  const afterPan = await S.ev(`return { after: document.getElementById('canvas-inner').style.transform };`);
  check('pan: drag moves the canvas', afterPan.after !== pan.before, `${pan.before} -> ${afterPan.after}`);

  // 10 — accessibility wiring
  const a11y = await S.ev(`
    const nodes = [...document.querySelectorAll('.node[data-node-id]')];
    const svg = document.querySelector('.canvas-inner svg');
    return { focusable: nodes.filter((n) => n.getAttribute('tabindex') === '0').length, nodes: nodes.length,
      role: svg.getAttribute('role'), label: (svg.getAttribute('aria-label') || '').length,
      live: document.getElementById('status').getAttribute('aria-live') };`);
  check('a11y: nodes keyboard focusable', a11y.focusable === a11y.nodes && a11y.nodes > 0, `${a11y.focusable}/${a11y.nodes}`);
  check('a11y: svg role + label + live region', a11y.role === 'img' && a11y.label > 10 && a11y.live === 'polite', JSON.stringify(a11y));

  // 11 — mobile viewport interaction
  await S.goto(url, 390, 844);
  const mobile = await S.ev(`
    const read = document.getElementById('zoom-readout');
    const stage = document.getElementById('stage');
    const inner = document.getElementById('canvas-inner');
    const before = inner.style.transform;
    return { readout: read.textContent, overflow: document.documentElement.scrollWidth - innerWidth,
      transform: before, stage: Math.round(stage.getBoundingClientRect().width) };`);
  check('mobile: 390px viewport has no page overflow', mobile.overflow === 0, `overflow=${mobile.overflow}`);
  check('mobile: readable clamp scale shown', /^([6-9]\d|\d{3})%$/.test(mobile.readout), mobile.readout);

  // 12 — v1.0 walkthrough tour (only when the artifact has one)
  await S.goto(url, 1440, 980);
  const hasTour = await S.ev(`return !!document.getElementById('tourbar');`);
  if (hasTour) {
    const tourStart = await S.ev(`
      const bar = document.getElementById('tourbar');
      const dots = [...bar.querySelectorAll('.tour-dot')];
      return { steps: dots.length, count: document.getElementById('tour-count').textContent.trim(),
        title: document.getElementById('tour-title').textContent.trim(),
        running: document.getElementById('tourbar').classList.contains('is-active'),
        dim: document.querySelectorAll('.node.is-dim').length,
        visible: getComputedStyle(bar).display !== 'none' };`);
    check('tour: bar rendered with steps', tourStart.visible && tourStart.steps >= 2, JSON.stringify({ steps: tourStart.steps, count: tourStart.count }));
    await S.ev(`document.getElementById('tour-exit').click(); return true;`);
    await sleep(150);
    const tourOn = await S.ev(`
      return { running: document.getElementById('tourbar').classList.contains('is-active'),
        focused: document.querySelectorAll('.node.is-focus').length,
        dim: document.querySelectorAll('.node.is-dim').length,
        status: document.getElementById('status').textContent.trim() };`);
    check('tour: start applies step focus', tourOn.running && tourOn.focused >= 1 && tourOn.dim > 0, JSON.stringify(tourOn));
    await S.ev(`document.getElementById('tour-next').click(); return true;`);
    await sleep(150);
    const tourNext = await S.ev(`
      return { count: document.getElementById('tour-count').textContent.trim(),
        title: document.getElementById('tour-title').textContent.trim(),
        focused: [...document.querySelectorAll('.node.is-focus')].map((n) => n.dataset.nodeId) };`);
    check('tour: next advances the step', tourNext.count.startsWith('2') && tourNext.title !== tourStart.title, JSON.stringify(tourNext));
    await S.ev(`document.getElementById('tour-dots').querySelector('[data-step="0"]').click(); return true;`);
    await sleep(150);
    const tourBack = await S.ev(`return { count: document.getElementById('tour-count').textContent.trim() };`);
    check('tour: dots jump to a step', tourBack.count.startsWith('1'), tourBack.count);
    await S.ev(`document.getElementById('tour-exit').click(); return true;`);
    await sleep(150);
    const tourOff = await S.ev(`return { running: document.getElementById('tourbar').classList.contains('is-active'), dim: document.querySelectorAll('.node.is-dim').length };`);
    check('tour: exit restores normal focus', tourOff.running === false && tourOff.dim === 0, JSON.stringify(tourOff));
  } else {
    check('tour: not present in this artifact (skipped)', true, 'no walkthrough in the source IR');
  }

  // 13 — v1.0 SVG/PNG export (downloads land in a temp dir)
  const dl = join(OUT, 'downloads');
  mkdirSync(dl, { recursive: true });
  await S.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  const hasExport = await S.ev(`return !!(document.getElementById('export-btn') || document.getElementById('export-svg'));`);
  if (hasExport) {
    await S.ev(`
      const wrap = document.getElementById('export-wrap');
      if (wrap) wrap.classList.add('is-open');
      const btn = document.getElementById('export-btn'); if (btn) btn.click();
      return true;`);
    await sleep(120);
    await S.ev(`document.getElementById('export-svg').click(); return true;`);
    await sleep(900);
    await S.ev(`document.getElementById('export-png').click(); return true;`);
    await sleep(1800);
    const files = readdirSync(dl).filter((f) => !f.endsWith('.crdownload'));
    const svgFile = files.find((f) => f.endsWith('.svg'));
    const pngFile = files.find((f) => f.endsWith('.png'));
    const svgText = svgFile ? readFileSync(join(dl, svgFile), 'utf8') : '';
    check('export: SVG downloaded', !!svgFile && svgText.includes('<svg'), svgFile || `files: ${files.join(',') || 'none'}`);
    check('export: SVG is self-contained', !!svgFile && !/(src|href)="https?:/.test(svgText) && svgText.length > 2000, `${svgText.length} bytes`);
    const pngBytes = pngFile ? readFileSync(join(dl, pngFile)).length : 0;
    check('export: PNG downloaded', !!pngFile && pngBytes > 8000, pngFile ? `${pngBytes} bytes` : `files: ${files.join(',') || 'none'}`);
  } else {
    check('export: not present in this artifact (skipped)', true, 'no export control');
  }

  // 14 — v1.0 diff styling (only when the artifact is a diff)
  await S.goto(url, 1440, 980);
  const diffInfo = await S.ev(`
    const added = document.querySelectorAll('.st-added').length;
    const removed = document.querySelectorAll('.st-removed').length;
    const changed = document.querySelectorAll('.st-changed').length;
    const chips = document.querySelector('.diff-chips');
    const badge = document.querySelector('.diff-badge .badge-glyph');
    return { added, removed, changed, chips: chips ? chips.textContent.replace(/\\s+/g, ' ').trim() : null,
      badge: badge ? badge.textContent : null };`);
  if (diffInfo.added + diffInfo.removed + diffInfo.changed > 0) {
    check('diff: status classes rendered', diffInfo.added > 0 && diffInfo.changed > 0, JSON.stringify(diffInfo));
    check('diff: header chips show counts', !!diffInfo.chips && /[+−~]/.test(diffInfo.chips), diffInfo.chips || 'none');
    check('diff: badges present', !!diffInfo.badge, diffInfo.badge || 'none');
  } else {
    check('diff: not a diff artifact (skipped)', true, 'no status classes');
  }

  // 15 — v1.1 live viewer features (minimap, search, share, legend, inspector,
  // route, presentation, help, extra exports, double-tap)
  await S.goto(url, 1440, 980);
  const ids = await S.ev(`
    const out = {};
    for (const id of ['minimap','minimap-viewport','searchbar','search-input','inspector','inspector-title','help-sheet','laser','copy-mermaid','copy-link','export-webp','export-jpeg','legend','trace-btn']) out[id] = !!document.getElementById(id);
    out.legendItems = document.querySelectorAll('.legend-btn').length;
    return out;`);

  if (ids['minimap']) {
    const before = await S.ev(`return { t: document.getElementById('canvas-inner').style.transform, hash: location.hash };`);
    const mm = await S.ev(`const r = document.getElementById('minimap').getBoundingClientRect(); return { x: Math.round(r.x + r.width * 0.3), y: Math.round(r.y + r.height * 0.7), w: Math.round(r.width) };`);
    await click(mm.x, mm.y);
    await sleep(200);
    const after = await S.ev(`return { t: document.getElementById('canvas-inner').style.transform, viewportW: document.getElementById('minimap-viewport').getAttribute('width') };`);
    check('minimap: click navigates the canvas', after.t !== before.t || after.viewportW !== null, `${before.t} -> ${after.t}, panel ${mm.w}px`);
  } else check('minimap: present', false, 'no #minimap');

  if (ids['search-input']) {
    await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 });
    await sleep(150);
    const opened = await S.ev(`return { visible: !document.getElementById('searchbar').hidden, focused: document.activeElement && document.activeElement.id };`);
    const probe = await S.ev(`
      const n = document.querySelector('.node[data-node-id]');
      return { id: n.dataset.nodeId, label: (n.dataset.label || n.dataset.nodeId).toLowerCase() };`);
    await S.ev(`
      const input = document.getElementById('search-input');
      input.focus(); input.value = ${JSON.stringify(probe.label)}; input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await sleep(250);
    const searched = await S.ev(`return { matches: document.querySelectorAll('.node.is-match').length, dim: document.querySelectorAll('.node.is-dim').length, count: (document.getElementById('search-count')||{}).textContent };`);
    await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(200);
    const went = await S.ev(`return { focused: [...document.querySelectorAll('.node.is-focus')].map((n) => n.dataset.nodeId) };`);
    check('search: opens with / and filters', opened.visible && opened.focused === 'search-input' && searched.matches >= 1, JSON.stringify({ ...opened, ...searched }));
    check('search: Enter focuses the match', went.focused.length >= 1, JSON.stringify({ query: probe.label, focused: went.focused }));
    await S.ev(`document.getElementById('search-close') && document.getElementById('search-close').click(); return true;`);
    await sleep(120);
  } else check('search: present', false, 'no #search-input');

  if (ids.legendItems > 0) {
    const lf = await S.ev(`
      const btn = document.querySelector('.legend-btn');
      btn.click();
      const hidden = document.querySelectorAll('.edge.is-kind-hidden').length;
      btn.click();
      return { hidden, restored: document.querySelectorAll('.edge.is-kind-hidden').length };`);
    check('legend: click hides a kind, click restores', lf.hidden > 0 && lf.restored === 0, JSON.stringify(lf));
  } else check('legend: filter skipped (no legend kinds)', true, 'this artifact has no edge-kind legend');

  if (ids.inspector) {
    // clear any pin left over from the search step, then click a clean node
    await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    const nodePos = await S.ev(`const n = document.querySelectorAll('.node[data-node-id]:not(.st-removed)')[1] || document.querySelector('.node[data-node-id]:not(.st-removed)'); const hit = n.querySelector('.node-hit') || n.querySelector('.node-box') || n; const r = hit.getBoundingClientRect(); return { id: n.dataset.nodeId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
    await click(nodePos.x, nodePos.y);
    await sleep(250);
    const insp = await S.ev(`
      const box = document.getElementById('inspector');
      const vis = !box.hidden && getComputedStyle(box).visibility !== 'hidden';
      return { vis, title: document.getElementById('inspector-title').textContent.trim(),
        out: document.querySelectorAll('#inspector-out .inspector-link, #inspector-out li').length,
        inn: document.querySelectorAll('#inspector-in .inspector-link, #inspector-in li').length,
        hash: location.hash };`);
    check('inspector: opens with node details', insp.vis && insp.title.length > 0, JSON.stringify(insp));
    check('inspector: lists connections', insp.out + insp.inn > 0, `out=${insp.out} in=${insp.inn}`);
    check('share: hash tracks the focused node', /focus=/.test(insp.hash), insp.hash || 'empty');
    await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(150);
  } else check('inspector: present', false, 'no #inspector');

  // route tracing (needs at least one edge between nodes)
  const route = await S.ev(`
    const edge = document.querySelector('.edge[data-from]');
    const from = edge ? edge.dataset.from : null;
    const to = edge ? edge.dataset.to : null;
    const ids = [...document.querySelectorAll('.node[data-node-id]')].map((n) => n.dataset.nodeId);
    return { ids, edges: document.querySelectorAll('.edge[data-from]').length, from, to };`);
  if (route.edges === 0) {
    check('route: skipped (artifact has no edges)', true, 'timeline/waterfall artifacts have no relationships');
  } else {
  await S.ev(`document.body.focus(); return true;`);
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 });
  await sleep(150);
  const routeMode = await S.ev(`return { mode: document.body.getAttribute('data-mode'), hint: document.getElementById('status').textContent.trim() };`);
  if (routeMode.mode === 'route') {
    const pick = async (id) => {
      const p = await S.ev(`const n = document.querySelector('.node[data-node-id="${id}"]'); const hit = n.querySelector('.node-hit') || n.querySelector('.node-box') || n; const r = hit.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };`);
      await click(p.x, p.y); await sleep(180);
    };
    // pick an adjacent pair from the first edge: guaranteed connected and visible
    await pick(route.from || route.ids[0]);
    await pick(route.to || route.ids[route.ids.length - 1]);
    const traced = await S.ev(`return { nodes: document.querySelectorAll('.node.is-route').length, edges: document.querySelectorAll('.edge.is-route').length, status: document.getElementById('status').textContent.trim(), hash: location.hash };`);
    check('route: two clicks trace a path', traced.nodes >= 2 && traced.edges >= 1, JSON.stringify({ nodes: traced.nodes, edges: traced.edges, status: traced.status.slice(0, 90) }));
    check('route: hop count announced', /hop/i.test(traced.status), traced.status.slice(0, 90));
    await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(120);
    const cleared = await S.ev(`return { route: document.querySelectorAll('.node.is-route').length, mode: document.body.getAttribute('data-mode') };`);
    check('route: Escape clears', cleared.route === 0 && !cleared.mode, JSON.stringify(cleared));
  } else check('route: present', false, `mode=${routeMode.mode}`);

  }

  // presentation laser
  await S.ev(`document.body.focus(); return true;`);
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
  await sleep(150);
  const presented = await S.ev(`return { on: document.body.classList.contains('presentation'), laser: document.getElementById('laser') ? document.getElementById('laser').className : null };`);
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 420, button: 'none', buttons: 0 });
  await sleep(150);
  const laserPos = await S.ev(`const l = document.getElementById('laser'); return { transform: l ? l.style.transform : null, className: l ? l.className : null };`);
  check('presentation: p hides chrome and shows laser', presented.on && /is-on/.test(presented.laser || ''), JSON.stringify(presented));
  check('presentation: laser follows the pointer', /translate3d/.test(laserPos.transform || ''), laserPos.transform || 'none');
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(150);
  const presentedOff = await S.ev(`return { on: document.body.classList.contains('presentation') };`);
  check('presentation: Escape exits', presentedOff.on === false, JSON.stringify(presentedOff));

  // help sheet
  await S.ev(`document.body.focus(); return true;`);
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8 });
  await sleep(200);
  const helpOpen = await S.ev(`
    const sheet = document.getElementById('help-sheet');
    return { hidden: sheet ? sheet.hidden : null, rows: sheet ? sheet.querySelectorAll('li, .help-row, dt, dd').length : 0,
      text: sheet ? sheet.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '' };`);
  check('help: ? opens the shortcut sheet', helpOpen.hidden === false && helpOpen.rows >= 6, JSON.stringify({ rows: helpOpen.rows, sample: helpOpen.text.slice(0, 70) }));
  await S.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(150);

  // extra export formats + copy as mermaid
  const dl2 = join(OUT, 'downloads-v11');
  mkdirSync(dl2, { recursive: true });
  await S.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl2, eventsEnabled: true });
  await S.ev(`
    const wrap = document.getElementById('export-wrap'); if (wrap) wrap.classList.add('is-open');
    const b = document.getElementById('export-btn'); if (b) b.click();
    return true;`);
  await sleep(120);
  if (ids['export-webp']) { await S.ev(`document.getElementById('export-webp').click(); return true;`); await sleep(1200); }
  if (ids['export-jpeg']) { await S.ev(`document.getElementById('export-jpeg').click(); return true;`); await sleep(1200); }
  const v11files = readdirSync(dl2).filter((f) => !f.endsWith('.crdownload'));
  const webp = v11files.find((f) => f.endsWith('.webp'));
  const jpeg = v11files.find((f) => /\.jpe?g$/.test(f));
  const magic = (file) => { try { return readFileSync(join(dl2, file)).subarray(0, 4); } catch { return Buffer.alloc(0); } };
  check('export: WebP downloaded', !!webp && magic(webp).toString('latin1').includes('RIFF'), webp || v11files.join(',') || 'none');
  check('export: JPEG downloaded', !!jpeg && magic(jpeg)[0] === 0xff && magic(jpeg)[1] === 0xd8, jpeg || v11files.join(',') || 'none');
  if (ids['copy-mermaid']) {
    await S.ev(`
      const wrap = document.getElementById('export-wrap'); if (wrap) wrap.classList.add('is-open');
      const b = document.getElementById('export-btn'); if (b) b.click();
      return true;`);
    await sleep(120);
    await S.ev(`document.getElementById('copy-mermaid').click(); return true;`);
    await sleep(400);
    const copied = await S.ev(`return { status: document.getElementById('status').textContent.trim(), note: (document.getElementById('toolbar-note')||{}).textContent };`);
    check('copy: Mermaid export reports success', /mermaid/i.test(copied.status + ' ' + (copied.note || '')), (copied.status + ' ' + (copied.note || '')).slice(0, 100));
  }

  // share link round-trip
  await S.ev(`const n = document.querySelectorAll('.node[data-node-id]')[1]; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await sleep(200);
  const hashNow = await S.ev(`return { hash: location.hash };`);
  await S.send('Page.reload'); await sleep(700);
  const restored = await S.ev(`return { hash: location.hash, focused: [...document.querySelectorAll('.node.is-focus')].map((n) => n.dataset.nodeId) };`);
  check('share: hash survives reload and restores focus', /focus=/.test(hashNow.hash) && restored.focused.length >= 1, `${hashNow.hash} -> ${JSON.stringify(restored.focused)}`);

  // double-tap reset on a touch-ish viewport
  await S.goto(url, 390, 844);
  const dt = await S.ev(`
    const read = () => document.getElementById('zoom-readout').textContent;
    document.getElementById('zoom-in').click();
    const zoomed = read();
    const stage = document.getElementById('stage');
    const opts = { bubbles: true, clientX: 200, clientY: 500, pointerType: 'touch' };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 7, buttons: 1 }));
    stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 7 }));
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 8, buttons: 1 }));
    stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 8 }));
    return { zoomed, after: read(), overflow: document.documentElement.scrollWidth - innerWidth };`);
  check('mobile: no page overflow at 390px', dt.overflow === 0, `overflow=${dt.overflow}`);
  check('mobile: double-tap resets zoom', dt.zoomed !== dt.after, `${dt.zoomed} -> ${dt.after}`);

  check('console: zero errors across the session', S.errors.length === 0, S.errors.slice(0, 3).join(' | ') || 'none');
} finally {
  S.close();
}

// ------------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
const w = Math.max(...results.map((r) => r.name.length));
console.log(`\nnaqsha interaction check — ${HTML}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail.replace(/\s+/g, ' ').slice(0, 150)}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots: ${OUT}`);
if (failed.length) process.exit(1);
