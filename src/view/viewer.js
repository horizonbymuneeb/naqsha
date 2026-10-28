/* naqsha viewer — multi-focus walkthrough, hover/click focus, wheel zoom, drag
   pan, theme, SVG/PNG export, print. Self-contained: no network, no dependencies,
   no storage beyond the theme choice. Tour data arrives as window.__NAQSHA and
   the source IR as <script id="naqsha-ir">, which powers search, the inspector,
   route tracing, share hashes and the in-page export extras. */
(function () {
  "use strict";

  var doc = document;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var $ = function (id) { return doc.getElementById(id); };
  var slice = function (list) { return Array.prototype.slice.call(list); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  var sa = function (el, name, value) { el.setAttribute(name, value); };
  var esc = function (text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, function (ch) {
      return "&#" + ch.charCodeAt(0) + ";";
    });
  };
  var html = doc.documentElement;
  var CONFIG = window.__NAQSHA || {};
  var TOUR_STEPS = Array.isArray(CONFIG.tour) ? CONFIG.tour : [];
  var SCENE = {
    slug: CONFIG.slug || "naqsha",
    type: CONFIG.type || "diagram",
    width: Number(CONFIG.width) > 0 ? Number(CONFIG.width) : 800,
    height: Number(CONFIG.height) > 0 ? Number(CONFIG.height) : 600
  };

  var NODE_KINDS = ["service", "datastore", "actor", "external", "queue", "compute", "security", "state", "note"];
  var EDGE_KINDS = ["main", "return", "async", "security", "message", "data",
    "extends", "implements", "composition", "association", "dependency"];
  var GROUP_KINDS = ["zone", "boundary", "fragment"];

  /* ---- source IR: nodes in declaration order, undirected adjacency ------ */

  var MODEL = { title: "", type: SCENE.type, direction: "", nodes: [], edges: [], groups: [] };
  var BY_ID = Object.create(null);
  var ADJ = Object.create(null);

  function readModel() {
    var el = $("naqsha-ir");
    if (!el) return;
    var raw = null;
    try { raw = JSON.parse(el.textContent || "null"); } catch (err) { raw = null; }
    if (!raw || typeof raw !== "object") return;
    MODEL.title = typeof raw.title === "string" ? raw.title : "";
    MODEL.type = typeof raw.type === "string" ? raw.type : SCENE.type;
    MODEL.direction = raw.direction === "LR" ? "LR" : "TB";
    var nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    var edges = Array.isArray(raw.edges) ? raw.edges : [];
    nodes.forEach(function (node) {
      if (!node || typeof node.id !== "string" || BY_ID[node.id]) return;
      var item = {
        id: node.id,
        label: node.label == null ? node.id : String(node.label),
        sublabel: node.sublabel == null ? "" : String(node.sublabel),
        kind: NODE_KINDS.indexOf(node.kind) >= 0 ? node.kind : "service",
        group: node.group == null ? null : String(node.group),
        status: node.status == null ? "" : String(node.status)
      };
      MODEL.nodes.push(item);
      BY_ID[item.id] = item;
      ADJ[item.id] = [];
    });
    edges.forEach(function (edge) {
      if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") return;
      if (!BY_ID[edge.from] || !BY_ID[edge.to] || edge.from === edge.to) return;
      var item = {
        from: edge.from,
        to: edge.to,
        label: edge.label == null ? "" : String(edge.label),
        kind: EDGE_KINDS.indexOf(edge.kind) >= 0 ? edge.kind : "main",
        status: edge.status == null ? "" : String(edge.status),
        key: edge.from + "|" + edge.to + "|" + (edge.kind || "main") + "|" + (edge.label == null ? "" : String(edge.label))
      };
      MODEL.edges.push(item);
      ADJ[edge.from].push({ to: edge.to, edge: item });
      ADJ[edge.to].push({ to: edge.from, edge: item });
    });
    var groups = Array.isArray(raw.groups) ? raw.groups : [];
    groups.forEach(function (group) {
      if (!group || typeof group.id !== "string") return;
      MODEL.groups.push({
        id: group.id,
        label: group.label == null ? "" : String(group.label),
        kind: GROUP_KINDS.indexOf(group.kind) >= 0 ? group.kind : "zone"
      });
    });
  }

  readModel();

  function nodeLabel(id) {
    return BY_ID[id] ? BY_ID[id].label : String(id);
  }

  function plural(count, one, many) {
    return count + " " + (count === 1 ? one : many);
  }

  var stage = $("stage");
  var canvas = $("canvas-inner");
  var svg = $("diagram");
  var statusEl = $("status");
  var themeBtn = $("theme-toggle");
  var zoomOutBtn = $("zoom-out");
  var zoomInBtn = $("zoom-in");
  var zoomResetBtn = $("zoom-reset");
  var printBtn = $("print-btn");
  var zoomReadout = $("zoom-readout");
  var focusExitBtn = $("focus-exit");
  var tourbar = $("tourbar");
  var tourPrevBtn = $("tour-prev");
  var tourNextBtn = $("tour-next");
  var tourCountEl = $("tour-count");
  var tourTitleEl = $("tour-title");
  var tourTextEl = $("tour-text");
  var tourDots = tourbar ? slice(tourbar.querySelectorAll(".tour-dot")) : [];
  var tourExitBtn = $("tour-exit");
  var tourExitLabel = $("tour-exit-label");
  var exportWrap = $("export-wrap");
  var exportBtn = $("export-btn");
  var exportMenu = $("export-menu");
  var exportSvgBtn = $("export-svg");
  var exportPngBtn = $("export-png");
  var exportWebpBtn = $("export-webp"), exportJpegBtn = $("export-jpeg");
  var copyMermaidBtn = $("copy-mermaid"), copyJsonBtn = $("copy-json");
  var findB = $("search-btn"), traceB = $("trace-btn"), linkB = $("copy-link");
  var presentB = $("present-btn"), helpB = $("help-btn");
  var findbar = $("searchbar"), findQ = $("search-input"), findN = $("search-count"), findX = $("search-close");
  var mm = $("minimap"), mmSvg = $("minimap-svg"), mmContent = $("minimap-content"), mmVp = $("minimap-viewport");
  var insp = $("inspector"), inspT = $("inspector-title"), inspS = $("inspector-sub");
  var inspTags = $("inspector-tags"), inspR = $("inspector-route"), inspIn = $("inspector-in"), inspOut = $("inspector-out");
  var inspNIn = $("inspector-in-count"), inspNOut = $("inspector-out-count");
  var inspX = $("inspector-close"), inspTr = $("inspector-trace");
  var dot = $("laser");
  var help = $("help-sheet"), backdrop = $("help-backdrop"), helpX = $("help-close"), helpList = $("help-list");

  var THEMES = ["auto", "light", "dark"];
  var NEXT_THEME = { auto: "light", light: "dark", dark: "auto" };
  var THEME_NAME = { auto: "follow system", light: "light", dark: "dark" };
  var STORE_KEY = "naqsha-theme";
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 2.5;
  var STORED = null;

  try { STORED = localStorage.getItem(STORE_KEY); } catch (err) { STORED = null; }

  /* ---- status line ---------------------------------------------------- */

  var lastMessage = "";
  function announce(message) {
    if (!statusEl || !message) return;
    if (lastMessage === message) statusEl.textContent = "";
    statusEl.textContent = message;
    lastMessage = message;
  }

  /* Visible, transient micro-confirmation: the action button turns copper for a
     moment ("Copied"), because the live region is screen-reader only. */
  var noteTimer = 0;
  function flashBtn(btn) {
    if (!btn) return;
    btn.classList.add("is-on");
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { btn.classList.remove("is-on"); }, 1600);
  }

  /* ---- theme ---------------------------------------------------------- */

  function normalizeMode(mode) {
    return THEMES.indexOf(mode) >= 0 ? mode : "auto";
  }

  function themeLabel(mode) {
    return "Theme: " + THEME_NAME[mode] + ", switch to " + THEME_NAME[NEXT_THEME[mode]];
  }

  function syncThemeButton(mode) {
    if (!themeBtn) return;
    sa(themeBtn,"data-mode", mode);
    sa(themeBtn,"title", themeLabel(mode));
    sa(themeBtn,"aria-label", themeLabel(mode));
  }

  function applyTheme(mode) {
    sa(html,"data-theme", mode);
    syncThemeButton(mode);
  }

  if (STORED && THEMES.indexOf(STORED) >= 0) {
    applyTheme(STORED);
  } else {
    syncThemeButton(normalizeMode(html.getAttribute("data-theme")));
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = NEXT_THEME[normalizeMode(html.getAttribute("data-theme"))];
      applyTheme(next);
      try { localStorage.setItem(STORE_KEY, next); } catch (err) { /* private mode */ }
      announce("Theme " + THEME_NAME[next] + ".");
    });
  }

  /* ---- zoom + pan ----------------------------------------------------- */

  var sceneWidth = SCENE.width;
  var sceneHeight = SCENE.height;
  if (svg) {
    var attrW = parseFloat(svg.getAttribute("data-scene-width") || svg.getAttribute("width"));
    var attrH = parseFloat(svg.getAttribute("data-scene-height") || svg.getAttribute("height"));
    if (attrW > 0) sceneWidth = attrW;
    if (attrH > 0) sceneHeight = attrH;
  }
  SCENE.width = sceneWidth;
  SCENE.height = sceneHeight;

  var view = { z: 1, x: 0, y: 0 };
  var baseFit = 1;
  var followFit = true;
  var lastDragEnd = 0;
  var FIT_MARGIN = 48;

  function minZoom() {
    return Math.min(ZOOM_MIN, baseFit);
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(minZoom(), z));
  }

  function fixed(n) {
    return String(Math.round(n * 1000) / 1000);
  }

  /* Default scale: fit the scene inside the canvas at 1:1 or smaller. Never
     upscale (a big scene stays readable, a small one stays its natural size).
     Small screens clamp to 0.62 so labels stay legible; the canvas then pans. */
  function computeFit() {
    if (!stage) return 1;
    var rect = stage.getBoundingClientRect();
    var availableWidth = Math.max(60, rect.width - FIT_MARGIN);
    var availableHeight = Math.max(60, rect.height - FIT_MARGIN);
    var fit = Math.min(1, availableWidth / sceneWidth, availableHeight / sceneHeight);
    if (!isFinite(fit) || fit <= 0) fit = 1;
    if (innerWidth <= 720 && fit < 0.62) fit = 0.62;
    return fit;
  }

  function renderView() {
    if (!canvas) return;
    /* A scene that already fits has nothing to pan: snapping that axis back to
       centre keeps a click on the minimap from pushing boxes under the chrome. */
    if (stage) {
      var area = stage.getBoundingClientRect();
      if (sceneWidth * view.z <= area.width) view.x = 0;
      if (sceneHeight * view.z <= area.height) view.y = 0;
    }
    canvas.style.transform =
      "translate(" + fixed(view.x) + "px," + fixed(view.y) + "px) scale(" + fixed(view.z) + ")";
    if (zoomReadout) zoomReadout.textContent = Math.round(view.z * 100) + "%";
    if (zoomOutBtn) zoomOutBtn.disabled = view.z <= minZoom() + 0.0001;
    if (zoomInBtn) zoomInBtn.disabled = view.z >= ZOOM_MAX - 0.0001;
    mmView();
  }

  function applyFit() {
    baseFit = computeFit();
    view.z = baseFit;
    view.x = 0;
    view.y = 0;
    followFit = true;
    renderView();
  }

  function syncToStage() {
    baseFit = computeFit();
    if (followFit) {
      view.z = baseFit;
      view.x = 0;
      view.y = 0;
    } else if (view.z < minZoom()) {
      view.z = minZoom();
    }
    renderView();
  }

  function zoomAround(factor, clientX, clientY) {
    if (!stage) return;
    var next = clampZoom(view.z * factor);
    if (Math.abs(next - view.z) < 0.0001) return;
    var rect = stage.getBoundingClientRect();
    var cx = rect.width / 2;
    var cy = rect.height / 2;
    var dx = clientX - rect.left - cx - view.x;
    var dy = clientY - rect.top - cy - view.y;
    var ratio = next / view.z;
    view.x += dx * (1 - ratio);
    view.y += dy * (1 - ratio);
    view.z = next;
    followFit = false;
    renderView();
  }

  function zoomBy(factor) {
    if (!stage) return;
    var rect = stage.getBoundingClientRect();
    zoomAround(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  if (stage && canvas) {
    stage.addEventListener(
      "wheel",
      function (event) {
        var dy = event.deltaY;
        if (event.deltaMode === 1) dy *= 16;
        else if (event.deltaMode === 2) dy *= 100;
        if (!dy) return;
        event.preventDefault();
        zoomAround(Math.exp(-dy * 0.0015), event.clientX, event.clientY);
        hashSoon(180);
      },
      { passive: false }
    );

    /* Pan, two-pointer pinch and double-tap reset share one pointer table. */
    var pointers = Object.create(null);
    var live = 0;
    var pan = null;
    var pinch = null;
    var lastTap = null;
    var isTool = function (target) {
      return !!(target && target.closest && (
        target.closest("button") || target.closest(".focus-exit") ||
        target.closest(".minimap") || target.closest(".inspector") ||
        target.closest(".searchbar") || target.closest(".help-sheet")));
    };
    var pointOf = function (event) { return { x: event.clientX, y: event.clientY }; };
    var dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
    var mid = function (a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    var firstTwo = function () {
      var ids = Object.keys(pointers);
      return ids.length >= 2 ? [pointers[ids[0]], pointers[ids[1]]] : null;
    };

    stage.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if (isTool(event.target)) return;
      pointers[event.pointerId] = pointOf(event);
      live = Object.keys(pointers).length;
      if (live === 1) {
        pan = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          ox: view.x,
          oy: view.y,
          moved: false,
          type: event.pointerType
        };
        pinch = null;
      } else if (live >= 2) {
        var pair = firstTwo();
        if (pair) {
          pan = null;
          canvas.classList.remove("is-dragging");
          Object.keys(pointers).forEach(function (id) {
            try { stage.setPointerCapture(Number(id)); } catch (err) { /* pointer gone */ }
          });
          pinch = { dist: Math.max(1, dist(pair[0], pair[1])), mid: mid(pair[0], pair[1]) };
        }
      }
    });

    stage.addEventListener("pointermove", function (event) {
      if (pointers[event.pointerId] === undefined) return;
      pointers[event.pointerId] = pointOf(event);
      if (pinch && Object.keys(pointers).length >= 2) {
        var pair = firstTwo();
        if (!pair) return;
        var spread = Math.max(1, dist(pair[0], pair[1]));
        var centre = mid(pair[0], pair[1]);
        zoomAround(spread / pinch.dist, centre.x, centre.y);
        view.x += centre.x - pinch.mid.x;
        view.y += centre.y - pinch.mid.y;
        followFit = false;
        pinch.dist = spread;
        pinch.mid = centre;
        renderView();
        return;
      }
      if (!pan || event.pointerId !== pan.id) return;
      var dx = event.clientX - pan.x;
      var dy = event.clientY - pan.y;
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        pan.moved = true;
        canvas.classList.add("is-dragging");
        /* capture only once the gesture is a drag, so a plain click still reaches
           the node (pointer capture would retarget the click to the stage) */
        try { stage.setPointerCapture(pan.id); } catch (err) { /* pointer gone */ }
      }
      if (pan.moved) {
        view.x = pan.ox + dx;
        view.y = pan.oy + dy;
        followFit = false;
        renderView();
      }
    });

    function endPan(event) {
      if (event && event.pointerId !== undefined) delete pointers[event.pointerId];
      live = Object.keys(pointers).length;
      var moved = pan ? pan.moved : false;
      var type = pan ? pan.type : (event && event.pointerType) || "";
      var id = pan ? pan.id : (event && event.pointerId);
      pan = null;
      canvas.classList.remove("is-dragging");
      if (id !== undefined) { try { stage.releasePointerCapture(id); } catch (err) { /* already released */ } }
      if (pinch) {
        if (live < 2) {
          pinch = null;
          var rest = Object.keys(pointers);
          if (rest.length === 1) {
            var point = pointers[rest[0]];
            pan = { id: Number(rest[0]), x: point.x, y: point.y, ox: view.x, oy: view.y, moved: false, type: type };
          }
          hashSoon(60);
        }
        return;
      }
      if (moved) {
        lastDragEnd = Date.now();
        hashSoon(60);
      } else if (type === "touch" && event && event.clientX !== undefined) {
        var now = Date.now();
        if (lastTap && now - lastTap.t < 340 && dist({ x: event.clientX, y: event.clientY }, lastTap) < 30) {
          lastTap = null;
          resetAll(true);
        } else {
          lastTap = { t: now, x: event.clientX, y: event.clientY };
        }
      }
    }

    stage.addEventListener("pointerup", endPan);
    stage.addEventListener("pointercancel", endPan);
    stage.addEventListener("lostpointercapture", function () {
      canvas.classList.remove("is-dragging");
      pan = null;
      pinch = null;
      live = 0;
      pointers = Object.create(null);
    });
  }

  var resizeQueued = false;
  window.addEventListener("resize", function () {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      syncToStage();
    });
  });

  if (zoomInBtn) zoomInBtn.addEventListener("click", function () { zoomBy(1.2); writeHash(); });
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", function () { zoomBy(1 / 1.2); writeHash(); });
  if (zoomResetBtn) zoomResetBtn.addEventListener("click", function () { resetAll(true); });
  if (printBtn) printBtn.addEventListener("click", function () { print(); });

  /* ---- focus graph ---------------------------------------------------- */

  var nodes = svg ? slice(svg.querySelectorAll(".node[data-node-id]")) : [];
  var edges = svg ? slice(svg.querySelectorAll(".edge[data-from]")) : [];
  var lifelines = svg ? slice(svg.querySelectorAll(".lifeline")) : [];
  var neighbours = Object.create(null);
  var edgeCount = Object.create(null);
  var pinned = null;
  var hovered = null;

  nodes.forEach(function (node) {
    var id = node.getAttribute("data-node-id");
    neighbours[id] = [];
    edgeCount[id] = 0;
  });

  edges.forEach(function (edge) {
    var from = edge.getAttribute("data-from");
    var to = edge.getAttribute("data-to");
    if (neighbours[from]) { neighbours[from].push(to); edgeCount[from] += 1; }
    if (neighbours[to]) { neighbours[to].push(from); edgeCount[to] += 1; }
    if (edgeCount[from] === undefined) edgeCount[from] = 0;
    if (edgeCount[to] === undefined) edgeCount[to] = 0;
  });

  function setClass(el, name, on) {
    if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
  }

  var tour = { steps: TOUR_STEPS, index: 0, on: false };
  var route = { mode: false, start: null, target: null, ok: false, path: [], edgeKeys: Object.create(null), hops: 0, reason: "" };
  var ss = { q: "", matches: [], index: -1 };
  var hk = Object.create(null);
  var present = false;

  function edgeDomKey(edge) {
    return edge.getAttribute("data-from") + "|" + edge.getAttribute("data-to") + "|" +
      edge.getAttribute("data-kind") + "|" + (edge.getAttribute("data-label") || "");
  }

  /* The focus engine is a *set*: one id for hover/pin, 1..6 ids for a tour step,
     the path nodes while a route is shown. Neighbours become "active"; the rest
     is dimmed. A shown route only keeps its own edges lit. */
  function focusSet() {
    if (tour.on && tour.steps.length) {
      var step = tour.steps[tour.index] || tour.steps[0];
      if (step && Array.isArray(step.focus)) return step.focus;
    }
    if (route.ok && route.path.length) return route.path.slice();
    if (route.mode && route.start) return [route.start];
    if (pinned) return [pinned];
    if (hovered) return [hovered];
    return [];
  }

  function paint() {
    var ids = focusSet();
    var focused = Object.create(null);
    var near = Object.create(null);
    ids.forEach(function (id) { focused[id] = 1; });
    ids.forEach(function (id) {
      (neighbours[id] || []).forEach(function (other) {
        if (focused[other] !== 1) near[other] = 1;
      });
    });
    var any = ids.length > 0;
    var pathEdges = route.ok ? route.edgeKeys : null;
    var pathNodes = Object.create(null);
    if (route.ok) route.path.forEach(function (id) { pathNodes[id] = 1; });

    nodes.forEach(function (node) {
      var nodeId = node.getAttribute("data-node-id");
      var isFocused = focused[nodeId] === 1;
      var isNear = near[nodeId] === 1;
      setClass(node, "is-dim", any && !isFocused && !isNear);
      setClass(node, "is-active", isNear && !isFocused);
      setClass(node, "is-focus", isFocused);
      setClass(node, "is-route", pathNodes[nodeId] === 1);
    });

    edges.forEach(function (edge) {
      var on = any &&
        (focused[edge.getAttribute("data-from")] === 1 || focused[edge.getAttribute("data-to")] === 1);
      if (pathEdges) on = on && pathEdges[edgeDomKey(edge)] === 1;
      setClass(edge, "is-dim", any && !on);
      setClass(edge, "is-active", on);
      setClass(edge, "is-route", !!pathEdges && on);
    });

    lifelines.forEach(function (line) {
      var active = any && focused[line.getAttribute("data-node-id")] === 1;
      setClass(line, "is-dim", any && !active);
      setClass(line, "is-active", active);
    });

    if (svg) {
      svg.classList.toggle("has-focus", any);
      svg.classList.toggle("is-searching", ss.q.length > 0);
    }
  }

  function nodeSentence(node) {
    var id = node.getAttribute("data-node-id");
    var label = node.getAttribute("data-label") || id;
    var kind = node.getAttribute("data-kind") || "node";
    var connections = edgeCount[id] || 0;
    var near = (neighbours[id] || []).length;
    return label + ", " + kind + ". " + plural(connections, "connection", "connections") +
      ", " + plural(near, "neighbour", "neighbours") + ".";
  }

  function clearFocus(silent) {
    pinned = null;
    hovered = null;
    closeInsp();
    paint();
    writeHash();
    if (!silent) announce("Focus cleared.");
  }

  function togglePin(node, focusPanel) {
    if (tour.on) return;
    var id = node.getAttribute("data-node-id");
    if (pinned === id) {
      clearFocus(false);
      return;
    }
    pinned = id;
    hovered = null;
    paint();
    openInsp(id, focusPanel);
    writeHash();
    announce(nodeSentence(node) + " Inspector open; press Escape to clear.");
  }

  nodes.forEach(function (node) {
    node.addEventListener("pointerenter", function () {
      if (pinned || tour.on || route.mode) return;
      hovered = node.getAttribute("data-node-id");
      paint();
      announce(nodeSentence(node));
    });
    node.addEventListener("pointerleave", function () {
      if (pinned || tour.on || route.mode) return;
      hovered = null;
      paint();
    });
    node.addEventListener("focus", function () {
      if (pinned || tour.on || route.mode) return;
      hovered = node.getAttribute("data-node-id");
      paint();
      announce(nodeSentence(node));
    });
    node.addEventListener("blur", function () {
      if (pinned || tour.on || route.mode) return;
      hovered = null;
      paint();
    });
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      if (Date.now() - lastDragEnd < 220) return;
      if (tour.on) return;
      var id = node.getAttribute("data-node-id");
      if (route.mode) { routePick(id); return; }
      togglePin(node, false);
    });
    node.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        if (tour.on) return;
        event.preventDefault();
        var id = node.getAttribute("data-node-id");
        if (route.mode) { routePick(id); return; }
        togglePin(node, true);
      }
    });
  });

  if (stage) {
    stage.addEventListener("click", function (event) {
      if (Date.now() - lastDragEnd < 220) return;
      var target = event.target;
      if (target && target.closest && (target.closest(".node") || target.closest("button") ||
        target.closest(".minimap") || target.closest(".inspector") || target.closest(".searchbar"))) return;
      if (tour.on) return;
      if (pinned || hovered) clearFocus(false);
    });
  }

  /* ---- walkthrough tour ------------------------------------------------ */

  function tourTotal() {
    return tour.steps.length;
  }

  function stepAt(index) {
    if (!tour.steps.length) return null;
    var clamped = Math.max(0, Math.min(tour.steps.length - 1, index));
    return tour.steps[clamped] || tour.steps[0];
  }

  function syncTourbar() {
    if (!tourbar || !tour.steps.length) return;
    var total = tourTotal();
    var n = tour.index + 1;
    tourbar.classList.toggle("is-active", tour.on);
    if (tourCountEl) tourCountEl.textContent = n + " / " + total;
    if (tourTitleEl) tourTitleEl.textContent = stepAt(tour.index).title;
    if (tourTextEl) tourTextEl.textContent = stepAt(tour.index).text;
    if (tourPrevBtn) {
      tourPrevBtn.disabled = tour.index <= 0 && tour.on;
      sa(tourPrevBtn,"aria-label", "Previous step");
      sa(tourPrevBtn,"title", "Previous step");
    }
    if (tourNextBtn) {
      var nextLabel = tour.on && tour.index >= total - 1 ? "Finish tour" : "Next step";
      sa(tourNextBtn,"aria-label", nextLabel);
      sa(tourNextBtn,"title", nextLabel);
    }
    if (tourExitBtn) {
      var exitLabel = tour.on ? "Exit tour" : "Start tour";
      sa(tourExitBtn,"aria-label", exitLabel);
      sa(tourExitBtn,"title", exitLabel);
      if (tourExitLabel) tourExitLabel.textContent = exitLabel;
    }
    tourDots.forEach(function (dot, index) {
      var current = index === tour.index;
      dot.classList.toggle("is-current", current);
      if (current) sa(dot,"aria-current", "step");
      else dot.removeAttribute("aria-current");
      sa(dot,"aria-label", "Step " + (index + 1) + ": " + ((tour.steps[index] || {}).title || ""));
    });
  }

  function setTourStep(index, announceStep) {
    if (!tour.steps.length) return;
    tour.index = Math.max(0, Math.min(tour.steps.length - 1, index));
    syncTourbar();
    if (tour.on) {
      paint();
      writeHash();
    }
    if (announceStep) {
      announce("Step " + (tour.index + 1) + " of " + tourTotal() + ": " + stepAt(tour.index).title);
    }
  }

  function startTour(index) {
    if (!tour.steps.length) return;
    tour.on = true;
    pinned = null;
    hovered = null;
    setTourStep(index, false);
    announce("Step " + (tour.index + 1) + " of " + tourTotal() + ": " + stepAt(tour.index).title);
  }

  function exitTour(announceExit) {
    if (!tour.on) return;
    tour.on = false;
    syncTourbar();
    paint();
    writeHash();
    if (announceExit) announce("Walkthrough closed.");
  }

  function toggleTour() {
    if (!tour.steps.length) return;
    if (tour.on) exitTour(true);
    else startTour(tour.index);
  }

  function tourNext() {
    if (!tour.steps.length) return;
    if (!tour.on) { startTour(tour.index); return; }
    if (tour.index >= tourTotal() - 1) { exitTour(true); return; }
    setTourStep(tour.index + 1, true);
  }

  function tourPrev() {
    if (!tour.steps.length) return;
    if (!tour.on) { startTour(tour.index); return; }
    if (tour.index <= 0) return;
    setTourStep(tour.index - 1, true);
  }

  if (tour.steps.length) {
    if (tourPrevBtn) tourPrevBtn.addEventListener("click", tourPrev);
    if (tourNextBtn) tourNextBtn.addEventListener("click", tourNext);
    if (tourExitBtn) tourExitBtn.addEventListener("click", function () {
      if (tour.on) exitTour(true);
      else startTour(tour.index);
    });
    tourDots.forEach(function (dot) {
      dot.addEventListener("click", function () {
        var index = Number(dot.getAttribute("data-step"));
        if (!isFinite(index)) return;
        if (!tour.on) startTour(index);
        else setTourStep(index, true);
      });
    });
    // Idle state: the bar already shows step 1, but nothing is dimmed until the
    // reader starts the tour (the plain diagram stays readable on open).
    setTourStep(0, false);
  }

  /* ---- share state: #focus #step #z #route ---------------------------- */

  var hashTimer = 0;

  function hashParts() {
    var out = Object.create(null);
    var raw = String(location.hash || "").slice(1);
    if (!raw) return out;
    raw.split("&").forEach(function (part) {
      var cut = part.indexOf("=");
      if (cut <= 0) return;
      var value = part.slice(cut + 1);
      try { value = decodeURIComponent(value); } catch (err) { /* keep the raw part */ }
      out[part.slice(0, cut)] = value;
    });
    return out;
  }

  function hashNow() {
    var parts = [];
    if (route.ok && route.start && route.target) parts.push(`route=${route.start}~${route.target}`);
    else if (pinned) parts.push(`focus=${pinned}`);
    if (tour.on && tour.steps.length) parts.push(`step=${tour.index + 1}`);
    if (!followFit) parts.push(`z=${Math.round(view.z * 100) / 100}`);
    return parts.join("&");
  }

  function writeHash() {
    var next = hashNow();
    if (next === String(location.hash || "").slice(1)) return;
    try {
      history.replaceState(null, "", location.pathname + location.search + (next ? `#${next}` : ""));
    } catch (err) {
      try { location.hash = next; } catch (err2) { /* file:// history blocked */ }
    }
  }

  function hashSoon(delay) {
    if (hashTimer) clearTimeout(hashTimer);
    hashTimer = setTimeout(function () { hashTimer = 0; writeHash(); }, delay || 0);
  }

  /* ---- search --------------------------------------------------------- */

  function nodeEl(id) {
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute("data-node-id") === id) return nodes[i];
    }
    return null;
  }

  function runFind() {
    var q = findQ ? findQ.value.trim().toLowerCase() : "";
    ss.q = q;
    ss.matches = [];
    ss.index = -1;
    if (q) {
      MODEL.nodes.forEach(function (n) {
        var el = nodeEl(n.id);
        var body = el ? (el.getAttribute("data-search") || "") : "";
        if (`${n.label} ${n.sublabel} ${n.kind} ${n.id} ${body}`.toLowerCase().indexOf(q) >= 0) ss.matches.push(n.id);
      });
    }
    nodes.forEach(function (n) {
      setClass(n, "is-match", !!q && ss.matches.indexOf(n.getAttribute("data-node-id")) >= 0);
    });
    if (findN) {
      findN.textContent = q ? `${ss.matches.length}/${nodes.length}` : "";
      findN.classList.toggle("is-empty", !!q && !ss.matches.length);
    }
    paint();
    if (q) {
      announce(ss.matches.length
        ? `${plural(ss.matches.length, "match", "matches")}. Enter jumps to the first.`
        : `No node matches ${q}.`);
    }
  }

  function openFind() {
    if (!findbar) return;
    findbar.hidden = false;
    if (findB) sa(findB, "aria-expanded", "true");
    if (findQ) { findQ.focus(); findQ.select(); }
    announce("Search nodes. Type to filter, Enter jumps, Escape closes.");
  }

  function closeFind(silent) {
    if (!findbar || findbar.hidden) return;
    findbar.hidden = true;
    if (findQ) findQ.value = "";
    if (findB) {
      sa(findB, "aria-expanded", "false");
      try { findB.focus(); } catch (err) { /* detached */ }
    }
    runFind();
    if (!silent) announce("Search closed.");
  }

  function jumpFind(direction) {
    if (!ss.matches.length) { announce("No matches to jump to."); return; }
    ss.index = (ss.index + (direction || 1) + ss.matches.length) % ss.matches.length;
    focusId(ss.matches[ss.index], "match");
  }

  if (findB) findB.addEventListener("click", function () { if (findbar && findbar.hidden) openFind(); else closeFind(true); });
  if (findX) findX.addEventListener("click", function () { closeFind(false); });
  if (findQ) {
    findQ.addEventListener("input", runFind);
    findQ.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(false); }
      else if (event.key === "Enter") { event.preventDefault(); jumpFind(event.shiftKey ? -1 : 1); }
      else if (event.key === "ArrowDown") { event.preventDefault(); jumpFind(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); jumpFind(-1); }
    });
  }

  /* ---- legend filtering ----------------------------------------------- */

  var lg = slice(doc.querySelectorAll(".legend-btn"));
  var lgR = $("legend-reset");

  function applyFilter() {
    var hidden = 0;
    lg.forEach(function (b) {
      var kind = b.getAttribute("data-kind");
      var off = hk[kind] === true;
      if (off) hidden += 1;
      sa(b, "aria-pressed", off ? "false" : "true");
      var label = b.querySelector(".legend-label");
      sa(b, "aria-label", (label ? label.textContent : kind) + (off ? " edges hidden, click to show" : " edges, click to hide"));
    });
    edges.forEach(function (e) { setClass(e, "is-kind-hidden", hk[e.getAttribute("data-kind")] === true); });
    if (lgR) lgR.hidden = hidden === 0;
    return hidden;
  }

  lg.forEach(function (b) {
    b.addEventListener("click", function () {
      var kind = b.getAttribute("data-kind");
      if (hk[kind]) delete hk[kind]; else hk[kind] = true;
      var label = b.querySelector(".legend-label");
      var hidden = applyFilter();
      announce(hidden
        ? `${label ? label.textContent : kind} edges toggled; ${plural(hidden, "kind", "kinds")} filtered. Reset filters shows every edge.`
        : "Every edge kind is visible again.");
    });
  });
  if (lgR) lgR.addEventListener("click", function () {
    hk = Object.create(null);
    applyFilter();
    announce("Edge filters cleared.");
  });

  /* ---- minimap -------------------------------------------------------- */

  var mmReady = false;

  function mmRect(cls, x, y, w, h) {
    var r = doc.createElementNS(SVG_NS, "rect");
    sa(r, "class", cls);
    sa(r, "x", x);
    sa(r, "y", y);
    sa(r, "width", w);
    sa(r, "height", h);
    return r;
  }

  function mmBuild() {
    if (!mm || !mmSvg || !mmContent || !svg) return;
    sa(mmSvg, "viewBox", `0 0 ${fixed(SCENE.width)} ${fixed(SCENE.height)}`);
    while (mmContent.firstChild) mmContent.removeChild(mmContent.firstChild);
    each(svg.querySelectorAll(".group .group-box"), function (b) {
      mmContent.appendChild(mmRect("mm-group", b.getAttribute("x"), b.getAttribute("y"), b.getAttribute("width"), b.getAttribute("height")));
    });
    nodes.forEach(function (n) {
      var box = null;
      try { box = n.getBBox(); } catch (err) { box = null; }
      if (!box || !(box.width > 0)) return;
      var r = mmRect("mm-node k-" + (n.getAttribute("data-kind") || "service"), fixed(box.x), fixed(box.y), fixed(box.width), fixed(box.height));
      sa(r, "rx", "1.5");
      mmContent.appendChild(r);
    });
    mmReady = true;
    mm.hidden = false;
    mmView();
  }

  function mmView() {
    if (!mmReady || !mmVp || !svg || !stage) return;
    var box = svg.getBoundingClientRect();
    var scale = box.width / SCENE.width;
    if (!scale || !isFinite(scale)) return;
    var area = stage.getBoundingClientRect();
    var x = Math.max(0, Math.min(SCENE.width, (area.left - box.left) / scale));
    var y = Math.max(0, Math.min(SCENE.height, (area.top - box.top) / scale));
    var w = Math.min(SCENE.width - x, area.width / scale);
    var h = Math.min(SCENE.height - y, area.height / scale);
    sa(mmVp, "x", fixed(x));
    sa(mmVp, "y", fixed(y));
    sa(mmVp, "width", fixed(w > 0 ? w : 1));
    sa(mmVp, "height", fixed(h > 0 ? h : 1));
    setClass(mmVp, "is-full", (w * h) / (SCENE.width * SCENE.height) > 0.92);
  }

  function panTo(id) {
    var node = nodeEl(id);
    if (!node || !stage) return;
    var rect = node.getBoundingClientRect();
    var area = stage.getBoundingClientRect();
    var avoid = insp && !insp.hidden && innerWidth > 640 ? 300 : 0;
    view.x += area.left + Math.max(80, area.width - avoid) / 2 - (rect.left + rect.width / 2);
    view.y += area.top + area.height / 2 - (rect.top + rect.height / 2);
    followFit = false;
    renderView();
    writeHash();
  }

  function mmPan(point) {
    if (!svg || !stage) return;
    var box = svg.getBoundingClientRect();
    var scale = box.width / SCENE.width;
    if (!scale || !isFinite(scale)) return;
    var area = stage.getBoundingClientRect();
    var avoid = insp && !insp.hidden && innerWidth > 640 ? 300 : 0;
    view.x += area.left + Math.max(40, area.width - avoid) / 2 - (box.left + point.x * scale);
    view.y += area.top + area.height / 2 - (box.top + point.y * scale);
    followFit = false;
    renderView();
    hashSoon(80);
  }

  function mmGo(clientX, clientY) {
    if (!mmSvg) return;
    var x = null;
    var y = null;
    try {
      var ctm = mmSvg.getScreenCTM();
      if (ctm) {
        var point = mmSvg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        point = point.matrixTransform(ctm.inverse());
        x = point.x;
        y = point.y;
      }
    } catch (err) { x = null; }
    if (x === null || !isFinite(x) || !isFinite(y)) {
      var rect = mmSvg.getBoundingClientRect();
      x = (clientX - rect.left) / Math.max(1, rect.width) * SCENE.width;
      y = (clientY - rect.top) / Math.max(1, rect.height) * SCENE.height;
    }
    mmPan({
      x: Math.max(0, Math.min(SCENE.width, x)),
      y: Math.max(0, Math.min(SCENE.height, y))
    });
  }

  if (mmSvg) {
    var mmDrag = false;
    mmSvg.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      event.stopPropagation();
      mmDrag = true;
      try { mmSvg.setPointerCapture(event.pointerId); } catch (err) { /* capture lost */ }
      mmGo(event.clientX, event.clientY);
    });
    mmSvg.addEventListener("pointermove", function (event) { if (mmDrag) mmGo(event.clientX, event.clientY); });
    var mmStop = function () { mmDrag = false; };
    mmSvg.addEventListener("pointerup", mmStop);
    mmSvg.addEventListener("pointercancel", mmStop);
    mmSvg.addEventListener("keydown", function (event) {
      var step = 44;
      var dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
      var dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      view.x += dx;
      view.y += dy;
      followFit = false;
      renderView();
      writeHash();
      announce("View panned.");
    });
  }

  /* ---- inspector ------------------------------------------------------ */

  var inspectId = null;
  var el = function (name, cls, text) {
    var n = doc.createElement(name);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function nbItems(id, dir) {
    var seen = Object.create(null);
    var out = [];
    MODEL.edges.forEach(function (e) {
      var other = dir === "in" ? (e.to === id ? e.from : null) : (e.from === id ? e.to : null);
      if (!other || seen[other]) return;
      seen[other] = 1;
      out.push({ id: other, via: e.label || e.kind });
    });
    return out;
  }

  function renderNbs(list, items) {
    if (!list) return;
    if (!items.length) { list.innerHTML = '<li class="insp-empty">none</li>'; return; }
    list.innerHTML = items.map(function (it) {
      var kind = (BY_ID[it.id] || {}).kind || "node";
      return `<li><button type="button" class="insp-nb" data-neighbour="${esc(it.id)}" aria-label="${esc(nodeLabel(it.id) + " via " + it.via)}"><span class="insp-nb-label">${esc(nodeLabel(it.id))}</span><span class="insp-nb-kind">${esc(kind + " · " + it.via)}</span></button></li>`;
    }).join("");
    each(list.querySelectorAll(".insp-nb"), function (b) {
      b.addEventListener("click", function () { focusId(b.getAttribute("data-neighbour")); });
    });
  }

  function openInsp(id, focusPanel) {
    var item = BY_ID[id];
    if (!item || !insp) return;
    inspectId = id;
    inspT.textContent = item.label;
    inspS.textContent = item.sublabel || "";
    var group = null;
    MODEL.groups.forEach(function (g) { if (g.id === item.group) group = g; });
    var dom = nodeEl(id);
    var stereotype = dom ? dom.getAttribute("data-stereotype") : "";
    var role = dom ? dom.getAttribute("data-role") : "";
    var meta = dom ? dom.getAttribute("data-meta") : "";
    inspTags.innerHTML =
      `<span class="insp-tag is-kind k-${esc(item.kind)}">${esc(item.kind)}</span>` +
      (group ? `<span class="insp-tag">${esc(group.label || group.id)}</span>` : "") +
      (stereotype ? `<span class="insp-tag">${esc(stereotype)}</span>` : "") +
      (role ? `<span class="insp-tag">${esc(role)}</span>` : "") +
      (meta ? `<span class="insp-tag">${esc(meta)}</span>` : "") +
      (item.status ? `<span class="insp-tag is-status-${esc(item.status)}">${esc(item.status)}</span>` : "") +
      `<span class="insp-tag">${plural((neighbours[id] || []).length, "neighbour", "neighbours")}</span>`;
    var inbound = nbItems(id, "in");
    var outbound = nbItems(id, "out");
    inspNIn.textContent = String(inbound.length);
    inspNOut.textContent = String(outbound.length);
    renderNbs(inspIn, inbound);
    renderNbs(inspOut, outbound);
    insp.hidden = false;
    if (inspTr) sa(inspTr, "aria-pressed", route.mode && route.start === id ? "true" : "false");
    renderRoute();
    if (focusPanel) { try { insp.focus(); } catch (err) { /* detached */ } }
  }

  function closeInsp() {
    if (insp) insp.hidden = true;
    inspectId = null;
  }

  if (inspX) inspX.addEventListener("click", function () { closeInsp(); announce("Inspector closed."); });

  /* ---- route tracing: undirected declaration-order BFS ---------------- */

  function shortest(fromId, toId) {
    var fail = function (reason) { return { ok: false, reason: reason, path: [], edgeKeys: Object.create(null), hops: 0 }; };
    if (!BY_ID[fromId]) return fail("unknown-from");
    if (!BY_ID[toId]) return fail("unknown-to");
    if (fromId === toId) return { ok: true, path: [fromId], edgeKeys: Object.create(null), hops: 0 };
    var parent = Object.create(null);
    parent[fromId] = fromId;
    var via = Object.create(null);
    var queue = [fromId];
    var found = false;
    for (var cursor = 0; cursor < queue.length && !found; cursor += 1) {
      var current = queue[cursor];
      var list = ADJ[current] || [];
      for (var i = 0; i < list.length; i += 1) {
        var step = list[i];
        if (parent[step.to] !== undefined) continue;
        parent[step.to] = current;
        via[step.to] = step.edge;
        queue.push(step.to);
        if (step.to === toId) { found = true; break; }
      }
    }
    if (!found) return fail("unreachable");
    var path = [];
    var crossed = [];
    for (var walk = toId; walk !== fromId; walk = parent[walk]) {
      path.push(walk);
      crossed.push(via[walk]);
    }
    path.push(fromId);
    path.reverse();
    crossed.reverse();
    var keys = Object.create(null);
    crossed.forEach(function (edge) { keys[edge.key] = 1; });
    return { ok: true, path: path, edgeKeys: keys, hops: path.length - 1 };
  }

  function resetRoute() {
    route.start = null;
    route.target = null;
    route.ok = false;
    route.path = [];
    route.edgeKeys = Object.create(null);
    route.hops = 0;
    route.reason = "";
  }

  function syncRoute() {
    if (traceB) {
      sa(traceB, "aria-pressed", route.mode ? "true" : "false");
      traceB.classList.toggle("is-on", route.mode);
    }
    if (inspTr) sa(inspTr, "aria-pressed", route.mode && route.start === inspectId ? "true" : "false");
    if (route.mode) sa(doc.body, "data-mode", "route");
    else doc.body.removeAttribute("data-mode");
    renderRoute();
  }

  function enterRoute(startId) {
    if (tour.on) exitTour(false);
    route.mode = true;
    resetRoute();
    route.start = startId || null;
    if (startId) { pinned = startId; hovered = null; }
    paint();
    syncRoute();
    writeHash();
    if (startId) {
      openInsp(startId, false);
      announce(`Route from ${nodeLabel(startId)}. Pick the target node; Escape cancels.`);
    } else {
      announce("Route mode. Click the start node, then the target; Escape cancels.");
    }
  }

  function clearRoute(announceIt) {
    route.mode = false;
    resetRoute();
    pinned = null;
    hovered = null;
    paint();
    syncRoute();
    writeHash();
    if (announceIt) announce("Route cancelled.");
  }

  function routePick(id) {
    if (!route.mode) { enterRoute(id); return; }
    if (route.ok) resetRoute();
    if (!route.start) {
      route.start = id;
      pinned = id;
      hovered = null;
      paint();
      openInsp(id, false);
      syncRoute();
      writeHash();
      announce(`Route start: ${nodeLabel(id)}. Pick the target node.`);
      return;
    }
    if (id === route.start) { announce("That is the start node. Pick a different target."); return; }
    var result = shortest(route.start, id);
    route.target = id;
    route.ok = result.ok;
    route.path = result.path;
    route.edgeKeys = result.edgeKeys;
    route.hops = result.hops;
    route.reason = result.reason || "";
    pinned = null;
    hovered = null;
    paint();
    syncRoute();
    openInsp(id, false);
    writeHash();
    announce(result.ok
      ? `Route: ${plural(result.hops, "hop", "hops")}. ${result.path.map(nodeLabel).join(" to ")}.`
      : `No route from ${nodeLabel(route.start)} to ${nodeLabel(id)} (${result.reason}).`);
  }

  function setRoute(startId, targetId) {
    var result = shortest(startId, targetId);
    if (!result.ok) return false;
    route.mode = true;
    route.start = startId;
    route.target = targetId;
    route.ok = true;
    route.path = result.path;
    route.edgeKeys = result.edgeKeys;
    route.hops = result.hops;
    route.reason = "";
    paint();
    syncRoute();
    return true;
  }

  function renderRoute() {
    if (!inspR) return;
    if (!route.mode && !route.ok) {
      inspR.hidden = true;
      inspR.textContent = "";
      return;
    }
    inspR.hidden = false;
    if (route.ok) {
      inspR.innerHTML = `<p class="route-hops">${plural(route.hops, "hop", "hops")}</p><p class="route-line">${esc(route.path.map(nodeLabel).join(" → "))}</p>`;
    } else if (route.reason === "unreachable") {
      inspR.innerHTML = '<p class="route-hops">no path</p><p class="route-line">These nodes are not connected.</p>';
    } else if (route.start) {
      inspR.innerHTML = `<p class="route-hops">start · ${esc(nodeLabel(route.start))}</p><p class="route-line">Pick the target node.</p>`;
    } else {
      inspR.innerHTML = '<p class="route-hops">route mode</p><p class="route-line">Click the start node.</p>';
    }
  }

  function focusId(id, source) {
    if (!BY_ID[id]) return;
    if (route.mode) { routePick(id); return; }
    pinned = id;
    hovered = null;
    paint();
    openInsp(id, false);
    panTo(id);
    writeHash();
    announce(`${source === "match" ? "Match: " : ""}${nodeLabel(id)} focused. Inspector open.`);
  }

  if (traceB) traceB.addEventListener("click", function () {
    if (route.mode) clearRoute(true);
    else enterRoute(null);
  });
  if (inspTr) inspTr.addEventListener("click", function () {
    if (!inspectId) return;
    enterRoute(inspectId);
    announce(`Route from ${nodeLabel(inspectId)}. Click the target node; Escape cancels.`);
  });

  /* ---- presentation mode: chrome out, laser dot follows the pointer --- */

  function setPresent(on) {
    present = !!on;
    if (doc.body) doc.body.classList.toggle("presentation", present);
    if (presentB) {
      sa(presentB, "aria-pressed", present ? "true" : "false");
      presentB.classList.toggle("is-on", present);
    }
    if (dot) dot.classList.toggle("is-on", present);
    syncToStage();
    announce(present
      ? "Presentation mode. A laser dot follows the pointer; p or Escape exits."
      : "Presentation mode off.");
  }

  if (presentB) presentB.addEventListener("click", function () { setPresent(!present); });
  doc.addEventListener("pointermove", function (event) {
    if (present && dot) dot.style.transform = `translate3d(${fixed(event.clientX - 6)}px,${fixed(event.clientY - 6)}px,0)`;
  }, { passive: true });

  /* ---- keyboard help sheet ------------------------------------------- */

  var HELP = "0=fit and reset|+ , -=zoom in / out (wheel zooms at the pointer)|f=focus mode, chrome hidden|Enter=pin the focused node, open the inspector|Esc=close or clear the innermost thing|/=search labels, sublabels, kinds|Ctrl F=in-page search, not the browser findbar|r=trace a shortest route: click start, then target|p=presentation mode with a laser dot|t=start or stop the walkthrough|arrows=pan the minimap, or step the walkthrough|?=this sheet|Ctrl P=print one page";
  var helpOpen = false;
  var helpReturn = null;

  function fillHelp() {
    if (!helpList || helpList.childNodes.length) return;
    helpList.innerHTML = HELP.split("|").map(function (row) {
      var cut = row.indexOf("=");
      var keys = row.slice(0, cut).split(" , ").map(function (k) { return `<kbd>${k}</kbd>`; }).join("");
      return `<div class="help-row"><span class="help-keys">${keys}</span><span class="help-desc">${row.slice(cut + 1)}</span></div>`;
    }).join("");
  }

  function setHelp(open) {
    if (!help || !backdrop) return;
    helpOpen = !!open;
    help.hidden = !helpOpen;
    backdrop.hidden = !helpOpen;
    if (helpB) sa(helpB, "aria-expanded", helpOpen ? "true" : "false");
    if (helpOpen) {
      fillHelp();
      helpReturn = doc.activeElement;
      if (helpX) { try { helpX.focus(); } catch (err) { /* detached */ } }
      announce("Keyboard shortcut sheet. Escape closes it.");
    } else {
      if (helpReturn && helpReturn.focus) { try { helpReturn.focus(); } catch (err) { /* detached */ } }
      announce("Shortcut sheet closed.");
    }
  }

  if (helpB) helpB.addEventListener("click", function () { setHelp(!helpOpen); });
  if (helpX) helpX.addEventListener("click", function () { setHelp(false); });
  if (backdrop) backdrop.addEventListener("click", function () { setHelp(false); });

  /* ---- clipboard: share link, Mermaid, source IR --------------------- */

  function copyTxt(text, done) {
    var fallback = function () {
      var ok = false;
      var area = doc.createElement("textarea");
      area.value = text;
      sa(area, "readonly", "");
      sa(area, "aria-hidden", "true");
      area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
      doc.body.appendChild(area);
      try {
        area.select();
        area.setSelectionRange(0, text.length);
        ok = doc.execCommand("copy");
      } catch (err) { ok = false; }
      if (area.parentNode) area.parentNode.removeChild(area);
      done(ok);
    };
    var cb = navigator.clipboard;
    if (cb && typeof cb.writeText === "function" && isSecureContext) {
      try {
        cb.writeText(text).then(function () { done(true); }, fallback);
        return;
      } catch (err) { /* fall through */ }
    }
    fallback();
  }

  function copyOut(text, what, btn) {
    copyTxt(text, function (ok) {
      if (ok) {
        flashBtn(btn);
        announce(`${what} copied to the clipboard.`);
      } else {
        announce("The clipboard is blocked here; select the text from the address bar instead.");
      }
    });
  }

  if (linkB) linkB.addEventListener("click", function () {
    writeHash();
    copyOut(location.href, "Share link", linkB);
  });

  function irRaw() {
    var el = $("naqsha-ir");
    return el ? (el.textContent || "").trim() : "";
  }

  function mmdText() {
    if (!MODEL.nodes.length) return "";
    var clean = function (t) {
      t = String(t == null ? "" : t).replace(/[[\]{}()|"`<>]/g, " ").replace(/\s+/g, " ").trim();
      return t || "node";
    };
    var lines = [];
    if (MODEL.type === "sequence") {
      lines.push("sequenceDiagram");
      MODEL.nodes.forEach(function (n) {
        lines.push(`  ${n.kind === "actor" ? "actor" : "participant"} ${n.id} as ${clean(n.label)}`);
      });
      MODEL.edges.forEach(function (e) {
        var arrow = e.kind === "return" ? "-->>" : e.kind === "async" ? "-)" : "->>";
        lines.push(`  ${e.from}${arrow}${e.to}: ${clean(e.label || e.kind)}`);
      });
      return lines.join("\n") + "\n";
    }
    lines.push(`flowchart ${MODEL.direction === "LR" ? "LR" : "TD"}`);
    var shape = function (n) {
      var t = clean(n.label);
      var wrapped = n.kind === "actor" ? `([${t}])` : n.kind === "datastore" ? `[(${t})]` :
        n.kind === "security" ? `{${t}}` : n.kind === "note" ? `>${t}]` : `[${t}]`;
      return n.id + wrapped;
    };
    var grouped = Object.create(null);
    MODEL.groups.forEach(function (g) {
      var members = MODEL.nodes.filter(function (n) { return n.group === g.id; });
      if (!members.length) return;
      lines.push(`  subgraph ${g.id}["${clean(g.label || g.id)}"]`);
      members.forEach(function (n) {
        grouped[n.id] = 1;
        lines.push("    " + shape(n));
      });
      lines.push("  end");
    });
    MODEL.nodes.forEach(function (n) { if (!grouped[n.id]) lines.push("  " + shape(n)); });
    MODEL.edges.forEach(function (e) {
      var base = e.kind === "security" ? "==>" : e.kind === "return" || e.kind === "async" ? "-.->" : "-->";
      lines.push(`  ${e.from} ${base}${e.label ? `|${clean(e.label)}|` : ""} ${e.to}`);
    });
    return lines.join("\n") + "\n";
  }

  if (copyMermaidBtn) copyMermaidBtn.addEventListener("click", function () {
    setExportOpen(false, false);
    var text = "";
    try { text = mmdText(); } catch (err) { text = ""; }
    if (!text) {
      announce("Mermaid export unavailable: no source IR in this artifact.");
      return;
    }
    copyOut(text, "Mermaid", copyMermaidBtn);
  });

  if (copyJsonBtn) copyJsonBtn.addEventListener("click", function () {
    setExportOpen(false, false);
    var raw = irRaw();
    if (!raw) {
      announce("Copy JSON unavailable: no source IR in this artifact.");
      return;
    }
    var text = raw;
    try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch (err) { /* copy as-is */ }
    copyOut(text, "Source IR", copyJsonBtn);
  });

  /* ---- restore shared view state, build the instruments --------------- */

  function restoreHash() {
    var parts = hashParts();
    var restored = false;
    if (parts.z !== undefined) {
      var z = parseFloat(parts.z);
      if (isFinite(z) && z > 0) {
        view.z = clampZoom(z);
        followFit = false;
        restored = true;
      }
    }
    if (parts.focus && BY_ID[parts.focus] && nodeEl(parts.focus)) {
      pinned = parts.focus;
      restored = true;
    }
    if (parts.step !== undefined && tour.steps.length) {
      var step = parseInt(parts.step, 10);
      if (isFinite(step) && step >= 1 && step <= tour.steps.length) {
        tour.on = true;
        tour.index = step - 1;
        syncTourbar();
        restored = true;
      }
    }
    if (parts.route) {
      var bits = parts.route.split("~");
      if (bits.length === 2 && setRoute(bits[0], bits[1])) restored = true;
    }
    mmBuild();
    if (restored) {
      paint();
      renderView();
      if (pinned) openInsp(pinned, false);
      announce("View restored from the shared link.");
      hashSoon(200);
    }
  }

  /* ---- export --------------------------------------------------------- */

  var TOKEN_LIST = [
    "--paper", "--panel", "--panel-hover", "--ink", "--muted", "--hairline",
    "--grid-dot", "--copper", "--teal", "--inkblue", "--alert", "--amber",
    "--group-fill", "--group-op", "--halo",
    "--c-service", "--c-datastore", "--c-actor", "--c-external", "--c-queue",
    "--c-compute", "--c-security", "--c-state", "--c-note",
    "--c-main", "--c-return", "--c-async", "--c-message", "--c-data",
    "--font-sans", "--font-display", "--font-mono",
    "--fs-11", "--fs-12", "--fs-13", "--fs-15", "--fs-18", "--fs-26",
    "--r-card", "--r-pill"
  ];

  function paperColor() {
    var value = "";
    try { value = getComputedStyle(html).getPropertyValue("--paper").trim(); } catch (err) { value = ""; }
    return value || "#F8F6F2";
  }

  function tokenCss() {
    var out = [];
    var computed = null;
    try { computed = getComputedStyle(html); } catch (err) { computed = null; }
    if (!computed) return "";
    TOKEN_LIST.forEach(function (name) {
      var value = computed.getPropertyValue(name).trim();
      if (value) out.push(name + ":" + value);
    });
    return out.join(";");
  }

  /* All CSS is inline in the artifact, so same-document rules are readable
     offline; no external font/asset reference is ever copied into the export. */
  function exportCss() {
    var chunks = [];
    for (var i = 0; i < doc.styleSheets.length; i += 1) {
      var sheet = doc.styleSheets[i];
      var rules = null;
      try { rules = sheet.cssRules; } catch (err) { rules = null; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j += 1) {
        try { chunks.push(rules[j].cssText); } catch (err) { /* skip unreadable rule */ }
      }
    }
    var font = "";
    try { font = getComputedStyle(html).getPropertyValue("--font-sans").trim(); } catch (err) { font = ""; }
    var paper = paperColor();
    chunks.push(
      "svg.naqsha-export{display:block;width:" + SCENE.width + "px;height:" + SCENE.height +
      "px;background:" + paper + "}",
      "svg.naqsha-export text{font-family:" + (font || "sans-serif") + "}",
      "svg.naqsha-export .node,svg.naqsha-export .edge,svg.naqsha-export .lifeline{transition:none}"
    );
    return chunks.join("\n");
  }

  function buildSvgText() {
    if (!svg) return "";
    var paper = paperColor();
    var clone = svg.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("class");
    clone.removeAttribute("tabindex");
    sa(clone,"class", "naqsha-export");
    sa(clone,"width", fixed(SCENE.width));
    sa(clone,"height", fixed(SCENE.height));
    sa(clone,"viewBox", "0 0 " + fixed(SCENE.width) + " " + fixed(SCENE.height));

    slice(clone.querySelectorAll(".is-dim, .is-active, .is-focus, .is-route, .is-match, .is-kind-hidden")).forEach(function (el) {
      el.classList.remove("is-dim");
      el.classList.remove("is-active");
      el.classList.remove("is-focus");
      el.classList.remove("is-route");
      el.classList.remove("is-match");
      el.classList.remove("is-kind-hidden");
    });
    slice(clone.querySelectorAll("[tabindex]")).forEach(function (el) {
      el.removeAttribute("tabindex");
    });

    var tokens = tokenCss();
    sa(clone,"style", tokens + ";background:" + paper);

    var style = doc.createElementNS(SVG_NS, "style");
    style.textContent = exportCss();
    clone.insertBefore(style, clone.firstChild);

    var bg = doc.createElementNS(SVG_NS, "rect");
    sa(bg,"class", "export-bg");
    sa(bg,"x", "0");
    sa(bg,"y", "0");
    sa(bg,"width", fixed(SCENE.width));
    sa(bg,"height", fixed(SCENE.height));
    sa(bg,"fill", paper);
    clone.insertBefore(bg, style.nextSibling);

    return new XMLSerializer().serializeToString(clone);
  }

  function exportFilename(ext) {
    var slug = String(SCENE.slug || "naqsha").replace(/^-+|-+$/g, "") || "naqsha";
    var type = String(SCENE.type || "diagram").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    return slug + "-" + type + "." + ext;
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = doc.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    doc.body.appendChild(link);
    link.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (err) { /* already revoked */ }
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 2000);
  }

  function exportFailure() {
    announce("Export failed.");
  }

  function exportSvg() {
    try {
      var svgText = buildSvgText();
      if (!svgText) { exportFailure(); return; }
      download(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }), exportFilename("svg"));
      announce("SVG downloaded.");
    } catch (err) {
      exportFailure();
    }
  }

  /* One rasterization path for PNG, WebP and JPEG: the exported SVG -> Image ->
     canvas at 2x -> toBlob. All in-browser, no network. */
  function exportRaster(ext, mime, quality) {
    try {
      var svgText = buildSvgText();
      if (!svgText) { exportFailure(); return; }
      var scale = 2;
      var width = Math.round(SCENE.width * scale);
      var height = Math.round(SCENE.height * scale);
      var image = new Image();
      image.onload = function () {
        try {
          var canvasEl = doc.createElement("canvas");
          canvasEl.width = width;
          canvasEl.height = height;
          var ctx = canvasEl.getContext("2d");
          if (!ctx) { exportFailure(); return; }
          ctx.fillStyle = paperColor();
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);
          canvasEl.toBlob(function (blob) {
            if (!blob) { exportFailure(); return; }
            download(blob, exportFilename(ext));
            announce(ext.toUpperCase() + " downloaded.");
          }, mime, quality);
        } catch (err) {
          exportFailure();
        }
      };
      image.onerror = exportFailure;
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    } catch (err) {
      exportFailure();
    }
  }

  function exportPng() { exportRaster("png", "image/png"); }
  function exportWebp() { exportRaster("webp", "image/webp", 0.95); }
  function exportJpeg() { exportRaster("jpeg", "image/jpeg", 0.92); }

  var exportOpen = false;

  function exportList() {
    if (!exportMenu) return [];
    return slice(exportMenu.querySelectorAll('[role="menuitem"]'));
  }

  function setExportOpen(open, focusFirst) {
    if (!exportWrap || !exportBtn || !exportMenu) return;
    exportOpen = !!open;
    exportWrap.classList.toggle("is-open", exportOpen);
    exportMenu.hidden = !exportOpen;
    sa(exportBtn,"aria-expanded", exportOpen ? "true" : "false");
    if (exportOpen && focusFirst) {
      var items = exportList();
      if (items.length) items[0].focus();
    }
    if (!exportOpen && focusFirst) exportBtn.focus();
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      setExportOpen(!exportOpen, exportOpen ? false : true);
    });
    exportBtn.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "Down") {
        event.preventDefault();
        setExportOpen(true, true);
      }
    });
  }

  if (exportSvgBtn) exportSvgBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    setExportOpen(false, true);
    exportSvg();
  });
  if (exportPngBtn) exportPngBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    setExportOpen(false, true);
    exportPng();
  });
  if (exportWebpBtn) exportWebpBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    setExportOpen(false, true);
    exportWebp();
  });
  if (exportJpegBtn) exportJpegBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    setExportOpen(false, true);
    exportJpeg();
  });

  if (exportMenu) {
    exportMenu.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Down" && event.key !== "Up") return;
      event.preventDefault();
      var items = exportList();
      if (!items.length) return;
      var index = items.indexOf(doc.activeElement);
      var next = event.key === "ArrowDown" || event.key === "Down"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
      items[next].focus();
    });
  }

  doc.addEventListener("click", function (event) {
    if (!exportOpen) return;
    if (exportWrap && event.target && exportWrap.contains(event.target)) return;
    setExportOpen(false, false);
  });

  /* ---- focus mode ----------------------------------------------------- */

  function focusModeOn() {
    return !!(doc.body && doc.body.classList.contains("focus-mode"));
  }

  function setFocusMode(on) {
    if (!doc.body) return;
    doc.body.classList.toggle("focus-mode", !!on);
    syncToStage();
    announce(on ? "Focus mode on; press f or Escape to exit." : "Focus mode off.");
  }

  if (focusExitBtn) {
    focusExitBtn.addEventListener("click", function () {
      setFocusMode(false);
      if (focusExitBtn.blur) focusExitBtn.blur();
    });
  }

  /* ---- reset ---------------------------------------------------------- */

  function resetView() {
    applyFit();
  }

  function resetAll(withMessage) {
    if (tour.on) {
      tour.on = false;
      syncTourbar();
    }
    if (route.mode) clearRoute(false);
    resetView();
    clearFocus(true);
    writeHash();
    if (withMessage) announce("View and focus reset.");
  }

  /* ---- keyboard ------------------------------------------------------- */

  function closeAnySearch() {
    if (findbar && !findbar.hidden) {
      closeFind(false);
      return true;
    }
    return false;
  }

  doc.addEventListener("keydown", function (event) {
    if (event.defaultPrevented) return;
    var target = event.target;
    var inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    /* In-page search takes Ctrl/Cmd+F away from the browser find bar. */
    if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      openFind();
      return;
    }
    if (inField) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === "Escape") {
      if (helpOpen) { event.preventDefault(); setHelp(false); return; }
      if (exportOpen) { event.preventDefault(); setExportOpen(false, true); return; }
      if (closeAnySearch()) { event.preventDefault(); return; }
      if (present) { event.preventDefault(); setPresent(false); return; }
      if (route.mode) { event.preventDefault(); clearRoute(true); return; }
      if (tour.on) { event.preventDefault(); exitTour(true); return; }
      if (insp && !insp.hidden) {
        event.preventDefault();
        closeInsp();
        clearFocus(true);
        announce("Inspector closed; focus cleared.");
        return;
      }
      if (pinned || hovered) { clearFocus(false); return; }
      if (focusModeOn()) setFocusMode(false);
      return;
    }

    if (event.key === "?") {
      event.preventDefault();
      setHelp(!helpOpen);
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      if (route.mode) clearRoute(true);
      else enterRoute(null);
      return;
    }
    if (event.key === "p" || event.key === "P") {
      event.preventDefault();
      setPresent(!present);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.2);
      writeHash();
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / 1.2);
      writeHash();
      return;
    }

    if (tour.steps.length) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        tourNext();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        tourPrev();
        return;
      }
      if (event.key === " " || event.key === "Spacebar" || event.key === "Space") {
        if (target && target.closest && target.closest(".node")) return;
        event.preventDefault();
        tourNext();
        return;
      }
      if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        toggleTour();
        return;
      }
    }

    if (event.key === "0") {
      event.preventDefault();
      resetAll(true);
    } else if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      setFocusMode(!focusModeOn());
    }
  });

  applyFit();
  try {
    restoreHash();
  } catch (err) {
    /* a malformed hash must never break the page */
  }
  if (!mmReady) {
    try { mmBuild(); } catch (err) { /* no minimap on this engine */ }
  }
})();
