// Server-side export: turn a rendered Naqsha document into a standalone SVG or PNG.
//
// SVG: the composed HTML is opened in headless Chrome with an injected script that
// clones the diagram <svg>, inlines the document's CSS (so text, tokens and fills
// survive outside the page) and replaces the body with it. `--dump-dom` then hands
// us the serialized SVG. PNG: the same browser, `--screenshot`.
//
// Zero dependencies; Chrome is resolved by the CLI exactly like `naqsha screenshot`.

export const EXPORT_FORMATS = ["svg", "png"];

// Runs inside the page, before --dump-dom. Kept ES5-ish on purpose.
const INLINE_SCRIPT = `
(function () {
  var svg = document.getElementById("diagram");
  if (!svg) return;
  var clone = svg.cloneNode(true);
  clone.removeAttribute("id");
  clone.removeAttribute("class");
  clone.removeAttribute("tabindex");
  var drop = ["is-dim", "is-active", "is-focus", "is-route", "is-match", "is-kind-hidden"];
  Array.prototype.forEach.call(clone.querySelectorAll("[class]"), function (el) {
    for (var i = 0; i < drop.length; i++) el.classList.remove(drop[i]);
  });
  Array.prototype.forEach.call(clone.querySelectorAll("[tabindex]"), function (el) {
    el.removeAttribute("tabindex");
  });

  var css = [];
  for (var s = 0; s < document.styleSheets.length; s++) {
    var rules;
    try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
    for (var r = 0; r < rules.length; r++) css.push(rules[r].cssText);
  }
  var style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = css.join("\\n");
  clone.insertBefore(style, clone.firstChild);

  var w = svg.getAttribute("data-scene-width") || svg.getAttribute("width");
  var h = svg.getAttribute("data-scene-height") || svg.getAttribute("height");
  clone.setAttribute("width", w);
  clone.setAttribute("height", h);
  clone.setAttribute("viewBox", "0 0 " + w + " " + h);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  document.body.textContent = "";
  document.body.appendChild(clone);
})();
`;

/** Append the inlining script to a composed document. */
export function withInlineScript(html) {
  const script = `<script>${INLINE_SCRIPT}</script>`;
  if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
  return html + script;
}

/** Pull the first complete <svg>…</svg> out of a --dump-dom string. */
export function extractSvg(domText) {
  const start = domText.indexOf("<svg");
  if (start === -1) return null;
  const end = domText.lastIndexOf("</svg>");
  if (end === -1 || end < start) return null;
  const svg = domText.slice(start, end + "</svg>".length);
  return svg.startsWith("<?xml") ? svg : `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
}

/** True when the serialized SVG looks like a diagram rather than an icon. */
export function looksLikeDiagram(svgText) {
  return typeof svgText === "string" && svgText.length > 500 && /class="node/.test(svgText);
}
