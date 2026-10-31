/**
 * Hermes OpenSpec — Dashboard Plugin
 *
 * Spec-driven development board backed by the plugin's own backend at
 * /api/plugins/openspec/. Register repos with an openspec/ folder, drill into
 * change proposals/tasks/designs/specs, and browse current specs or branch
 * diffs.
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn primitives. Mirrors the kanban dashboard plugin pattern.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  var React = SDK.React;
  var h = React.createElement;
  var C = SDK.components;
  var Button = C.Button, Card = C.Card, CardContent = C.CardContent, Badge = C.Badge;
  var Input = C.Input, Label = C.Label, Select = C.Select, SelectOption = C.SelectOption;
  var Separator = C.Separator;
  var useState = SDK.hooks.useState, useEffect = SDK.hooks.useEffect;
  var useCallback = SDK.hooks.useCallback, useMemo = SDK.hooks.useMemo, useRef = SDK.hooks.useRef;
  var cn = SDK.utils.cn;
  var isoTimeAgo = SDK.utils.isoTimeAgo;
  var fetchJSON = SDK.fetchJSON;

  var BASE = "/api/plugins/openspec";

  // ── API helpers ──────────────────────────────────────────────────────
  function apiErr(err) {
    var raw = err && err.message ? String(err.message) : String(err || "");
    var m = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
    var body = m ? m[2] : raw;
    try { var p = JSON.parse(body); if (p && typeof p.detail === "string") return p.detail; } catch (e) {}
    return body || raw;
  }
  function getSources() { return fetchJSON(BASE + "/sources"); }
  function addSource(path, name) {
    return fetchJSON(BASE + "/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path, name: name || undefined }) });
  }
  function updateSource(id, path, name) {
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path, name: name || undefined }) });
  }
  function removeSource(id) {
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(id), { method: "DELETE" });
  }
  function initSource(id) {
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(id) + "/init", { method: "POST" });
  }
  function getChange(sid, name) { return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/changes/" + encodeURIComponent(name)); }
  function getIdea(sid, name) { return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/ideas/" + encodeURIComponent(name)); }
  function getExploration(sid, name, scope) {
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/explorations/" + encodeURIComponent(name) + "?scope=" + encodeURIComponent(scope || "workspace"));
  }
  function discoverSources(sid, register) {
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/discover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ register: !!register }) });
  }
  function getSpec(sid, path) { return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/specs?path=" + encodeURIComponent(path)); }
  function getSpecBrowser(sid, params) {
    var qs = new URLSearchParams();
    if (params && params.before) qs.set("before", params.before);
    if (params && params.after) qs.set("after", params.after);
    if (params && params.dirty) qs.set("dirty", "true");
    var s = qs.toString();
    return fetchJSON(BASE + "/sources/" + encodeURIComponent(sid) + "/spec-browser" + (s ? "?" + s : ""));
  }

  // ── Minimal markdown renderer (headers, bold, code, lists, hr, para) ──
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code class="os-code">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
    s = s.replace(/(^|[^A-Za-z0-9_])_([^_\s][^_]*?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m, label, url) {
      return /^\s*(https?:\/\/|mailto:|\/(?!\/)|#|\?)/i.test(url) ? '<a href="' + url.replace(/"/g, "%22") + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : label + " [unsafe link]";
    });
    return s;
  }
  function splitRow(line) {
    var s = String(line).trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.length > 0 && s.charAt(s.length - 1) === "|" && s.charAt(s.length - 2) !== "\\") s = s.slice(0, -1);
    var cells = [], cur = "";
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === "\\" && s.charAt(k + 1) === "|") { cur += "|"; k++; continue; }
      if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }
  function isTableSep(line) {
    return line.indexOf("|") >= 0 && line.indexOf("-") >= 0 && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  }
  function renderMarkdown(md) {
    if (!md) return "";
    var lines = String(md).split("\n");
    var html = [];
    var i = 0;
    var inCode = false, codeBuf = [];
    var listType = null; // "ul" | "ol"
    var paraBuf = [];
    function flushPara() {
      if (paraBuf.length) { html.push("<p>" + inline(paraBuf.join(" ")) + "</p>"); paraBuf = []; }
    }
    function flushList() {
      if (listType) { html.push("</" + listType + ">"); listType = null; }
    }
    while (i < lines.length) {
      var line = lines[i];
      // fenced code block
      if (/^```/.test(line)) {
        if (inCode) { html.push('<pre class="os-pre"><code>' + esc(codeBuf.join("\n")) + "</code></pre>"); codeBuf = []; inCode = false; }
        else { flushPara(); flushList(); inCode = true; }
        i++; continue;
      }
      if (inCode) { codeBuf.push(line); i++; continue; }
      // heading
      var hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { flushPara(); flushList(); var lvl = hm[1].length; html.push("<h" + lvl + ">" + inline(hm[2]) + "</h" + lvl + ">"); i++; continue; }
      // hr
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); html.push('<hr class="os-hr"/>'); i++; continue; }
      // blockquote (consecutive > lines)
      if (/^\s{0,3}>/.test(line)) {
        flushPara(); flushList();
        var q = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { q.push(inline(lines[i].replace(/^\s{0,3}>\s?/, ""))); i++; }
        html.push('<blockquote class="os-quote">' + q.join("<br/>") + "</blockquote>");
        continue;
      }
      // table (header row + separator row + body rows)
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(line), sep = splitRow(lines[i + 1]);
        if (head.length === sep.length) {
          flushPara(); flushList();
          var al = sep.map(function (c) { var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":"; return l && r ? "center" : r ? "right" : "left"; });
          var t = ['<div class="os-table-wrap"><table class="os-table"><thead><tr>'];
          head.forEach(function (c, ci) { t.push('<th style="text-align:' + al[ci] + '">' + inline(c) + "</th>"); });
          t.push("</tr></thead><tbody>");
          i += 2;
          while (i < lines.length && lines[i].trim() !== "" && lines[i].indexOf("|") >= 0) {
            var cells = splitRow(lines[i]);
            t.push("<tr>");
            head.forEach(function (_c, ci) { t.push('<td style="text-align:' + al[ci] + '">' + inline(cells[ci] || "") + "</td>"); });
            t.push("</tr>");
            i++;
          }
          t.push("</tbody></table></div>");
          html.push(t.join(""));
          continue;
        }
      }
      // list item
      var lm = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (lm) {
        flushPara();
        var lt = /\d+\./.test(lm[2]) ? "ol" : "ul";
        if (listType !== lt) { flushList(); html.push("<" + lt + ' class="os-list">'); listType = lt; }
        html.push("<li>" + inline(lm[3]) + "</li>");
        i++; continue;
      }
      // blank line
      if (line.trim() === "") { flushPara(); flushList(); i++; continue; }
      // paragraph text
      flushList();
      paraBuf.push(line.trim());
      i++;
    }
    if (inCode) html.push('<pre class="os-pre"><code>' + esc(codeBuf.join("\n")) + "</code></pre>");
    flushPara(); flushList();
    return html.join("\n");
  }
  function Markdown(_ref) {
    var md = _ref.md;
    var html = useMemo(function () { return renderMarkdown(md); }, [md]);
    return h("div", { className: "os-md", dangerouslySetInnerHTML: { __html: html } });
  }

  // ── Icons (inline SVG, no icon lib available in plugin sandbox) ──────
  function Icon(_ref2) {
    var d = _ref2.d, size = _ref2.size;
    var s = size || 16;
    return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: d })
    );
  }
  var ICO = {
    refresh: "M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16",
    plus: "M12 5v14M5 12h14",
    edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z",
    trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
    copy: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z",
    close: "M18 6 6 18M6 6l12 12",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
    folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
    chevron: "M9 18l6-6-6-6",
    branch: "M6 3v12M18 9a3 3 0 1 0-3-3M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 0 1-3 3H6",
    proposal: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
    tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
    design: "M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
    specs: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  };

  // ── Modal (lightweight, no Dialog in SDK) ─────────────────────────────
  function Modal(_ref3) {
    var title = _ref3.title, onClose = _ref3.onClose, children = _ref3.children, wide = _ref3.wide;
    var _w = useState(function () { return readPref("drawerWidth", DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX, DRAWER_WIDTH_DEFAULT); });
    var modalW = _w[0], setModalW = _w[1];
    useEffect(function () {
      function onKey(e) { if (e.key === "Escape") onClose(); }
      window.addEventListener("keydown", onKey);
      return function () { window.removeEventListener("keydown", onKey); };
    }, [onClose]);
    function startResize(e) {
      e.preventDefault();
      var sx = e.clientX;
      function move(ev) { setModalW(clampVal(modalW + (ev.clientX - sx) * 2, DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX, DRAWER_WIDTH_DEFAULT)); }
      function up(ev) {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        writePref("drawerWidth", clampVal(modalW + (ev.clientX - sx) * 2, DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX, DRAWER_WIDTH_DEFAULT));
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }
    return h("div", { className: "os-overlay", onClick: onClose },
      h("div", {
        className: cn("os-modal", wide && "os-modal-wide"),
        style: wide ? { maxWidth: modalW + "px" } : undefined,
        onClick: function (e) { e.stopPropagation(); }
      },
        wide ? h("div", {
          role: "separator", "aria-orientation": "vertical", className: "os-modal-sash",
          title: "Drag to resize (double-click to reset)",
          onPointerDown: startResize,
          onDoubleClick: function () { setModalW(DRAWER_WIDTH_DEFAULT); writePref("drawerWidth", DRAWER_WIDTH_DEFAULT); }
        }) : null,
        h("div", { className: "os-modal-head" },
          h("span", { className: "os-modal-title" }, title),
          h("button", { className: "os-icon-btn", onClick: onClose, "aria-label": "Close" }, h(Icon, { d: ICO.close }))
        ),
        h("div", { className: "os-modal-body" }, children)
      )
    );
  }

  // ── Copy chip ────────────────────────────────────────────────────────
  function CopyChip(_ref4) {
    var text = _ref4.text;
    var _s = useState(false);
    var copied = _s[0], setCopied = _s[1];
    return h("button", {
      className: "os-chip",
      onClick: function () {
        navigator.clipboard.writeText(text).then(function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1200); });
      },
      title: "Copy: " + text,
    }, copied ? "copied" : text, h("span", { className: "os-chip-ico" }, h(Icon, { d: ICO.copy, size: 11 })));
  }

  // ── Status badge colors ──────────────────────────────────────────────
  var STATUS_LABEL = { ideas: "Ideas", draft: "Draft", todo: "Todo", in_progress: "In Progress", done: "Done", archived: "Archived" };
  var STATUS_TONE = { ideas: "os-tone-ideas", draft: "os-tone-draft", todo: "os-tone-todo", in_progress: "os-tone-progress", done: "os-tone-done", archived: "os-tone-archived" };
  var COLUMN_ORDER = ["ideas", "draft", "todo", "in_progress", "done", "archived"];

  // ── Explorations / reviews / Crew linkage helpers ────────────────────
  var VERDICT_CLASS = { APPROVED: "os-verdict-approved", REJECTED: "os-verdict-rejected", PENDING: "os-verdict-pending" };
  function verdictClass(v) { return VERDICT_CLASS[String(v || "").toUpperCase()] || VERDICT_CLASS.PENDING; }
  function scopeLabel(scope) {
    var s = String(scope || "workspace");
    return s.indexOf("change:") === 0 ? "Change: " + s.slice(7) : "Workspace";
  }
  function nonEmpty(list) { return Array.isArray(list) && list.length > 0; }

  // ── Slice 3c helpers (mirror desktop/plugin.js) ──────────────────────
  function filterSpecFiles(files, query) {
    var q = String(query || "").trim().toLowerCase();
    var list = files || [];
    if (!q) return list;
    return list.filter(function (f) {
      return [f.title, f.path, f.domain, f.purpose, f.token].some(function (v) {
        return String(v || "").toLowerCase().indexOf(q) >= 0;
      });
    });
  }
  function specCountsLabel(file) {
    if (!file || typeof file.requirementCount !== "number") return "";
    return file.requirementCount + " reqs \u00b7 " + (file.scenarioCount || 0) + " scenarios";
  }
  function specStatusBadgeVisible(status) { return status === "added" || status === "modified" || status === "deleted"; }
  function specRequirementText(req) {
    var parts = [req.name, req.description];
    (req.scenarios || []).forEach(function (scn) {
      parts.push(scn.name);
      (scn.steps || []).forEach(function (st) { parts.push(st.type, st.text); });
    });
    return parts.join("\n").toLowerCase();
  }
  // Keeps the original requirement index so R-numbers stay stable while filtering.
  function filterSpecRequirements(reqs, query) {
    var q = String(query || "").trim().toLowerCase();
    var out = [];
    (reqs || []).forEach(function (req, index) {
      if (!q || specRequirementText(req).indexOf(q) >= 0) out.push({ index: index, req: req });
    });
    return out;
  }
  function changeSlugFromScope(scope) {
    var s = String(scope || "");
    return s.indexOf("change:") === 0 ? s.slice(7) : "";
  }
  function reviewOptionLabel(r) {
    return "[" + (r.verdict || "PENDING") + "] " + r.name + (r.round != null ? " \u00b7 Round " + r.round : "");
  }
  var SPEC_KEYWORD_RE = /\b(SHALL NOT|MUST NOT|SHOULD NOT|SHALL|MUST|SHOULD)\b/g;
  function renderSpecKeywords(text) {
    var parts = [];
    var src = String(text || "");
    var last = 0, m;
    SPEC_KEYWORD_RE.lastIndex = 0;
    while ((m = SPEC_KEYWORD_RE.exec(src)) !== null) {
      if (m.index > last) parts.push(src.slice(last, m.index));
      parts.push(h("strong", { key: "kw" + m.index, className: cn("os-spec-kw", m[1].indexOf("NOT") >= 0 && "os-spec-kw-not") }, m[1]));
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push(src.slice(last));
    return parts;
  }
  function sortExplorations(items) {
    return (items || []).slice().sort(function (a, b) {
      var da = String(a.date || ""), db = String(b.date || "");
      if (da !== db) return da < db ? 1 : -1;
      return String(a.title || a.name || "").localeCompare(String(b.title || b.name || ""));
    });
  }

  var CREW_BUCKETS = ["running", "review", "blocked", "queued", "done"];
  var CREW_INLINE_LIMIT = 3;
  var POLL_INTERVAL_MS = 5000;
  var SPECS_SIDEBAR_DEFAULT = 260, SPECS_SIDEBAR_MIN = 180, SPECS_SIDEBAR_MAX = 480;
  var DRAWER_WIDTH_DEFAULT = 720, DRAWER_WIDTH_MIN = 380, DRAWER_WIDTH_MAX = 960;

  function normalizeStatus(status) {
    var s = String(status || "").toLowerCase();
    if (s === "in-progress" || s === "inprogress" || s === "in_progress") return "in-progress";
    if (s === "ideas" || s === "draft" || s === "todo" || s === "done" || s === "archived") return s;
    return "todo";
  }

  function normalizeSequencePosition(sequence) {
    var position = sequence && typeof sequence === "object" ? sequence.position : sequence;
    return typeof position === "number" && isFinite(position) ? position : null;
  }

  function groupCrewCardsByStatus(cards) {
    var g = { total: 0, running: [], review: [], blocked: [], queued: [], done: [], activeState: "idle" };
    var list = Array.isArray(cards) ? cards : [];
    for (var i = 0; i < list.length; i++) {
      var card = list[i];
      if (!card) continue;
      var st = String(card.status || "").toLowerCase();
      if (st === "archived") continue;
      g.total++;
      if (st === "running") g.running.push(card);
      else if (st === "review") g.review.push(card);
      else if (st === "blocked" || st === "triage") g.blocked.push(card);
      else if (st === "done" || st === "completed") g.done.push(card);
      else g.queued.push(card);
    }
    if (g.running.length > 0) g.activeState = "running";
    else if (g.review.length > 0) g.activeState = "review";
    else if (g.blocked.length > 0) g.activeState = "blocked";
    else if (g.queued.length > 0) g.activeState = "queued";
    else if (g.done.length > 0) g.activeState = "done";
    return g;
  }

  function itemActivityRank(item) {
    var g = groupCrewCardsByStatus(item && Array.isArray(item.crewCards) ? item.crewCards : []);
    if (g.running.length > 0) return 0;
    if (g.review.length > 0) return 1;
    if (g.blocked.length > 0) return 2;
    if (g.queued.length > 0) return 3;
    return 4;
  }

  function effectiveChangeStatus(item) {
    var base = normalizeStatus(item && (item.status || item.state || item.phase));
    if (base !== "todo" && base !== "draft") return base;
    var g = groupCrewCardsByStatus(item && Array.isArray(item.crewCards) ? item.crewCards : []);
    return (g.running.length > 0 || g.review.length > 0 || g.done.length > 0) ? "in-progress" : base;
  }

  function sortItems(items) {
    return (items || []).slice().sort(function (a, b) {
      var ra = itemActivityRank(a), rb = itemActivityRank(b);
      if (ra !== rb) return ra - rb;
      var sa = normalizeSequencePosition(a.sequence), sb = normalizeSequencePosition(b.sequence);
      if (sa == null) sa = 9999;
      if (sb == null) sb = 9999;
      if (sa !== sb) return sa - sb;
      var ta = (a.title || a.name || "").toLowerCase(), tb = (b.title || b.name || "").toLowerCase();
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
  }

  function clampVal(px, min, max, fallback) {
    var n = (px == null || px === "") ? NaN : Number(px);
    if (!isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function readPref(key, min, max, fallback) {
    try { return clampVal(window.localStorage && window.localStorage.getItem("openspec." + key), min, max, fallback); } catch (e) { return fallback; }
  }
  function writePref(key, v) {
    try { if (window.localStorage) window.localStorage.setItem("openspec." + key, String(v)); } catch (e) {}
  }

  function CrewCards(_ref) {
    var cards = _ref.cards;
    var grouped = groupCrewCardsByStatus(cards);
    var _o = useState(grouped.total <= CREW_INLINE_LIMIT), _f = useState(null);
    var open = _o[0], setOpen = _o[1], filter = _f[0], setFilter = _f[1];
    if (!grouped.total) return null;
    var GLYPH = { running: "\u25cf", review: "\u25d0", blocked: "!", queued: "\u25cb", done: "\u2713" };
    var show = open || !!filter;
    var tickets = [];
    CREW_BUCKETS.forEach(function (k) { if (!filter || filter === k) tickets = tickets.concat(grouped[k]); });
    return h("div", { className: "os-crew-widget" },
      h("div", { className: "os-crew-summary" },
        h("span", { className: "os-crew-label" }, "Crew"),
        CREW_BUCKETS.filter(function (k) { return grouped[k].length > 0; }).map(function (k) {
          return h("button", {
            key: k, type: "button", className: cn("os-crew-pill", "os-crew-pill-" + k, filter === k && "os-crew-pill-active"),
            onClick: function () { setFilter(filter === k ? null : k); if (filter !== k) setOpen(true); }
          }, GLYPH[k] + " " + grouped[k].length + " " + k);
        }),
        h("button", {
          type: "button", className: "os-crew-toggle",
          onClick: function () { if (show) { setOpen(false); setFilter(null); } else { setOpen(true); } }
        }, show ? "\u25b4 Hide" : "\u25be " + grouped.total + " tickets")
      ),
      show ? h("div", { className: "os-crew-cards" }, tickets.map(function (c) {
        return h("span", { key: c.id, className: "os-crew-card" },
          h("a", { className: "os-crew-link", href: c.url, title: [c.title, c.assignee, c.board].filter(Boolean).join(" \u00b7 ") }, c.id + " " + (c.status || "")),
          c.title ? h("span", { className: "os-crew-title" }, c.title + (c.assignee ? " \u00b7 @" + c.assignee : "")) : null,
          h(CopyChip, { text: c.id })
        );
      })) : null
    );
  }

  function ReviewsTab(_ref) {
    var reviews = _ref.reviews;
    var _i = useState(Math.max(0, (reviews || []).length - 1));
    var idx = _i[0], setIdx = _i[1];
    if (!nonEmpty(reviews)) return h("p", { className: "os-empty" }, "No reviews.");
    var cur = reviews[Math.min(idx, reviews.length - 1)] || reviews[reviews.length - 1];
    return h("div", { className: "os-reviews" },
      reviews.length > 1 ? h("select", {
        className: "os-expl-select os-review-select", value: reviews.indexOf(cur),
        onChange: function (e) { setIdx(parseInt(e.target.value, 10)); }
      }, reviews.map(function (r, i) {
        return h("option", { key: r.token || r.name, value: i }, reviewOptionLabel(r));
      })) : null,
      h("div", { className: "os-review-meta" },
        h(Badge, { className: cn("os-verdict", verdictClass(cur.verdict)) }, cur.verdict || "PENDING"),
        h("span", { className: "os-review-file" }, cur.filename),
        cur.round != null ? h("span", { className: "os-review-round" }, "Round " + cur.round) : null
      ),
      h(Markdown, { md: cur.content })
    );
  }

  // Inline Explorations tab for the change dialog: dropdown when N > 1, direct selection when N === 1.
  function ChangeExplorationsPanel(_ref) {
    var explorations = _ref.explorations, source = _ref.source;
    var list = sortExplorations(explorations);
    var _i = useState(0);
    var idx = _i[0], setIdx = _i[1];
    if (!list.length) return h("p", { className: "os-empty" }, "No explorations.");
    var ex = list[Math.min(idx, list.length - 1)];
    var _d = useState(null), _l = useState(true), _e = useState("");
    var detail = _d[0], setDetail = _d[1], loading = _l[0], setLoading = _l[1], err = _e[0], setErr = _e[1];
    useEffect(function () {
      var alive = true;
      setLoading(true); setErr(""); setDetail(null);
      getExploration(source.id, ex.name, ex.scope).then(function (d) { if (alive) { setDetail(d); setLoading(false); } }).catch(function (e) { if (alive) { setErr(apiErr(e)); setLoading(false); } });
      return function () { alive = false; };
    }, [source.id, ex.name, ex.scope]);
    var data = detail || ex;
    return h("div", { className: "os-expl-inline-wrap" },
      list.length > 1 ? h("select", {
        className: "os-expl-select", value: list.indexOf(ex),
        onChange: function (e) { setIdx(parseInt(e.target.value, 10)); }
      }, list.map(function (x, i) { return h("option", { key: x.token || x.name, value: i }, x.title || x.name); })) : null,
      h("div", { className: "os-expl-meta os-expl-meta-inline" },
        ex.date ? h("span", { className: "os-expl-date" }, ex.date) : null,
        h(Badge, { variant: "outline", className: "os-expl-scope" }, scopeLabel(ex.scope)),
        h("span", { className: "os-expl-file" }, ex.filename),
        ex.token ? h(CopyChip, { text: source.name + "/" + ex.token }) : null
      ),
      h(CrewCards, { cards: (detail && detail.crewCards) || ex.crewCards }),
      h("div", { className: "os-expl-inline" },
        loading ? h("p", { className: "os-empty" }, "Loading\u2026") :
          err ? h("p", { className: "os-err" }, err) :
            h(Markdown, { md: data.content })
      )
    );
  }

  function ExplorationList(_ref) {
    var items = _ref.items, source = _ref.source, onSelect = _ref.onSelect;
    return h("div", { className: "os-expl-list" }, sortExplorations(items).map(function (ex) {
      return h("button", { key: ex.token || ex.name, className: "os-expl-row", onClick: function () { onSelect(ex); } },
        h("div", { className: "os-expl-title" }, ex.title || ex.name),
        h("div", { className: "os-expl-meta" },
          ex.date ? h("span", { className: "os-expl-date" }, ex.date) : null,
          h(Badge, { variant: "outline", className: "os-expl-scope" }, scopeLabel(ex.scope)),
          h("span", { className: "os-expl-file" }, ex.filename),
          ex.token ? h("span", { className: "os-expl-token", title: "Copy: " + source.name + "/" + ex.token,
            onClick: function (e) { e.stopPropagation(); navigator.clipboard.writeText(source.name + "/" + ex.token); } }, ex.token) : null
        )
      );
    }));
  }

  function ExplorationsPanel(_ref) {
    var source = _ref.source, onSelect = _ref.onSelect;
    var all = (source.openspec && source.openspec.explorations) || [];
    var _f = useState("");
    var q = _f[0], setQ = _f[1];
    var needle = q.trim().toLowerCase();
    var rows = !needle ? all : all.filter(function (ex) {
      return [ex.title, ex.name, ex.scope, ex.token].some(function (v) { return String(v || "").toLowerCase().indexOf(needle) >= 0; });
    });
    if (!all.length) return h("p", { className: "os-empty" }, "No explorations found.");
    return h("div", { className: "os-explorations" },
      h("div", { className: "os-board-filter" },
        h(Input, { placeholder: "Filter by title, scope, or token…", value: q, onChange: function (e) { setQ(e.target.value); }, className: "os-filter-input" })),
      rows.length ? h(ExplorationList, { items: rows, source: source, onSelect: onSelect }) : h("p", { className: "os-empty" }, "No explorations match \"" + q + "\"")
    );
  }

  function ExplorationDialog(_ref) {
    var source = _ref.source, item = _ref.item, onClose = _ref.onClose, onBackToChange = _ref.onBackToChange;
    var _d = useState(null), _l = useState(true), _e = useState("");
    var detail = _d[0], setDetail = _d[1], loading = _l[0], setLoading = _l[1], err = _e[0], setErr = _e[1];
    useEffect(function () {
      setLoading(true); setErr(""); setDetail(null);
      getExploration(source.id, item.name, item.scope).then(function (d) { setDetail(d); setLoading(false); }).catch(function (e) { setErr(apiErr(e)); setLoading(false); });
    }, [source.id, item.name, item.scope]);
    var data = detail || item;
    var changeSlug = changeSlugFromScope(data.scope || item.scope);
    var canGoBack = !!changeSlug && typeof onBackToChange === "function";
    return h(Modal, { title: item.title || item.name, onClose: onClose, wide: true },
      canGoBack ? h("button", { type: "button", className: "os-back-to-change", onClick: function () { onBackToChange(changeSlug); } }, "\u2190 Back to " + changeSlug) : null,
      h("div", { className: "os-detail-chip" },
        h(CopyChip, { text: source.name + "/" + item.token }),
        canGoBack
          ? h("button", { type: "button", className: "os-change-link", title: "Open change " + changeSlug, onClick: function () { onBackToChange(changeSlug); } }, h(Badge, { variant: "outline" }, scopeLabel(data.scope)))
          : h(Badge, { variant: "outline" }, scopeLabel(data.scope)),
        data.date ? h("span", { className: "os-expl-date" }, data.date) : null,
        data.path ? h(CopyChip, { text: data.path }) : null),
      h(CrewCards, { cards: (detail && detail.crewCards) || item.crewCards }),
      loading ? h("p", { className: "os-empty" }, "Loading…") :
        err ? h("p", { className: "os-err" }, err) :
          h(Markdown, { md: detail && detail.content })
    );
  }

  function DiscoverDialog(_ref) {
    var source = _ref.source, onClose = _ref.onClose, onDone = _ref.onDone;
    var _r = useState(null), _b = useState(true), _e = useState("");
    var result = _r[0], setResult = _r[1], busy = _b[0], setBusy = _b[1], err = _e[0], setErr = _e[1];
    function run(register) {
      setBusy(true); setErr("");
      return discoverSources(source.id, register).then(function (res) {
        setResult(res); setBusy(false);
        if (register && onDone) onDone(res);
      }).catch(function (e) { setErr(apiErr(e)); setBusy(false); });
    }
    useEffect(function () { run(false); }, [source.id]);
    var candidates = (result && result.candidates) || [];
    var fresh = candidates.filter(function (c) { return !c.alreadyRegistered; });
    return h(Modal, { title: "Discover OpenSpec sources", onClose: onClose },
      busy && !result ? h("p", { className: "os-empty" }, "Scanning…") : null,
      err ? h("p", { className: "os-err" }, err) : null,
      result && !candidates.length ? h("p", { className: "os-empty" }, "No child repositories with an openspec/ folder were found.") : null,
      candidates.length ? h("div", { className: "os-discover-list" }, candidates.map(function (c) {
        return h("div", { key: c.path, className: "os-discover-row" },
          h("span", { className: "os-discover-name" }, c.name),
          h("span", { className: "os-discover-path", title: c.path }, c.path),
          c.alreadyRegistered ? h(Badge, { variant: "outline" }, "registered") : null);
      })) : null,
      h("div", { className: "os-dialog-actions" },
        h(Button, { variant: "outline", onClick: onClose, disabled: busy }, "Close"),
        h(Button, { onClick: function () { run(true); }, disabled: busy || !fresh.length }, busy ? "Working…" : "Register " + fresh.length + " new")
      )
    );
  }

  // ── Source toolbar ───────────────────────────────────────────────────
  function Toolbar(_ref5) {
    var sources = _ref5.sources, activeId = _ref5.activeId, onSelect = _ref5.onSelect;
    var onRefresh = _ref5.onRefresh, onAdd = _ref5.onAdd, onEdit = _ref5.onEdit, onRemove = _ref5.onRemove, onDiscover = _ref5.onDiscover;
    var active = sources.find(function (s) { return s.id === activeId; });
    return h("div", { className: "os-toolbar" },
      h(Label, { htmlFor: "os-project" }, "Project"),
      h(Select, { id: "os-project", value: activeId || "", onValueChange: onSelect },
        sources.length === 0 ? h(SelectOption, { value: "" }, "—") : null,
        sources.map(function (s) { return h(SelectOption, { key: s.id, value: s.id }, s.name + (s.valid ? "" : " (invalid)")); })
      ),
      h("button", { className: "os-icon-btn", onClick: onRefresh, title: "Refresh", disabled: sources.length === 0 }, h(Icon, { d: ICO.refresh })),
      h("div", { className: "os-toolbar-actions" },
        h(Button, { variant: "outline", size: "sm", onClick: onDiscover, disabled: !active || !active.valid, title: "Discover OpenSpec repositories under this source" }, "Discover"),
        h("button", { className: "os-icon-btn", onClick: onEdit, title: "Edit source", disabled: !active }, h(Icon, { d: ICO.edit })),
        h("button", { className: "os-icon-btn", onClick: onRemove, title: "Remove source", disabled: !active }, h(Icon, { d: ICO.trash })),
        h("button", { className: "os-icon-btn", onClick: onAdd, title: "Add source" }, h(Icon, { d: ICO.plus }))
      )
    );
  }

  // ── Add / Edit dialogs ───────────────────────────────────────────────
  function SourceDialog(_ref6) {
    var mode = _ref6.mode, initialPath = _ref6.initialPath, initialName = _ref6.initialName, onClose = _ref6.onClose, onSaved = _ref6.onSaved;
    var activeId = _ref6.activeId;
    var _p = useState(initialPath || ""), _n = useState(initialName || ""), _b = useState(false), _e = useState("");
    var path = _p[0], setPath = _p[1], name = _n[0], setName = _n[1], busy = _b[0], setBusy = _b[1], err = _e[0], setErr = _e[1];
    function save() {
      if (!path.trim()) { setErr("Path is required"); return; }
      setBusy(true); setErr("");
      var p = mode === "edit" ? updateSource(activeId, path.trim(), name.trim()) : addSource(path.trim(), name.trim());
      p.then(function (res) { onSaved(res); }).catch(function (e) { setErr(apiErr(e)); setBusy(false); });
    }
    return h(Modal, { title: mode === "edit" ? "Edit OpenSpec source" : "Add OpenSpec source", onClose: onClose },
      h("div", { className: "os-field" },
        h(Label, { htmlFor: "os-path" }, "Path"),
        h(Input, { id: "os-path", value: path, onChange: function (e) { setPath(e.target.value); }, placeholder: "~/repos/my-project", disabled: busy })
      ),
      h("div", { className: "os-field" },
        h(Label, { htmlFor: "os-name" }, "Display name (optional)"),
        h(Input, { id: "os-name", value: name, onChange: function (e) { setName(e.target.value); }, placeholder: "my-project", disabled: busy })
      ),
      err ? h("p", { className: "os-err" }, err) : null,
      h("div", { className: "os-dialog-actions" },
        h(Button, { variant: "outline", onClick: onClose, disabled: busy }, "Cancel"),
        h(Button, { onClick: save, disabled: busy }, busy ? "Saving…" : "Save")
      )
    );
  }

  // ── Board (kanban) ───────────────────────────────────────────────────
  function Board(_ref7) {
    var source = _ref7.source, onSelectItem = _ref7.onSelectItem;
    var board = source.openspec;
    var _ft = useState(""), _sa = useState(true);
    var filterText = _ft[0], setFilterText = _ft[1];
    var showArchived = _sa[0], setShowArchived = _sa[1];
    if (!board) return h("p", { className: "os-empty" }, "No openspec/ content found.");
    var filter = filterText.trim().toLowerCase();
    function matchesFilter(it) {
      if (!filter) return true;
      return (it.title || it.name || "").toLowerCase().indexOf(filter) >= 0 ||
             (it.name || "").toLowerCase().indexOf(filter) >= 0 ||
             (it.token || "").toLowerCase().indexOf(filter) >= 0;
    }
    var byCol = {};
    COLUMN_ORDER.forEach(function (c) { byCol[c] = []; });
    board.ideas.forEach(function (it) { if (matchesFilter(it)) byCol.ideas.push(it); });
    board.changes.forEach(function (ch) {
      var eff = effectiveChangeStatus(ch);
      var col = eff === "in-progress" ? "in_progress" : eff;
      (byCol[col] || (byCol[col] = [])).push(ch);
    });
    // Filter changes in non-archived columns too
    COLUMN_ORDER.forEach(function (c) {
      if (c !== "ideas") byCol[c] = (byCol[c] || []).filter(matchesFilter);
    });
    var visibleColumns = COLUMN_ORDER.filter(function (c) { return c !== "archived" || showArchived; });
    var totalVisible = visibleColumns.reduce(function (n, c) { return n + (byCol[c] || []).length; }, 0);
    return h("div", { className: "os-board" },
      h("div", { className: "os-board-head" },
        h("span", { className: "os-repo-name" }, source.name),
        h(CopyChip, { text: source.name }),
        h("span", { className: "os-repo-path" }, source.path)
      ),
      h("div", { className: "os-board-filter" },
        h(Input, { placeholder: "🔍 Filter by title, name, or token…", value: filterText, onChange: function (e) { setFilterText(e.target.value); }, className: "os-filter-input" }),
        h(Button, { variant: showArchived ? "default" : "outline", size: "sm", onClick: function () { setShowArchived(!showArchived); } }, "Archived " + (showArchived ? "✓" : "✗"))
      ),
      totalVisible === 0 && filter ? h("div", { className: "os-empty" }, "No cards match \"" + filterText + "\"") :
      h("div", { className: "os-cols" },
        visibleColumns.map(function (col) {
          var items = sortItems(byCol[col] || []);
          return h("div", { key: col, className: "os-col" },
            h("div", { className: "os-col-head" },
              h("span", null, STATUS_LABEL[col] || col),
              h(Badge, { variant: "secondary" }, String(items.length))
            ),
            h("div", { className: "os-col-list" },
              items.length === 0 ? h("span", { className: "os-col-empty" }, "—") :
                items.map(function (it) {
                  var artifacts = [
                    { on: it.hasProposal, c: "#60a5fa", label: "proposal" },
                    { on: it.hasTasks, c: "#34d399", label: "tasks" },
                    { on: it.hasDesign, c: "#a78bfa", label: "design" },
                    { on: it.hasSpecs, c: "#fbbf24", label: "specs" },
                  ];
                  var pct = it.taskStats && it.taskStats.total > 0 ? Math.round((it.taskStats.done / it.taskStats.total) * 100) : 0;
                  var cg = groupCrewCardsByStatus(it.crewCards);
                  var effCol = effectiveChangeStatus(it) === "in-progress" ? "in_progress" : effectiveChangeStatus(it);
                  var radarCls = cg.activeState === "running" ? "os-card-live" : (cg.activeState === "review" ? "os-card-review" : "");
                  return h("button", {
                    key: it.id || it.name, "data-radar": cg.activeState === "running" || cg.activeState === "review" ? cg.activeState : undefined,
                    className: cn("os-card", STATUS_TONE[effCol] || "", radarCls), onClick: function () { onSelectItem(it); },
                  },
                    h("div", { className: "os-card-title" },
                      it.sequence ? h("span", { className: "os-card-seq", title: "Sequence " + it.sequence.position + (it.sequence.dependsOn && it.sequence.dependsOn.length ? "; depends on " + it.sequence.dependsOn.join(", ") : "") }, "#" + it.sequence.position) : null,
                      it.title || it.name
                    ),
                    h("div", { className: "os-card-foot" },
                      h("span", { className: "os-card-artifacts" },
                        artifacts.map(function (a, i) { return h("span", { key: i, className: cn("os-card-dot", !a.on && "os-card-dot-off"), title: a.label }); })
                      ),
                      it.taskStats ? h("span", { className: "os-card-progress" },
                        h("span", { className: "os-card-progress-track" }, h("span", { className: "os-card-progress-fill", style: { width: pct + "%" } })),
                        h("span", { className: "os-card-stats" }, it.taskStats.done + "/" + it.taskStats.total)
                      ) : null,
                      cg.total > 0 ? h("span", { className: "os-card-crew" },
                        cg.running.length ? h("span", { className: "os-crew-pill-running" }, "\u25cf " + cg.running.length + " running") : null,
                        cg.review.length ? h("span", { className: "os-crew-pill-review" }, "\u25d0 " + cg.review.length + " review") : null,
                        !cg.running.length && !cg.review.length ? h("span", { className: "os-card-stats" }, "Crew " + cg.done.length + "/" + cg.total) : null
                      ) : null,
                      it.token ? h("button", {
                        className: "os-card-copy",
                        title: "Copy: " + source.name + "/" + it.token,
                        onClick: function (e) { e.stopPropagation(); navigator.clipboard.writeText(source.name + "/" + it.token); }
                      }, h(Icon, { d: ICO.copy, size: 12 })) : null
                    )
                  );
                })
            )
          );
        })
      )
    );
  }

  // ── Change / Idea detail dialog ──────────────────────────────────────
  function DetailDialog(_ref8) {
    var source = _ref8.source, item = _ref8.item, onClose = _ref8.onClose, anchor = _ref8.anchor, onTabChange = _ref8.onTabChange, onSelectExploration = _ref8.onSelectExploration;
    var _d = useState(null), _l = useState(true), _e2 = useState("");
    var detail = _d[0], setDetail = _d[1], loading = _l[0], setLoading = _l[1], err = _e2[0], setErr = _e2[1];
    var isIdea = item.status === "ideas";
    useEffect(function () {
      var alive = true;
      setLoading(true); setErr(""); setDetail(null);
      function pull(first) {
        var p = isIdea ? getIdea(source.id, item.name) : getChange(source.id, item.name);
        p.then(function (d) { if (!alive) return; setDetail(d); if (first) setLoading(false); })
         .catch(function (e) { if (!alive) return; if (first) { setErr(apiErr(e)); setLoading(false); } });
      }
      pull(true);
      var timer = !isIdea && typeof setInterval === "function" ? setInterval(function () { pull(false); }, POLL_INTERVAL_MS) : null;
      return function () { alive = false; if (timer && typeof clearInterval === "function") clearInterval(timer); };
    }, [source.id, item.name, isIdea]);
    var stats = (detail && detail.taskStats) || item.taskStats;
    var crew = groupCrewCardsByStatus((detail && detail.crewCards) || item.crewCards);
    return h(Modal, { title: item.title || item.name, onClose: onClose, wide: true },
      h("div", { className: "os-detail-chip" },
        h(CopyChip, { text: source.name + "/" + item.token }),
        stats ? h(Badge, { variant: "outline" }, "Checklist: " + stats.done + "/" + stats.total) : null,
        crew.total > 0 ? h(Badge, { variant: "outline" }, "Crew: " + crew.done.length + "/" + crew.total + " done" + (crew.running.length ? " \u00b7 " + crew.running.length + " running" : "")) : null
      ),
      loading ? h("p", { className: "os-empty" }, "Loading…") :
        err ? h("p", { className: "os-err" }, err) :
          isIdea ? h(Markdown, { md: detail && detail.content }) :
            detail ? h(ChangeDetailTabs, { detail: detail, anchor: anchor, onTabChange: onTabChange, source: source, onSelectExploration: onSelectExploration }) : null
    );
  }
  // ── Task parser ─────────────────────────────────────────────────────
  function parseTasks(md) {
    if (!md) return { sections: [], total: 0, done: 0 };
    var lines = md.split("\n");
    var sections = [];
    var current = null;
    var total = 0, done = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var h = line.match(/^##\s+(.+)$/);
      if (h) {
        current = { title: h[1].trim(), tasks: [] };
        sections.push(current);
        continue;
      }
      var t = line.match(/^[-*]\s+\[(.)\]\s+(.+)$/);
      if (t) {
        var checked = t[1] === "x" || t[1] === "X";
        var text = t[2].trim();
        if (checked) done++;
        total++;
        if (current) current.tasks.push({ checked: checked, text: text });
        else { current = { title: "", tasks: [] }; sections.push(current); current.tasks.push({ checked: checked, text: text }); }
      }
    }
    return { sections: sections, total: total, done: done };
  }

  function ChangeSpecsView(_ref11) {
    var specs = _ref11.specs;
    var _m = useState("proposed");
    var mode = _m[0], setMode = _m[1];
    return h("div", null,
      h("div", { className: "os-specs-modes", style: { marginBottom: "0.5rem" } },
        h(Button, { variant: mode === "proposed" ? "default" : "outline", size: "sm", onClick: function () { setMode("proposed"); } }, "Proposed"),
        h(Button, { variant: mode === "diff" ? "default" : "outline", size: "sm", onClick: function () { setMode("diff"); } }, "Diff vs current")
      ),
      specs.map(function (s) {
        return h("div", { key: s.path, className: "os-spec-block" },
          h("div", { className: "os-specs-detail-head" },
            h("span", { className: "os-specs-detail-path" }, s.path),
            s.status && s.status !== "unchanged" && s.status !== "missing"
              ? h(Badge, { className: "os-spec-status os-status-" + s.status }, s.status)
              : null
          ),
          mode === "diff" && s.diff
            ? h("div", { className: "os-spec-diff" },
                h(SpecDeltaView, { semanticDiff: s.semantic_diff, lineDiff: s.diff, specPath: s.path })
              )
            : h(SpecContentView, { md: s.content })
        );
      })
    );
  }

  function ChangeDetailTabs(_ref9) {
    var detail = _ref9.detail, anchor = _ref9.anchor, onTabChange = _ref9.onTabChange, source = _ref9.source, onSelectExploration = _ref9.onSelectExploration;
    var tabs = [];
    if (detail.proposal) tabs.push(["proposal", "Proposal"]);
    if (detail.tasks) tabs.push(["tasks", "Tasks"]);
    if (detail.design) tabs.push(["design", "Design"]);
    if (detail.specs && detail.specs.length) tabs.push(["specs", "Specs (" + detail.specs.length + ")"]);
    if (nonEmpty(detail.reviews)) tabs.push(["reviews", "Reviews (" + detail.reviews.length + ")"]);
    if (nonEmpty(detail.explorations)) tabs.push(["explorations", "Explorations (" + detail.explorations.length + ")"]);
    if (!tabs.length) return h("p", { className: "os-empty" }, "No documents found.");
    var validAnchor = anchor && tabs.some(function (t) { return t[0] === anchor; });
    var initialTab = validAnchor ? anchor : tabs[0][0];
    var _tab = useState(initialTab);
    var activeTab = _tab[0], setActiveTab = _tab[1];
    // Sync from hash when anchor changes (browser back/forward).
    useEffect(function () {
      if (validAnchor && anchor !== activeTab) setActiveTab(anchor);
    }, [anchor]);
    function switchTab(t) {
      setActiveTab(t);
      if (onTabChange) onTabChange(t);
    }
    var content = activeTab === "specs"
      ? h(ChangeSpecsView, { specs: detail.specs })
      : activeTab === "reviews"
        ? h(ReviewsTab, { reviews: detail.reviews })
        : activeTab === "explorations"
          ? h(ChangeExplorationsPanel, { explorations: detail.explorations, source: source })
      : activeTab === "tasks"
        ? h(TasksView, { md: detail[activeTab], stats: detail.taskStats })
        : h(Markdown, { md: detail[activeTab] });
    return h("div", { className: "os-tabs" },
      h(CrewCards, { cards: detail.crewCards }),
      h("div", { className: "os-tabs-bar" }, tabs.map(function (t) {
        return h("button", {
          key: t[0], className: cn("os-tab-btn", activeTab === t[0] && "os-tab-btn-active"),
          onClick: function () { switchTab(t[0]); }
        }, t[1]);
      })),
      h("div", { className: "os-tab-panel" }, content)
    );
  }

  // ── Tasks view (structured checklist) ───────────────────────────────
  function TasksView(_ref) {
    var md = _ref.md, stats = _ref.stats;
    var parsed = useMemo(function () { return parseTasks(md); }, [md]);
    var total = stats ? stats.total : parsed.total;
    var done = stats ? stats.done : parsed.done;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return h("div", { className: "os-tasks" },
      total > 0 ? h("div", { className: "os-tasks-progress" },
        h("div", { className: "os-tasks-bar" },
          h("div", { className: "os-tasks-bar-fill", style: { width: pct + "%" } })
        ),
        h("span", { className: "os-tasks-count" }, done + " / " + total + " done (" + pct + "%)")
      ) : null,
      parsed.sections.map(function (sec, si) {
        return h("div", { key: si, className: "os-tasks-section" },
          sec.title ? h("h4", { className: "os-tasks-section-title" }, sec.title) : null,
          sec.tasks.map(function (t, ti) {
            return h("div", { key: ti, className: cn("os-task-item", t.checked && "os-task-done") },
              h("span", { className: "os-task-check" }, t.checked ? "\u2713" : "\u25CB"),
              h("span", { className: "os-task-text" }, t.text)
            );
          })
        );
      })
    );
  }

  // ── Spec content parser + structured view ───────────────────────────
  function parseSpec(md) {
    if (!md) return { title: "", purpose: "", requirements: [] };
    var lines = md.split("\n");
    var title = "", purpose = "";
    var reqs = [];
    var state = "top"; // top | purpose | reqDesc | scenario
    var currentReq = null, currentScn = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trim = line.trim();

      if (trim.startsWith("# ") && !trim.startsWith("## ")) {
        title = trim.replace(/^#\s+/, "").replace(/\s+Specification\s*$/i, "");
        state = "top"; continue;
      }
      if (/^##\s+Purpose/i.test(trim)) { state = "purpose"; continue; }
      if (/^##\s+Requirements/i.test(trim)) { state = "top"; continue; }
      if (/^###\s+Requirement:\s*(.+)$/i.test(trim)) {
        var m = trim.match(/^###\s+Requirement:\s*(.+)$/i);
        currentReq = { name: m[1].trim(), description: "", scenarios: [] };
        reqs.push(currentReq);
        currentScn = null;
        state = "reqDesc"; continue;
      }
      if (/^####\s+Scenario:\s*(.+)$/i.test(trim)) {
        var m2 = trim.match(/^####\s+Scenario:\s*(.+)$/i);
        currentScn = { name: m2[1].trim(), steps: [] };
        if (currentReq) currentReq.scenarios.push(currentScn);
        state = "scenario"; continue;
      }

      // Accumulate text based on state
      if (state === "purpose" && trim) {
        purpose += (purpose ? "\n" : "") + trim;
      } else if (state === "reqDesc" && trim) {
        if (currentReq) currentReq.description += (currentReq.description ? "\n" : "") + trim;
      } else if (state === "scenario" && trim) {
        var step = trim.match(/^[-*]\s+\*\*(\w+)\*\*\s*(.+)$/);
        if (step && currentScn) {
          currentScn.steps.push({ type: step[1].toUpperCase(), text: step[2].trim() });
        } else if (currentScn) {
          // Non-bullet text inside scenario — append to last step or skip
          if (currentScn.steps.length) {
            currentScn.steps[currentScn.steps.length - 1].text += " " + trim;
          }
        }
      }
    }
    return { title: title, purpose: purpose, requirements: reqs };
  }


  // Shared by SpecsView and the change dialog Specs tab: Purpose callout, R1..Rn requirement cards, WHEN/THEN/AND steps.
  function StructuredSpecView(_ref) {
    var md = _ref.md;
    var _m = useState(_ref.defaultMode || "structured"), _f = useState(_ref.defaultFilter || "");
    var mode = _m[0], setMode = _m[1], filter = _f[0], setFilter = _f[1];
    var spec = useMemo(function () { return parseSpec(md); }, [md]);
    if (!spec.requirements.length) return h(Markdown, { md: md });
    var visible = filterSpecRequirements(spec.requirements, filter);
    var toggle = h("div", { className: "os-spec-modes" },
      h(Button, { variant: mode === "structured" ? "default" : "outline", size: "sm", className: "os-spec-mode", onClick: function () { setMode("structured"); } }, "Structured"),
      h(Button, { variant: mode === "raw" ? "default" : "outline", size: "sm", className: "os-spec-mode", onClick: function () { setMode("raw"); } }, "Raw"),
      mode === "structured" ? h(Input, { placeholder: "Filter requirements\u2026", value: filter, onChange: function (e) { setFilter(e.target.value); }, className: "os-filter-input" }) : null
    );
    if (mode === "raw") return h("div", { className: "os-spec-structured" }, toggle, h(Markdown, { md: md }));
    return h("div", { className: "os-spec-content os-spec-structured" },
      toggle,
      spec.purpose ? h("div", { className: "os-spec-purpose" },
        h("div", { className: "os-spec-purpose-label" }, "Purpose"),
        h("p", null, spec.purpose)
      ) : null,
      !visible.length ? h("p", { className: "os-empty" }, "No requirements match the filter.") : null,
      visible.map(function (entry) {
        var req = entry.req;
        return h("div", { key: entry.index, className: "os-spec-req" },
          h("div", { className: "os-spec-req-head" },
            h("span", { className: "os-spec-req-num" }, "R" + (entry.index + 1)),
            h("span", { className: "os-spec-req-name" }, req.name)
          ),
          req.description ? h("p", { className: "os-spec-req-desc" }, renderSpecKeywords(req.description)) : null,
          req.scenarios.map(function (scn, si) {
            return h("div", { key: si, className: "os-spec-scn" },
              h("div", { className: "os-spec-scn-name" }, scn.name),
              scn.steps.map(function (st, sti) {
                return h("div", { key: sti, className: cn("os-spec-step", "os-spec-step-" + st.type.toLowerCase()) },
                  h("span", { className: "os-spec-step-label" }, st.type),
                  h("span", { className: "os-spec-step-text" }, renderSpecKeywords(st.text))
                );
              })
            );
          })
        );
      })
    );
  }

  function SpecCard(_ref) {
    var file = _ref.file, active = _ref.active, onSelect = _ref.onSelect;
    var purposeLine = String(file.purpose || "").split("\n")[0];
    var counts = specCountsLabel(file);
    var showTitle = file.title && file.title !== file.path;
    return h("button", {
      className: cn("os-spec-item", "os-spec-card", active && "os-spec-item-active", file.changed && "os-spec-item-changed"),
      onClick: onSelect
    },
      h("div", { className: "os-spec-card-head" },
        h(Icon, { d: ICO.file, size: 13 }),
        h("span", { className: "os-spec-card-title" }, showTitle ? file.title : file.path),
        specStatusBadgeVisible(file.status) ? h(Badge, { className: "os-spec-status os-status-" + file.status }, file.status) : null
      ),
      showTitle ? h("div", { className: "os-spec-item-path" }, file.path) : null,
      purposeLine ? h("div", { className: "os-spec-card-purpose" }, purposeLine) : null,
      counts ? h("div", { className: "os-spec-card-counts" }, counts) : null
    );
  }

  function SpecContentView(_ref) {
    return h(StructuredSpecView, { md: _ref.md });
  }

  // ── Semantic spec delta view (requirement-level diff) ──────────────
  function SpecDeltaView(_ref2) {
    var semanticDiff = _ref2.semanticDiff, lineDiff = _ref2.lineDiff, specPath = _ref2.specPath;
    var _rs = useState(true);
    var rawCollapsed = _rs[0], setRawCollapsed = _rs[1];

    if (!semanticDiff || !semanticDiff.requirements) {
      // No semantic diff available — fall back to SpecContentView
      return h("p", { className: "os-empty" }, "No semantic diff available.");
    }

    var reqs = semanticDiff.requirements;
    var added = reqs.added || [], modified = reqs.modified || [], removed = reqs.removed || [], unchanged = reqs.unchanged || [];
    var summaryParts = [];
    if (added.length) summaryParts.push("+" + added.length + " added");
    if (modified.length) summaryParts.push("~" + modified.length + " modified");
    if (removed.length) summaryParts.push("-" + removed.length + " removed");

    function renderScenario(scn, key, suffix) {
      return h("div", { key: key, className: "os-spec-scn" + (suffix ? " os-spec-scn-" + suffix : "") },
        h("div", { className: "os-spec-scn-name" }, scn.name),
        scn.steps ? scn.steps.map(function (st, sti) {
          return h("div", { key: sti, className: cn("os-spec-step", "os-spec-step-" + st.type.toLowerCase()) },
            h("span", { className: "os-spec-step-label" }, st.type),
            h("span", { className: "os-spec-step-text" }, st.text)
          );
        }) : null
      );
    }

    function renderRequirement(req, key, badge) {
      return h("div", { key: key, className: "os-spec-req os-spec-req-delta" },
        h("div", { className: "os-spec-req-head" },
          badge ? h(Badge, { className: "os-spec-status os-status-" + badge }, badge) : null,
          h("span", { className: "os-spec-req-name" }, req.name)
        ),
        req.description ? h("p", { className: "os-spec-req-desc" }, req.description) : null,
        req.scenarios ? req.scenarios.map(function (scn, si) {
          return renderScenario(scn, si, badge);
        }) : null
      );
    }

    return h("div", { className: "os-spec-delta" },
      // Summary
      h("div", { className: "os-delta-summary" },
        summaryParts.length
          ? h("span", { className: "os-delta-summary-text" }, summaryParts.join(", "))
          : h("span", { className: "os-delta-summary-text os-delta-unchanged" }, "No changes")
      ),

      // Added requirements
      added.length ? h("div", { className: "os-delta-section" },
        h("div", { className: "os-delta-section-head" }, "Added"),
        added.map(function (req, i) { return renderRequirement(req, "a" + i, "added"); })
      ) : null,

      // Modified requirements
      modified.length ? h("div", { className: "os-delta-section" },
        h("div", { className: "os-delta-section-head" }, "Modified"),
        modified.map(function (mod, i) {
          return h("div", { key: "m" + i, className: "os-spec-req os-spec-req-delta" },
            h("div", { className: "os-spec-req-head" },
              h(Badge, { className: "os-spec-status os-status-modified" }, "modified"),
              h("span", { className: "os-spec-req-name" }, mod.name)
            ),
            // Description change
            mod.before.description !== mod.after.description ? h("div", { className: "os-delta-desc-change" },
              h("div", { className: "os-delta-before" }, h("span", { className: "os-delta-label" }, "Before:"), " ", mod.before.description),
              h("div", { className: "os-delta-after" }, h("span", { className: "os-delta-label" }, "After:"), " ", mod.after.description)
            ) : null,
            // Scenario-level deltas
            (mod.scenarios_added && mod.scenarios_added.length) || (mod.scenarios_modified && mod.scenarios_modified.length) || (mod.scenarios_removed && mod.scenarios_removed.length)
              ? h("div", { className: "os-delta-scenarios" },
                  (mod.scenarios_added || []).map(function (scn, si) { return renderScenario(scn, "sa" + si, "added"); }),
                  (mod.scenarios_modified || []).map(function (sm, si) {
                    return h("div", { key: "sm" + si, className: "os-spec-scn os-spec-scn-modified" },
                      h("div", { className: "os-spec-scn-name" }, sm.name, h(Badge, { className: "os-spec-status os-status-modified", style: { marginLeft: "0.5rem" } }, "modified")),
                      h("div", { className: "os-delta-scenario-change" },
                        sm.before.steps ? h("div", { className: "os-delta-before" }, sm.before.steps.map(function (st, sti) {
                          return h("div", { key: sti, className: "os-spec-step os-spec-step-" + st.type.toLowerCase() }, h("span", { className: "os-spec-step-label" }, st.type), h("span", { className: "os-spec-step-text" }, st.text));
                        })) : null,
                        sm.after.steps ? h("div", { className: "os-delta-after" }, sm.after.steps.map(function (st, sti) {
                          return h("div", { key: sti, className: "os-spec-step os-spec-step-" + st.type.toLowerCase() }, h("span", { className: "os-spec-step-label" }, st.type), h("span", { className: "os-spec-step-text" }, st.text));
                        })) : null
                      )
                    );
                  }),
                  (mod.scenarios_removed || []).map(function (scn, si) { return renderScenario(scn, "sr" + si, "removed"); })
                ) : null
          );
        })
      ) : null,

      // Removed requirements
      removed.length ? h("div", { className: "os-delta-section" },
        h("div", { className: "os-delta-section-head" }, "Removed"),
        removed.map(function (req, i) { return renderRequirement(req, "r" + i, "removed"); })
      ) : null,

      // Unchanged requirements (collapsed)
      unchanged.length ? h("details", { className: "os-delta-unchanged-section" },
        h("summary", null, unchanged.length + " unchanged requirement" + (unchanged.length === 1 ? "" : "s")),
        h("div", { className: "os-delta-unchanged-list" },
          unchanged.map(function (name, i) { return h("div", { key: i, className: "os-delta-unchanged-req" }, name); })
        )
      ) : null,

      // Raw diff (collapsible)
      lineDiff ? h("details", { className: "os-delta-raw-section", open: !rawCollapsed ? true : false },
        h("summary", { onClick: function (e) { e.preventDefault(); setRawCollapsed(!rawCollapsed); } }, "Raw diff"),
        rawCollapsed ? null : h("pre", { className: "os-diff-unified" }, lineDiff)
      ) : null
    );
  }

  // ── Specs view (spec browser: current / dirty / refs) ────────────────
  var SORT_MODES = [
    { value: "alpha", label: "A→Z" },
    { value: "alpha-desc", label: "Z→A" },
    { value: "edited", label: "Latest edited" },
    { value: "edited-desc", label: "Oldest edited" },
  ];
  function sortFiles(files, sortMode) {
    if (!files || !files.length) return files;
    var arr = files.slice();
    if (sortMode === "alpha-desc") {
      arr.sort(function (a, b) { return b.path.localeCompare(a.path); });
    } else if (sortMode === "edited") {
      arr.sort(function (a, b) {
        var ta = a.mtime ? Date.parse(a.mtime) : 0;
        var tb = b.mtime ? Date.parse(b.mtime) : 0;
        return tb - ta;
      });
    } else if (sortMode === "edited-desc") {
      arr.sort(function (a, b) {
        var ta = a.mtime ? Date.parse(a.mtime) : 0;
        var tb = b.mtime ? Date.parse(b.mtime) : 0;
        return ta - tb;
      });
    } else {
      arr.sort(function (a, b) { return a.path.localeCompare(b.path); });
    }
    return arr;
  }
  function SpecsView(_ref10) {
    var source = _ref10.source, anchorToken = _ref10.anchorToken, onSelectToken = _ref10.onSelectToken;
    var _m = useState("current"), _b2 = useState(null), _l2 = useState(true), _e3 = useState("");
    var _sel = useState(null), _bf = useState(""), _af = useState("");
    var _sm = useState("alpha");
    var _sdm = useState("semantic");
    var _sw = useState(function () { return readPref("specsSidebarWidth", SPECS_SIDEBAR_MIN, SPECS_SIDEBAR_MAX, SPECS_SIDEBAR_DEFAULT); });
    var sideW = _sw[0], setSideW = _sw[1];
    var mode = _m[0], setMode = _m[1], browser = _b2[0], setBrowser = _b2[1];
    var loading = _l2[0], setLoading = _l2[1], err = _e3[0], setErr = _e3[1];
    var selPath = _sel[0], setSelPath = _sel[1], before = _bf[0], setBefore = _bf[1], after = _af[0], setAfter = _af[1];
    var sortMode = _sm[0], setSortMode = _sm[1];
    var _sf = useState("");
    var specFilter = _sf[0], setSpecFilter = _sf[1];
    var selDiffModes = _sdm;
    var firstLoad = useRef(true);

    function load(currentMode, b, a) {
      setLoading(true); setErr("");
      var params = {};
      if (currentMode === "dirty") params.dirty = true;
      else if (currentMode === "refs") { params.before = b; params.after = a; }
      getSpecBrowser(source.id, params).then(function (d) {
        setBrowser(d);
        // Pick initial selection: anchor token match, else first file.
        var pick = null;
        if (anchorToken && d.files) {
          pick = d.files.find(function (f) { return f.token === anchorToken; });
        }
        if (!pick && d.files && d.files.length) pick = d.files[0];
        setSelPath(pick ? pick.path : null);
        setLoading(false);
      }).catch(function (e) { setErr(apiErr(e)); setLoading(false); });
    }
    useEffect(function () {
      if (firstLoad.current) { firstLoad.current = false; load(mode, before, after); }
    }, []);
    // Sync selection when anchor token changes (browser back/forward + hash edits).
    useEffect(function () {
      if (!anchorToken || !browser || !browser.files) return;
      var match = browser.files.find(function (f) { return f.token === anchorToken; });
      if (match && match.path !== selPath) setSelPath(match.path);
    }, [anchorToken, browser]);
    function switchMode(m) {
      setMode(m);
      if (m === "refs" && (!before.trim() || !after.trim())) { setBrowser(null); setLoading(false); return; }
      load(m, before, after);
    }
    function reload() { load(mode, before, after); }
    var selFile = browser && browser.files ? browser.files.find(function (f) { return f.path === selPath; }) : null;
    return h("div", { className: "os-specs" },
      h("div", { className: "os-specs-toolbar" },
        h("span", { className: "os-specs-title" }, "Specs"),
        browser && browser.branch ? h(Badge, { variant: "outline" }, h(Icon, { d: ICO.branch, size: 11 }), " ", browser.branch) : null,
        h("div", { className: "os-specs-modes" },
          h(Button, { variant: mode === "current" ? "default" : "outline", size: "sm", onClick: function () { switchMode("current"); } }, "Current"),
          h(Button, { variant: mode === "dirty" ? "default" : "outline", size: "sm", onClick: function () { switchMode("dirty"); } }, "Dirty (HEAD→worktree)"),
          h(Button, { variant: mode === "refs" ? "default" : "outline", size: "sm", onClick: function () { switchMode("refs"); } }, "Compare refs")
        ),
        mode === "refs" ? h("div", { className: "os-refs-inputs" },
          h(Input, { placeholder: "before (HEAD~1)", value: before, onChange: function (e) { setBefore(e.target.value); }, className: "os-ref-input" }),
          h(Input, { placeholder: "after (origin/main)", value: after, onChange: function (e) { setAfter(e.target.value); }, className: "os-ref-input" }),
          h(Button, { size: "sm", onClick: reload, disabled: !before.trim() || !after.trim() }, "Load")
        ) : null,
        h("button", { className: "os-icon-btn", onClick: reload, title: "Refresh" }, h(Icon, { d: ICO.refresh })),
        h(Select, { value: sortMode, onValueChange: setSortMode, "aria-label": "Sort specs" },
          SORT_MODES.map(function (s) { return h(SelectOption, { key: s.value, value: s.value }, s.label); })
        )
      ),
      browser && browser.changedCount > 0 ? h("div", { className: "os-specs-changed" }, browser.changedCount + " changed spec" + (browser.changedCount === 1 ? "" : "s")) : null,
      loading ? h("p", { className: "os-empty" }, "Loading…") :
        err ? h("p", { className: "os-err" }, err) :
          browser && browser.files && browser.files.length ? (function () {
            var sorted = filterSpecFiles(sortFiles(browser.files, sortMode), specFilter);
            return h("div", { className: "os-specs-grid", style: { gridTemplateColumns: sideW + "px 6px 1fr" } },
              h("div", { className: "os-specs-list" },
                h(Input, { placeholder: "Filter specs\u2026", value: specFilter, onChange: function (e) { setSpecFilter(e.target.value); }, className: "os-filter-input os-specs-filter" }),
                !sorted.length ? h("p", { className: "os-empty" }, "No specs match the filter.") : null,
                sorted.map(function (f) {
                  return h(SpecCard, {
                    key: f.path, file: f, active: f.path === selPath,
                    onSelect: function () { setSelPath(f.path); if (onSelectToken && f.token) onSelectToken(f.token); }
                  });
                })
              ),
              h("div", {
                role: "separator", "aria-orientation": "vertical", className: "os-specs-sash",
                title: "Drag to resize (double-click to reset)",
                onDoubleClick: function () { setSideW(SPECS_SIDEBAR_DEFAULT); writePref("specsSidebarWidth", SPECS_SIDEBAR_DEFAULT); },
                onPointerDown: function (e) {
                  e.preventDefault();
                  var sx = e.clientX;
                  function move(ev) { setSideW(clampVal(sideW + (ev.clientX - sx), SPECS_SIDEBAR_MIN, SPECS_SIDEBAR_MAX, SPECS_SIDEBAR_DEFAULT)); }
                  function up(ev) {
                    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
                    writePref("specsSidebarWidth", clampVal(sideW + (ev.clientX - sx), SPECS_SIDEBAR_MIN, SPECS_SIDEBAR_MAX, SPECS_SIDEBAR_DEFAULT));
                  }
                  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
                }
              }),
              selFile ? h("div", { className: "os-specs-detail" },
                h("div", { className: "os-specs-detail-head" },
                  h("span", { className: "os-specs-detail-path" }, selFile.path),
                  selFile.token ? h(CopyChip, { text: source.name + "/" + selFile.token }) : null
                ),
                (selFile.ctime || selFile.mtime) ? h("div", { className: "os-specs-meta" },
                  selFile.ctime ? h("span", { title: selFile.ctime }, "created ", isoTimeAgo(selFile.ctime)) : null,
                  selFile.mtime ? h("span", { title: selFile.mtime }, "edited ", isoTimeAgo(selFile.mtime)) : null
                ) : null,
                mode === "current" ? h(SpecContentView, { md: selFile.after }) :
                  (function () {
                    var diffModes = ["semantic", "split", "raw"];
                    var diffLabels = { semantic: "Semantic", split: "Side-by-side", raw: "Raw" };
                    // viewMode state is hoisted to SpecsView via a ref-like closure
                    var selDiffMode = selDiffModes[0];
                    function setDiffMode(m) { selDiffModes[1](m); }
                    return h("div", { className: "os-spec-diff" },
                      h("div", { className: "os-specs-diff-modes" },
                        diffModes.map(function (dm) {
                          return h(Button, { key: dm, variant: selDiffMode === dm ? "default" : "outline", size: "sm", onClick: function () { setDiffMode(dm); } }, diffLabels[dm]);
                        })
                      ),
                      selDiffMode === "semantic" && selFile.semantic_diff
                        ? h(SpecDeltaView, { semanticDiff: selFile.semantic_diff, lineDiff: selFile.diff, specPath: selFile.path })
                        : selDiffMode === "split"
                          ? h("div", { className: "os-diff-cols" },
                              h("div", { className: "os-diff-col" }, h("div", { className: "os-diff-col-head" }, "before"), h(SpecContentView, { md: selFile.before })),
                              h("div", { className: "os-diff-col" }, h("div", { className: "os-diff-col-head" }, "after"), h(SpecContentView, { md: selFile.after }))
                            )
                          : selFile.diff ? h("pre", { className: "os-diff-unified" }, selFile.diff) : null
                    );
                  })()
              ) : h("p", { className: "os-empty" }, "Select a spec.")
            );
          })() : h("p", { className: "os-empty" }, mode === "dirty" ? "No changes between HEAD and worktree." : mode === "refs" ? "No differences between refs." : "No specs found.")
    );
  }

  // ── Error boundary (class-based, catches render crashes) ─────────────
  var ErrorBoundary = (function (_super) {
    function EB(props) {
      _super.call(this, props);
      this.state = { hasError: false, error: null };
    }
    EB.prototype = Object.create(_super.prototype);
    EB.prototype.constructor = EB;
    EB.getDerivedStateFromError = function (error) {
      return { hasError: true, error: error };
    };
    EB.prototype.componentDidCatch = function (error) {
      console.error("[openspec] render error:", error);
    };
    EB.prototype.render = function () {
      if (this.state.hasError) {
        return h("div", { className: "os-err" },
          "Something went wrong rendering this view: " + (this.state.error && this.state.error.message || String(this.state.error)),
          h("button", { className: "os-icon-btn", style: { marginLeft: "0.5rem" }, onClick: function () { this.setState({ hasError: false, error: null }); }.bind(this) }, "Retry")
        );
      }
      return this.props.children;
    };
    return EB;
  })(React.Component);

  // ── Hash deep-linking ────────────────────────────────────────────────
  // Format: #project/token#anchor
  //   - project/token is the route (which source + which change/spec)
  //   - anchor is the sub-view (proposal/tasks/design/specs tab)
  // The second # is a literal char in the hash string; we split on it.
  function parseHash() {
    var raw = window.location.hash.replace(/^#/, "").trim();
    if (!raw) return { project: null, token: null, anchor: null };
    var route, anchor;
    var hi = raw.indexOf("#");
    if (hi >= 0) { route = raw.slice(0, hi); anchor = raw.slice(hi + 1); }
    else { route = raw; anchor = null; }
    var parts = route.split("/");
    return {
      project: decodeURIComponent(parts[0]) || null,
      token: parts[1] ? decodeURIComponent(parts[1]) : null,
      anchor: anchor || null,
    };
  }
  function setHash(project, token, anchor) {
    var v = project ? (token ? project + "/" + token : project) : "";
    if (anchor) v += "#" + anchor;
    if ((window.location.hash || "#") !== "#" + v) window.location.hash = v;
  }

  // ── Main page component ──────────────────────────────────────────────
  function OpenSpecPage() {
    var _s2 = useState([]), _a2 = useState(null), _l3 = useState(true), _e4 = useState("");
    var sources = _s2[0], setSources = _s2[1], activeId = _a2[0], setActiveId = _a2[1];
    var loading = _l3[0], setLoading = _l3[1], err = _e4[0], setErr = _e4[1];
    var _dlg = useState(null), _anchor = useState({ project: null, token: null });
    var dlg = _dlg[0], setDlg = _dlg[1], anchor = _anchor[0], setAnchor = _anchor[1];
    var _view = useState("board"), _selItem = useState(null), _selEx = useState(null), _disc = useState(false);
    var view = _view[0], setView = _view[1], selItem = _selItem[0], setSelItem = _selItem[1];
    var selExploration = _selEx[0], setSelExploration = _selEx[1], discoverOpen = _disc[0], setDiscoverOpen = _disc[1];

    function loadSources(silentAfter) {
      if (!silentAfter) setLoading(true);
      setErr("");
      getSources().then(function (res) {
        setSources(res.sources || []);
        setLoading(false);
      }).catch(function (e) { setErr(apiErr(e)); setLoading(false); });
    }
    useEffect(function () {
      loadSources();
      if (typeof setInterval !== "function") return;
      var t = setInterval(function () { loadSources(true); }, POLL_INTERVAL_MS);
      return function () { if (typeof clearInterval === "function") clearInterval(t); };
    }, []);

    // Apply hash anchor on load + when sources change. Auto-select the
    // first source when no hash project is present so the user doesn't
    // have to manually pick from the dropdown to see anything.
    useEffect(function () {
      if (!sources.length) return;
      var ha = parseHash();
      setAnchor(ha);
      if (ha.project) {
        var proj = ha.project.toLowerCase();
        var match = sources.find(function (s) {
          return (s.name || "").toLowerCase() === proj || (s.id || "").toLowerCase() === proj;
        });
        if (match && match.id !== activeId) setActiveId(match.id);
        return;
      }
      if (!activeId) setActiveId(sources[0].id);
    }, [sources]);

    // When anchor has a token, switch view / open detail.
    useEffect(function () {
      if (!anchor.token || !activeId || !sources.length) return;
      var src = sources.find(function (s) { return s.id === activeId; });
      if (!src || !src.openspec) return;
      // Check changes + ideas
      var item = (src.openspec.changes || []).find(function (c) { return c.token === anchor.token; })
        || (src.openspec.ideas || []).find(function (c) { return c.token === anchor.token; });
      if (item) { setView("board"); setSelItem(item); return; }
      // Check specs
      var spec = (src.openspec.specs || []).find(function (s) { return s.token === anchor.token; });
      if (spec) { setView("specs"); }
    }, [anchor, activeId, sources]);

    var active = sources.find(function (s) { return s.id === activeId; });

    function selectSource(id) { setActiveId(id); var s = sources.find(function (x) { return x.id === id; }); setHash(s ? s.name : null, null); setView("board"); setSelItem(null); }
    function selectItem(item) { setSelItem(item); if (active && item.token) setHash(active.name, item.token, null); }
    function closeItem() { setSelItem(null); if (active) setHash(active.name, null); }
    function onTabChange(tab) { if (active && selItem && selItem.token) setHash(active.name, selItem.token, tab); }
    function selectSpec(token) { if (active) setHash(active.name, token, null); }
    // Back from an exploration dialog to its owning change dialog, landing on the Explorations tab.
    function backToChange(slug) {
      var changes = (active && active.openspec && active.openspec.changes) || [];
      var found = changes.find(function (c) { return c.name === slug || c.token === slug; });
      setSelExploration(null);
      if (found) { setView("board"); setSelItem(found); setHash(active.name, found.token, "explorations"); }
    }

    function onAdd() { setDlg({ mode: "add" }); }
    function onEdit() { if (active) setDlg({ mode: "edit", activeId: active.id, path: active.path, name: active.name }); }
    function onRemove() {
      if (!active) return;
      if (!window.confirm("Remove source '" + active.name + "'?")) return;
      removeSource(active.id).then(function () {
        setSources(sources.filter(function (s) { return s.id !== active.id; }));
        setActiveId(null); setHash(null, null);
      }).catch(function (e) { setErr(apiErr(e)); });
    }
    function onSaved(res) {
      setDlg(null);
      getSources().then(function (r) {
        setSources(r.sources || []);
        if (res && res.source) setActiveId(res.source.id);
      }).catch(function (e) { setErr(apiErr(e)); });
    }

    // Hash change listener (browser back/forward + manual URL edits).
    useEffect(function () {
      function onHash() {
        var ha = parseHash();
        setAnchor(ha);
        if (ha.project && sources.length) {
          var proj = ha.project.toLowerCase();
          var match = sources.find(function (s) {
            return (s.name || "").toLowerCase() === proj || (s.id || "").toLowerCase() === proj;
          });
          if (match) setActiveId(match.id);
        }
      }
      window.addEventListener("hashchange", onHash);
      return function () { window.removeEventListener("hashchange", onHash); };
    }, [sources]);

    if (loading) return h("div", { className: "os-page os-loading" }, "Loading…");
    return h(ErrorBoundary, null,
      h("div", { className: "os-page" },
      h(Toolbar, {
        sources: sources, activeId: activeId, onSelect: selectSource,
        onRefresh: function () { loadSources(true); }, onAdd: onAdd, onEdit: onEdit, onRemove: onRemove, onDiscover: function () { setDiscoverOpen(true); },
      }),
      err ? h("p", { className: "os-err" }, err) : null,
      sources.length === 0 ? h("div", { className: "os-empty-state" },
        h("p", null, "No OpenSpec sources registered."),
        h(Button, { onClick: onAdd }, h(Icon, { d: ICO.plus, size: 14 }), " Add your first source")
      ) : null,
      active && active.valid ? h("div", { className: "os-view-switch" },
        h(Button, { variant: view === "board" ? "default" : "outline", size: "sm", onClick: function () { setView("board"); } }, "Changes"),
        h(Button, { variant: view === "explorations" ? "default" : "outline", size: "sm", onClick: function () { setView("explorations"); } },
          "Explorations" + (active.openspec && active.openspec.counts && active.openspec.counts.explorations != null ? " (" + active.openspec.counts.explorations + ")" : "")),
        h(Button, { variant: view === "specs" ? "default" : "outline", size: "sm", onClick: function () { setView("specs"); } }, "Specs")
      ) : null,
      active && !active.valid ? h("div", { className: "os-invalid-state" },
        h("p", { className: "os-err" }, active.error || "Source path is invalid."),
        active.error && active.error.toLowerCase().indexOf("openspec") >= 0 ? h(Button, {
          size: "sm", onClick: function () {
            initSource(active.id).then(function () { loadSources(true); }).catch(function (e) { setErr(apiErr(e)); });
          }
        }, h(Icon, { d: ICO.plus, size: 14 }), " Initialize OpenSpec") : null
      ) : null,
      active && active.valid && view === "board" ? h(Board, { source: active, onSelectItem: selectItem }) : null,
      active && active.valid && view === "explorations" ? h(ExplorationsPanel, { source: active, onSelect: setSelExploration }) : null,
      active && active.valid && view === "specs" ? h(SpecsView, { source: active, anchorToken: anchor.token, onSelectToken: selectSpec }) : null,
      selItem && active ? h(DetailDialog, { source: active, item: selItem, onClose: closeItem, anchor: anchor.anchor, onTabChange: onTabChange, onSelectExploration: setSelExploration }) : null,
      selExploration && active ? h(ExplorationDialog, { source: active, item: selExploration, onClose: function () { setSelExploration(null); }, onBackToChange: backToChange }) : null,
      discoverOpen && active ? h(DiscoverDialog, { source: active, onClose: function () { setDiscoverOpen(false); }, onDone: function () { loadSources(true); } }) : null,
      dlg ? h(SourceDialog, {
        mode: dlg.mode, initialPath: dlg.path, initialName: dlg.name, activeId: dlg.activeId,
        onClose: function () { setDlg(null); }, onSaved: onSaved,
      }) : null
      )
    );
  }

  // ── Register ─────────────────────────────────────────────────────────
  if (window.__HERMES_PLUGINS__ && window.__HERMES_PLUGINS__.register) {
    window.__HERMES_PLUGINS__.register("openspec", OpenSpecPage);
  }
})();
