/**
 * OpenSpec Desktop runtime plugin — source registry + project surface.
 *
 * Registers /openspec route + sidebar nav entry. Provides source selector,
 * work board (ideas, changes by status), change/idea detail dialogs,
 * current specs browser, worktree diff views, and source management
 * (add/edit/remove) via the existing backend CRUD routes.
 *
 * Packaging: single uncompiled ESM file. Runtime loader scans
 * ~/.hermes/plugins/openspec/desktop/plugin.js.
 */

import {
  Badge, Button, cn, Codicon, CopyButton, Dialog, DialogContent, EmptyState, ErrorState, host,
  Input, Loader, ROUTES_AREA, SearchField, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue,
  SegmentedControl, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, Tabs, TabsList, TabsTrigger, useQuery
} from '@hermes/plugin-sdk'
import React from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

var SOURCE_TRIGGER_HOVER_CSS = '[data-openspec-source-trigger].desktop-input-chrome { background-color: var(--chrome-action-hover) !important; } [data-openspec-source-trigger].desktop-input-chrome:hover { background-color: var(--chrome-action-hover) !important; }'

// Crew-style conic-gradient radar sweep on cards with running (green) or review (amber) Crew tickets.
var RADAR_CSS = ' @property --os-arc { syntax: "<angle>"; inherits: false; initial-value: 0deg; }' +
  ' @keyframes os-radar-spin { to { --os-arc: 360deg; } }' +
  ' .os-card-live, .os-card-review { position: relative; }' +
  ' .os-card-live::after, .os-card-review::after { content: ""; position: absolute; inset: -1px; border-radius: inherit; padding: 1px; pointer-events: none;' +
  ' background: conic-gradient(from var(--os-arc), transparent 0 68%, var(--os-radar-color) 88%, transparent 100%);' +
  ' -webkit-mask: linear-gradient(rgb(0 0 0 / 0.78) 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(rgb(0 0 0 / 0.78) 0 0) content-box exclude, linear-gradient(#000 0 0); }' +
  ' .os-card-live::after { --os-radar-color: var(--ui-success, #34d399); animation: os-radar-spin 2.2s linear infinite; }' +
  ' .os-card-review::after { --os-radar-color: #f59e0b; animation: os-radar-spin 6s linear infinite; }' +
  ' @media (prefers-reduced-motion: reduce) { .os-card-live::after, .os-card-review::after { animation: none; } }'

var OPENSPEC_PAGE_CSS = SOURCE_TRIGGER_HOVER_CSS + RADAR_CSS

// Theme-native surfaces: only Hermes Desktop semantic tokens and color-mix(currentColor), no hardcoded dark fallbacks.
var BORDER_SUBTLE = '1px solid var(--ui-stroke-tertiary, color-mix(in srgb, currentColor 14%, transparent))'
var SURFACE_CODE = 'color-mix(in srgb, currentColor 6%, var(--ui-bg-elevated, transparent))'
var SURFACE_INLINE_CODE = 'var(--ui-inline-code-background, color-mix(in srgb, currentColor 10%, transparent))'
var BANNER_ERROR = 'color-mix(in srgb, var(--destructive, #ef4444) 12%, transparent)'
var BANNER_WARNING = 'color-mix(in srgb, #f59e0b 14%, transparent)'

// Semantic status tokens (Hermes Desktop): readable on Light and Dark because foreground text is mixed in.
var TOKEN_SUCCESS = 'var(--ui-success, #34d399)'
var TOKEN_DANGER = 'var(--destructive, #ef4444)'
var TOKEN_WARNING = '#f59e0b'
var TOKEN_ACCENT = 'var(--ui-accent, #60a5fa)'
function semanticText(token) { return 'color-mix(in srgb, ' + token + ' 62%, var(--foreground, currentColor))' }
function semanticTint(token, pct) { return 'color-mix(in srgb, ' + token + ' ' + (pct || 14) + '%, transparent)' }

var DRAWER_WIDTH_DEFAULT = 540
var DRAWER_WIDTH_MIN = 380
var DRAWER_WIDTH_MAX = 960
var SPECS_SIDEBAR_DEFAULT = 260
var SPECS_SIDEBAR_MIN = 180
var SPECS_SIDEBAR_MAX = 480
var CREW_INLINE_LIMIT = 3
var CREW_BUCKETS = ['running', 'review', 'blocked', 'queued', 'done']
var POLL_INTERVAL_MS = 5000

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers — exported as __test for headless verification
// ═══════════════════════════════════════════════════════════════════════════════

function sourcesPath(cwd) {
  var raw = cwd == null ? '' : String(cwd)
  return raw.trim() ? '/sources?cwd=' + encodeURIComponent(raw) : '/sources'
}

function changePath(sourceId, name) {
  return '/sources/' + encodeURIComponent(sourceId) + '/changes/' + encodeURIComponent(name)
}

function ideaPath(sourceId, name) {
  return '/sources/' + encodeURIComponent(sourceId) + '/ideas/' + encodeURIComponent(name)
}

function specBrowserPath(sourceId, opts) {
  var base = '/sources/' + encodeURIComponent(sourceId) + '/spec-browser'
  if (opts && opts.dirty) return base + '?dirty=true'
  return base
}

function specPath(sourceId, path) {
  return '/sources/' + encodeURIComponent(sourceId) + '/specs?path=' + encodeURIComponent(path)
}

function explorationPath(sourceId, name, scope) {
  return '/sources/' + encodeURIComponent(sourceId) + '/explorations/' + encodeURIComponent(name) +
    '?scope=' + encodeURIComponent(scope || 'workspace')
}

function discoverSourcesPath(sourceId) {
  return '/sources/' + encodeURIComponent(sourceId) + '/discover'
}

function explorationScopeLabel(scope) {
  var s = String(scope || 'workspace')
  if (s.indexOf('change:') === 0) return 'Change: ' + s.slice('change:'.length)
  return 'Workspace'
}

function filterExplorations(items, query) {
  if (!query) return items || []
  var q = String(query).toLowerCase()
  return (items || []).filter(function(item) {
    return [item.title, item.name, item.scope, item.token].some(function(field) {
      return String(field || '').toLowerCase().includes(q)
    })
  })
}

function sortExplorations(items) {
  return (items || []).slice().sort(function(a, b) {
    var da = String(a.date || '')
    var db = String(b.date || '')
    if (da !== db) return da < db ? 1 : -1
    var ta = String(a.title || a.name || '').toLowerCase()
    var tb = String(b.title || b.name || '').toLowerCase()
    if (ta < tb) return -1
    if (ta > tb) return 1
    return 0
  })
}

var VERDICT_TONE = {
  APPROVED: '#34d399',
  REJECTED: '#f87171',
  PENDING: 'var(--ui-text-tertiary)',
}

function verdictTone(verdict) {
  return VERDICT_TONE[String(verdict || '').toUpperCase()] || VERDICT_TONE.PENDING
}

function nonEmptyList(value) {
  return Array.isArray(value) && value.length > 0
}

function changeTabKeys(data) {
  var d = data || {}
  var keys = []
  if (d.proposal) keys.push('proposal')
  if (d.tasks) keys.push('tasks')
  if (d.design) keys.push('design')
  if (nonEmptyList(d.specs)) keys.push('specs')
  if (nonEmptyList(d.reviews)) keys.push('reviews')
  if (nonEmptyList(d.explorations)) keys.push('explorations')
  return keys
}

function crewCardsFor(item) {
  return item && Array.isArray(item.crewCards) ? item.crewCards : []
}

function selectFirstValid(sources) {
  if (!sources || sources.length === 0) return null
  var valid = sources.filter(function(s) { return s.valid !== false })
  if (valid.length > 0) return valid[0]
  return sources[0]
}

function normalizeStatus(status) {
  var s = String(status || '').toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'in_progress') return 'in-progress'
  if (s === 'ideas') return 'ideas'
  if (s === 'draft') return 'draft'
  if (s === 'todo') return 'todo'
  if (s === 'done') return 'done'
  if (s === 'archived') return 'archived'
  return 'todo'
}

var STATUS_ORDER = ['ideas', 'draft', 'todo', 'in-progress', 'done', 'archived']

function groupByStatus(items, showArchived) {
  var groups = {}
  var order = showArchived ? STATUS_ORDER : STATUS_ORDER.filter(function(s) { return s !== 'archived' })
  for (var i = 0; i < order.length; i++) groups[order[i]] = []
  for (var j = 0; j < (items || []).length; j++) {
    var item = items[j]
    var status = effectiveChangeStatus(item)
    if (!showArchived && status === 'archived') continue
    if (!groups[status]) groups[status] = []
    groups[status].push(item)
  }
  return groups
}

function normalizeSequencePosition(sequence) {
  var position = sequence && typeof sequence === 'object' ? sequence.position : sequence
  return typeof position === 'number' && Number.isFinite(position) ? position : null
}

function groupCrewCardsByStatus(cards) {
  var g = { total: 0, running: [], review: [], blocked: [], queued: [], done: [], activeState: 'idle' }
  var list = Array.isArray(cards) ? cards : []
  for (var i = 0; i < list.length; i++) {
    var card = list[i]
    if (!card) continue
    var st = String(card.status || '').toLowerCase()
    if (st === 'archived') continue
    g.total++
    if (st === 'running') g.running.push(card)
    else if (st === 'review') g.review.push(card)
    else if (st === 'blocked' || st === 'triage') g.blocked.push(card)
    else if (st === 'done' || st === 'completed') g.done.push(card)
    else g.queued.push(card)
  }
  if (g.running.length > 0) g.activeState = 'running'
  else if (g.review.length > 0) g.activeState = 'review'
  else if (g.blocked.length > 0) g.activeState = 'blocked'
  else if (g.queued.length > 0) g.activeState = 'queued'
  else if (g.done.length > 0) g.activeState = 'done'
  return g
}

function itemActivityRank(item) {
  var g = groupCrewCardsByStatus(crewCardsFor(item))
  if (g.running.length > 0) return 0
  if (g.review.length > 0) return 1
  if (g.blocked.length > 0) return 2
  if (g.queued.length > 0) return 3
  return 4
}

// Static tasks.md status stays 0/N while work runs in an isolated Crew worktree: live Crew
// activity (running/review/done) promotes a todo/draft change to in-progress.
function effectiveChangeStatus(item) {
  var base = normalizeStatus(item && (item.status || item.state || item.phase))
  if (base !== 'todo' && base !== 'draft') return base
  var g = groupCrewCardsByStatus(crewCardsFor(item))
  return (g.running.length > 0 || g.review.length > 0 || g.done.length > 0) ? 'in-progress' : base
}

function crewProgressLabel(grouped) {
  var g = grouped || groupCrewCardsByStatus([])
  return 'Crew: ' + g.done.length + '/' + g.total + ' done' + (g.running.length > 0 ? ' \u00b7 ' + g.running.length + ' running' : '')
}

function sortItems(items) {
  return (items || []).slice().sort(function(a, b) {
    var ra = itemActivityRank(a)
    var rb = itemActivityRank(b)
    if (ra !== rb) return ra - rb
    var sa = normalizeSequencePosition(a.sequence)
    var sb = normalizeSequencePosition(b.sequence)
    if (sa == null) sa = 9999
    if (sb == null) sb = 9999
    if (sa !== sb) return sa - sb
    var ta = (a.title || a.name || '').toLowerCase()
    var tb = (b.title || b.name || '').toLowerCase()
    if (ta < tb) return -1
    if (ta > tb) return 1
    return 0
  })
}

function clampWidth(px, min, max, fallback) {
  var n = (px == null || px === '') ? NaN : Number(px)
  if (!isFinite(n)) n = fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampDrawerWidth(px) { return clampWidth(px, DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX, DRAWER_WIDTH_DEFAULT) }

function clampSpecsSidebarWidth(px) { return clampWidth(px, SPECS_SIDEBAR_MIN, SPECS_SIDEBAR_MAX, SPECS_SIDEBAR_DEFAULT) }

function readStoredWidth(ctx, key, clamp) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.get === 'function') return clamp(ctx.storage.get(key, null))
  } catch (e) { /* storage blocked: fall back to the default width */ }
  return clamp(undefined)
}

function writeStoredWidth(ctx, key, width) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') ctx.storage.set(key, width)
  } catch (e) { /* storage full or blocked: the width still applies this session */ }
}

// Pointer-drag resize shared by the drawer (dir -1: dragging left widens) and the specs sidebar (dir +1).
function beginResize(e, startWidth, dir, clamp, onChange, onDone) {
  if (!e || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  if (typeof e.preventDefault === 'function') e.preventDefault()
  var startX = e.clientX
  function next(ev) { return clamp(startWidth + dir * (ev.clientX - startX)) }
  function move(ev) { if (onChange) onChange(next(ev)) }
  function up(ev) {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (onDone) onDone(next(ev))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// Navigate through the plugin host: ctx.host (mock/test contexts) first, then the SDK's top-level host.
function navigateToCrewCard(ctx, url) {
  if (!url) return null
  if (ctx && ctx.host && typeof ctx.host.navigate === 'function') return ctx.host.navigate(url)
  if (host && typeof host.navigate === 'function') return host.navigate(url)
  return null
}

function filterItems(items, query) {
  if (!query) return items || []
  var q = String(query).toLowerCase()
  return (items || []).filter(function(item) {
    var title = String(item.title || item.name || '').toLowerCase()
    var token = String(item.token || '').toLowerCase()
    var name = String(item.name || '').toLowerCase()
    return title.includes(q) || token.includes(q) || name.includes(q)
  })
}

function toggleArchived(current) { return !current }

function stripFrontmatter(content) {
  if (!content) return content
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Slice 3c helpers — spec parsing, spec filtering, exploration scope slug
// ═══════════════════════════════════════════════════════════════════════════════

// Mirrors spec_parser.parse_spec: { title, purpose, requirements: [{ name, description, scenarios: [{ name, steps: [{ type, text }] }] }] }.
function parseSpec(md) {
  if (!md) return { title: '', purpose: '', requirements: [] }
  var lines = String(md).split('\n')
  var title = ''
  var purpose = ''
  var reqs = []
  var state = 'top'
  var currentReq = null
  var currentScn = null
  for (var i = 0; i < lines.length; i++) {
    var trim = lines[i].trim()
    if (trim.indexOf('# ') === 0) { title = trim.replace(/^#\s+/, '').replace(/\s+Specification\s*$/i, ''); state = 'top'; continue }
    if (/^##\s+Purpose/i.test(trim)) { state = 'purpose'; continue }
    if (/^##\s+Requirements/i.test(trim)) { state = 'top'; continue }
    var mReq = trim.match(/^###\s+Requirement:\s*(.+)$/i)
    if (mReq) {
      currentReq = { name: mReq[1].trim(), description: '', scenarios: [] }
      reqs.push(currentReq)
      currentScn = null
      state = 'reqDesc'
      continue
    }
    var mScn = trim.match(/^####\s+Scenario:\s*(.+)$/i)
    if (mScn) {
      currentScn = { name: mScn[1].trim(), steps: [] }
      if (currentReq) currentReq.scenarios.push(currentScn)
      state = 'scenario'
      continue
    }
    if (!trim) continue
    if (state === 'purpose') {
      purpose += (purpose ? '\n' : '') + trim
    } else if (state === 'reqDesc') {
      if (currentReq) currentReq.description += (currentReq.description ? '\n' : '') + trim
    } else if (state === 'scenario' && currentScn) {
      var step = trim.match(/^[-*]\s+\*\*(\w+)\*\*\s*(.+)$/)
      if (step) currentScn.steps.push({ type: step[1].toUpperCase(), text: step[2].trim() })
      else if (currentScn.steps.length) currentScn.steps[currentScn.steps.length - 1].text += ' ' + trim
    }
  }
  return { title: title, purpose: purpose, requirements: reqs }
}

function filterSpecFiles(files, query) {
  var q = String(query || '').trim().toLowerCase()
  var list = files || []
  if (!q) return list
  return list.filter(function(f) {
    return [f.title, f.path, f.domain, f.purpose, f.token].some(function(v) {
      return String(v || '').toLowerCase().indexOf(q) >= 0
    })
  })
}

function specCountsLabel(file) {
  if (!file || typeof file.requirementCount !== 'number') return ''
  return file.requirementCount + ' reqs \u00b7 ' + (file.scenarioCount || 0) + ' scenarios'
}

function specStatusBadgeVisible(status) {
  return status === 'added' || status === 'modified' || status === 'deleted'
}

function specRequirementText(req) {
  var parts = [req.name, req.description]
  var scenarios = req.scenarios || []
  scenarios.forEach(function(scn) {
    parts.push(scn.name)
    ;(scn.steps || []).forEach(function(st) { parts.push(st.type, st.text) })
  })
  return parts.join('\n').toLowerCase()
}

// Keeps the original requirement index so R-numbers stay stable while filtering.
function filterSpecRequirements(reqs, query) {
  var q = String(query || '').trim().toLowerCase()
  var out = []
  var list = reqs || []
  list.forEach(function(req, index) {
    if (!q || specRequirementText(req).indexOf(q) >= 0) out.push({ index: index, req: req })
  })
  return out
}

function changeSlugFromScope(scope) {
  var s = String(scope || '')
  return s.indexOf('change:') === 0 ? s.slice('change:'.length) : ''
}


// ═══════════════════════════════════════════════════════════════════════════════
// Resolver-safe identity helpers — pure, testable, canonical-aligned
// ═══════════════════════════════════════════════════════════════════════════════

function buildSourceReference(source, allSources) {
  if (!source) return ''
  var name = String(source.name || '').trim()
  if (name) {
    var count = 0
    for (var i = 0; i < (allSources || []).length; i++) {
      var other = allSources[i]
      if (other && String(other.name || '').trim().toLowerCase() === name.toLowerCase()) count++
    }
    if (count === 1) return name
  }
  var token = String(source.token || '').trim()
  if (token) return token
  var id = String(source.id || '').trim()
  if (id) return id
  return ''
}

function buildItemReference(source, item, allSources) {
  var sourceRef = buildSourceReference(source, allSources)
  var token = item && item.token ? String(item.token).trim() : ''
  if (!sourceRef || !token) return ''
  return sourceRef + '/' + token
}

function hasUniqueItemToken(item, allItems) {
  var token = item && item.token ? String(item.token).trim() : ''
  if (!token) return false
  var count = 0
  for (var i = 0; i < (allItems || []).length; i++) {
    var other = allItems[i]
    if (other && String(other.token || '').trim() === token) count++
  }
  return count === 1
}

function createSessionStore() {
  var store = {
    selectedSourceId: null,
    showArchived: true,
    pendingSourceId: null,
    listeners: [],
    subscribe: function(listener) {
      store.listeners.push(listener)
      return function() {
        var at = store.listeners.indexOf(listener)
        if (at >= 0) store.listeners.splice(at, 1)
      }
    },
    selectSource: function(sourceId) {
      store.selectedSourceId = sourceId
      store.pendingSourceId = sourceId
      var current = store.listeners.slice()
      for (var i = 0; i < current.length; i++) current[i](sourceId)
    },
  }
  return store
}

function resolveRetainedSource(sources, retainedId) {
  if (!sources || sources.length === 0) return null
  if (retainedId != null && retainedId !== '') {
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].id === retainedId) return retainedId
    }
  }
  var fallback = selectFirstValid(sources)
  return fallback ? fallback.id : null
}

function detailTitle(loaded, summary, item, kind) {
  if (loaded && loaded.title) return loaded.title
  if (summary && summary.title) return summary.title
  if (item && item.name) return item.name
  return kind === 'idea' ? 'Untitled idea' : 'Untitled change'
}

function detailSecondaryName(loaded, summary) {
  if (loaded && loaded.name) return loaded.name
  if (summary && summary.name) return summary.name
  return ''
}

function ideaSecondaryName(name) {
  if (!name) return ''
  return String(name).replace(/\.md$/i, '') + '.md'
}

function handleActivateKey(e, action) {
  if (!e) return
  if (e.key === 'Enter' || e.key === ' ') {
    if (typeof e.preventDefault === 'function') e.preventDefault()
    if (action) action()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane override helpers — pure, testable, canonical-aligned
// ═══════════════════════════════════════════════════════════════════════════════

function computeCollapsedSet(autoCollapsed, manualOverrides, statusOrder) {
  var result = {}
  for (var i = 0; i < statusOrder.length; i++) {
    var s = statusOrder[i]
    if (manualOverrides[s] !== undefined) {
      result[s] = manualOverrides[s]
    } else {
      result[s] = !!autoCollapsed[s]
    }
  }
  return result
}

function toggleOverride(prev, status, autoCollapsed) {
  var next = Object.assign({}, prev)
  var auto = !!autoCollapsed[status]
  if (next[status] !== undefined) {
    delete next[status]
  } else {
    next[status] = !auto
  }
  return next
}

function computeLanePhase(grouped, statusOrder) {
  if (!grouped) return null
  var parts = []
  for (var i = 0; i < statusOrder.length; i++) {
    var s = statusOrder[i]
    var items = grouped[s] || []
    parts.push(s + ':' + (items.length === 0 ? 'empty' : 'full'))
  }
  return parts.join('|')
}

function pruneStaleOverrides(prevOverrides, prevPhase, lanePhase) {
  if (prevPhase === null || lanePhase === null || lanePhase === prevPhase) {
    return prevOverrides
  }
  var before = {}
  var prevParts = prevPhase.split('|')
  for (var i = 0; i < prevParts.length; i++) {
    var kv = prevParts[i].split(':')
    before[kv[0]] = kv[1]
  }
  var next = Object.assign({}, prevOverrides)
  var changed = false
  var curParts = lanePhase.split('|')
  for (var j = 0; j < curParts.length; j++) {
    var ckv = curParts[j].split(':')
    var name = ckv[0]
    var phase = ckv[1]
    var was = before[name]
    if (was !== undefined && was !== phase && next[name] !== undefined) {
      delete next[name]
      changed = true
    }
  }
  return changed ? next : prevOverrides
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane layout helpers
// ═══════════════════════════════════════════════════════════════════════════════

var LANE_EXPANDED_WIDTH = 256
var LANE_COLLAPSED_WIDTH = 32

// ═══════════════════════════════════════════════════════════════════════════════
// Canonical status tone mapping — aligned with kanban/types.ts COLUMN_META
// ═══════════════════════════════════════════════════════════════════════════════

var STATUS_TONE = {
  'ideas': 'var(--ui-text-tertiary)',
  'draft': '#a78bfa',
  'todo': 'var(--ui-text-secondary)',
  'in-progress': '#34d399',
  'done': 'var(--ui-text-tertiary)',
  'archived': 'var(--ui-text-quaternary)',
}

function statusTone(status) {
  return STATUS_TONE[status] || 'var(--ui-text-secondary)'
}

function autoCollapseEmptyLanes(grouped, statusOrder) {
  var totalItems = 0
  for (var i = 0; i < statusOrder.length; i++) {
    var s = statusOrder[i]
    var items = grouped[s] || []
    totalItems += items.length
  }
  var collapsed = {}
  if (totalItems > 0) {
    for (var j = 0; j < statusOrder.length; j++) {
      var st = statusOrder[j]
      var col = grouped[st] || []
      if (col.length === 0) collapsed[st] = true
    }
  }
  return collapsed
}

function laneWidth(status, collapsedSet) {
  return (collapsedSet && collapsedSet[status]) ? LANE_COLLAPSED_WIDTH : LANE_EXPANDED_WIDTH
}

function railStyle() {
  return {
    width: LANE_COLLAPSED_WIDTH + 'px',
    minWidth: LANE_COLLAPSED_WIDTH + 'px',
    flexShrink: 0,
    height: '100%',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    borderRadius: '8px',
    padding: '8px 0',
    overflow: 'hidden',
  }
}

function expandedStyle() {
  return {
    width: LANE_EXPANDED_WIDTH + 'px',
    minWidth: LANE_EXPANDED_WIDTH + 'px',
    flexShrink: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'color-mix(in srgb, var(--ui-bg-quinary) 50%, transparent)',
    borderRadius: '8px',
    padding: '8px',
    overflow: 'hidden',
  }
}

function parseTasks(content) {
  var total = 0, done = 0
  var sections = []
  var lines = (content || '').split('\n')
  var currentSection = null
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var headingMatch = line.match(/^#{1,6}\s+(.+)/)
    if (headingMatch) {
      currentSection = { title: headingMatch[1], done: 0, total: 0, tasks: [] }
      sections.push(currentSection)
    }
    var taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s*(.*)/)
    if (taskMatch) {
      var isDone = taskMatch[1] === 'x' || taskMatch[1] === 'X'
      total++
      if (isDone) done++
      var task = { text: taskMatch[2], done: isDone }
      if (!currentSection) {
        currentSection = { title: 'Tasks', done: 0, total: 0, tasks: [] }
        sections.push(currentSection)
      }
      currentSection.total++
      if (isDone) currentSection.done++
      currentSection.tasks.push(task)
    }
  }
  return { total: total, done: done, sections: sections }
}

function splitTableRow(line) {
  var s = String(line).trim()
  if (s.charAt(0) === '|') s = s.slice(1)
  if (s.length > 0 && s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1)
  var cells = []
  var cur = ''
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i)
    if (ch === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function isTableSeparator(line) {
  var s = String(line)
  return s.indexOf('|') >= 0 && s.indexOf('-') >= 0 && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s)
}

function tableAlign(cell) {
  var left = cell.charAt(0) === ':'
  var right = cell.charAt(cell.length - 1) === ':'
  return left && right ? 'center' : right ? 'right' : 'left'
}

function renderMarkdown(content) {
  if (!content) return []
  var elements = []
  var lines = content.split('\n')
  var i = 0
  while (i < lines.length) {
    var line = lines[i]

    // Fenced code block
    if (line.match(/^```/)) {
      var lang = line.slice(3).trim()
      var codeLines = []
      i++
      while (i < lines.length && !lines[i].match(/^```/)) { codeLines.push(lines[i]); i++ }
      i++ // skip closing fence
      elements.push({ type: 'fenced', lang: lang, content: codeLines.join('\n') })
      continue
    }

    // Heading
    var headingMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (headingMatch) {
      elements.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] })
      i++; continue
    }

    // Horizontal rule
    if (line.match(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/)) {
      elements.push({ type: 'hr' })
      i++; continue
    }

    // Blockquote (consecutive > lines)
    if (line.match(/^\s{0,3}>/)) {
      var quoteLines = []
      while (i < lines.length && lines[i].match(/^\s{0,3}>/)) { quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++ }
      elements.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    // Table (header row + separator row + body rows)
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      var header = splitTableRow(line)
      var sepCells = splitTableRow(lines[i + 1])
      if (header.length === sepCells.length) {
        var tableRows = []
        i += 2
        while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) { tableRows.push(splitTableRow(lines[i])); i++ }
        elements.push({ type: 'table', header: header, align: sepCells.map(tableAlign), rows: tableRows })
        continue
      }
    }

    // Unordered list
    if (line.match(/^[-*]\s+/)) {
      elements.push({ type: 'list-item', ordered: false, text: line.replace(/^[-*]\s+/, '') })
      i++; continue
    }

    // Ordered list
    if (line.match(/^\d+\.\s+/)) {
      elements.push({ type: 'list-item', ordered: true, text: line.replace(/^\d+\.\s+/, '') })
      i++; continue
    }

    // Empty line
    if (line.trim() === '') { i++; continue }

    // Paragraph
    elements.push({ type: 'paragraph', text: line })
    i++
  }
  return elements
}

function classifyState(query) {
  if (query.isLoading) return 'loading'
  if (query.error) return 'error'
  if (query.data) {
    if (Array.isArray(query.data) && query.data.length === 0) return 'empty'
    if (query.data.sources && query.data.sources.length === 0) return 'empty'
    if (query.data.files && query.data.files.length === 0) return 'empty'
    if (query.data.items && Array.isArray(query.data.items) && query.data.items.length === 0) return 'empty'
    return 'content'
  }
  return 'empty'
}

function classifyDiffLine(line) {
  if (!line) return 'context'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  if (line.startsWith('@@')) return 'hunk'
  return 'context'
}

function hasDiffMode(data, mode) {
  if (!data) return false
  if (mode === 'semantic') return !!(data.semantic_diff && (data.semantic_diff.groups || data.semantic_diff.requirements))
  if (mode === 'split') return !!(data.before != null && data.after != null)
  if (mode === 'raw') return !!(data.diff || data.raw_diff)
  return false
}

function effectiveDiffMode(desired, data) {
  if (hasDiffMode(data, desired)) return desired
  var fallback = ['semantic', 'split', 'raw']
  for (var i = 0; i < fallback.length; i++) {
    if (hasDiffMode(data, fallback[i])) return fallback[i]
  }
  return desired
}

function trimPath(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

function extractApiError(err) {
  if (!err) return 'Unknown error'
  var candidate = typeof err === 'string' ? err : (err.message || err.detail)
  if (typeof candidate === 'string' && /\b409\b/.test(candidate) && candidate.indexOf('Source already registered') !== -1) {
    return 'Source already registered. Select it from the source list, or remove it before adding again.'
  }
  if (typeof err === 'string') return err
  if (err.message) return err.message
  if (err.detail) return err.detail
  return String(err)
}

function sourceNeedsInitialization(result) {
  var source = result && result.source
  return !!(source && source.id && source.valid === false && source.error === 'No openspec/ directory found')
}

function initializeAddedSource(api, result) {
  if (!sourceNeedsInitialization(result)) return Promise.resolve(result)
  return api.initSource(result.source.id).then(function(initResult) {
    return initResult && initResult.source && initResult.source.id ? initResult : result
  }).catch(function(e) {
    return Object.assign({}, result, { initError: extractApiError(e) })
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// API adapter — source registry mutations + read-only, namespace-scoped
// ═══════════════════════════════════════════════════════════════════════════════

function createApi(ctx) {
  return {
    sources: function(cwd) { return ctx.rest(sourcesPath(cwd)) },
    change: function(sourceId, name) { return ctx.rest(changePath(sourceId, name)) },
    idea: function(sourceId, name) { return ctx.rest(ideaPath(sourceId, name)) },
    specBrowser: function(sourceId, opts) { return ctx.rest(specBrowserPath(sourceId, opts)) },
    spec: function(sourceId, path) { return ctx.rest(specPath(sourceId, path)) },
    exploration: function(sourceId, name, scope) { return ctx.rest(explorationPath(sourceId, name, scope)) },
    discoverSources: function(sourceId, register) {
      return ctx.rest(discoverSourcesPath(sourceId), { method: 'POST', body: { register: !!register } })
    },
    addSource: function(path, name) {
      return ctx.rest(sourcesPath(), { method: 'POST', body: { path: path, name: name || undefined } })
    },
    updateSource: function(sourceId, path, name) {
      return ctx.rest('/sources/' + encodeURIComponent(sourceId), { method: 'PUT', body: { path: path, name: name || undefined } })
    },
    initSource: function(sourceId) {
      return ctx.rest('/sources/' + encodeURIComponent(sourceId) + '/init', { method: 'POST' })
    },
    removeSource: function(sourceId) {
      return ctx.rest('/sources/' + encodeURIComponent(sourceId), { method: 'DELETE' })
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Markdown renderer — safe subset, no innerHTML
// ═══════════════════════════════════════════════════════════════════════════════

function isSafeUrl(url) {
  if (!url) return false
  // Strip leading whitespace and control characters (U+0000-U+001F, U+007F-U+009F)
  var s = String(url).replace(/^[\s\x00-\x1f\x7f-\x9f]+/, '')
  if (!s) return false
  // Reject protocol-relative URLs
  if (s.startsWith('//')) return false
  // Allow relative paths and fragment-only links
  if (s.startsWith('/') || s.startsWith('#') || s.startsWith('?')) return true
  // Explicit scheme allowlist: http, https, mailto (case-insensitive)
  var lower = s.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) return true
  // Everything else is rejected (javascript:, data:, file:, vbscript:, etc.)
  return false
}

function renderInline(text) {
  if (!text) return text
  var parts = []
  var remaining = text
  var regex = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9_])_([^_\s][^_]*?)_(?![A-Za-z0-9_]))/g
  var lastIndex = 0
  var match
  while ((match = regex.exec(remaining)) !== null) {
    if (match.index > lastIndex) parts.push(remaining.slice(lastIndex, match.index))
    if (match[2]) parts.push(jsx('strong', { style: { fontWeight: 600 }, children: match[2] }))
    else if (match[3]) parts.push(jsx('code', { style: { background: SURFACE_INLINE_CODE, color: 'var(--ui-inline-code-foreground, inherit)', padding: '1px 4px', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.9em' }, children: match[3] }))
    else if (match[4]) {
      if (isSafeUrl(match[5])) {
        parts.push(jsx('a', { href: match[5], target: '_blank', rel: 'noopener noreferrer', style: { color: semanticText(TOKEN_ACCENT), textDecoration: 'underline' }, children: match[4] }))
      } else {
        parts.push(jsx('span', { style: { color: 'var(--muted-foreground, inherit)' }, children: match[4] + ' [unsafe link]' }))
      }
    }
    else if (match[6] || match[7]) parts.push(jsx('em', { style: { fontStyle: 'italic' }, children: match[6] || match[7] }))
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < remaining.length) parts.push(remaining.slice(lastIndex))
  return parts
}

var HEADING_STYLES = {
  1: { fontSize: '1.4em', fontWeight: 700, margin: '14px 0 8px', paddingBottom: '4px', borderBottom: BORDER_SUBTLE, color: 'var(--foreground, inherit)' },
  2: { fontSize: '1.2em', fontWeight: 700, margin: '12px 0 6px', paddingBottom: '3px', borderBottom: BORDER_SUBTLE, color: 'var(--foreground, inherit)' },
  3: { fontSize: '1.08em', fontWeight: 600, margin: '10px 0 4px', color: 'var(--foreground, inherit)' },
  4: { fontSize: '1em', fontWeight: 600, margin: '8px 0 4px', color: 'color-mix(in srgb, var(--foreground, currentColor) 78%, transparent)' },
}

function headingStyle(level) { return HEADING_STYLES[Math.min(Math.max(level || 1, 1), 4)] }

function diffLineStyle(cls) {
  var style = { display: 'block', padding: '1px 4px', color: 'var(--foreground, inherit)' }
  if (cls === 'added') { style.color = semanticText(TOKEN_SUCCESS); style.background = semanticTint(TOKEN_SUCCESS, 12) }
  else if (cls === 'removed') { style.color = semanticText(TOKEN_DANGER); style.background = semanticTint(TOKEN_DANGER, 12) }
  else if (cls === 'hunk') { style.color = semanticText(TOKEN_ACCENT); style.background = semanticTint(TOKEN_ACCENT, 8) }
  return style
}

function MarkdownTable(el) {
  var align = el.align || []
  function cellStyle(i, isHead) {
    return { border: BORDER_SUBTLE, padding: '4px 8px', textAlign: align[i] || 'left', verticalAlign: 'top', fontWeight: isHead ? 600 : 400, background: isHead ? SURFACE_CODE : 'transparent', color: 'var(--foreground, inherit)' }
  }
  return jsx('div', { style: { overflowX: 'auto', margin: '6px 0' }, children: jsxs('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: '0.95em' }, children: [
    jsx('thead', { children: jsx('tr', { children: (el.header || []).map(function(cell, i) { return jsx('th', { style: cellStyle(i, true), children: renderInline(cell) }, i) }) }) }),
    jsx('tbody', { children: (el.rows || []).map(function(row, r) {
      return jsx('tr', { children: (el.header || []).map(function(_h, i) { return jsx('td', { style: cellStyle(i, false), children: renderInline(row[i] || '') }, i) }) }, r)
    }) }),
  ] }) })
}

function MarkdownElement(el) {
  if (typeof el === 'string') return el
  if (typeof el === 'number') return el
  if (!el || !el.type) return null
  switch (el.type) {
    case 'heading':
      return jsx('div', { 'data-md-heading': String(el.level), style: headingStyle(el.level), children: renderInline(el.text) })
    case 'paragraph':
      return jsx('div', { style: { margin: '4px 0', color: 'var(--foreground, inherit)' }, children: renderInline(el.text) })
    case 'list-item':
      return jsxs('div', { style: { margin: '1px 0', paddingLeft: '16px', color: 'var(--foreground, inherit)' }, children: [
        el.ordered ? '  ' : '\u2022 ',
        renderInline(el.text)
      ] })
    case 'blockquote':
      return jsx('div', { 'data-md-blockquote': 'true', style: { margin: '6px 0', padding: '4px 12px', borderLeft: '3px solid ' + semanticTint(TOKEN_ACCENT, 70), background: semanticTint(TOKEN_ACCENT, 8), borderRadius: '0 4px 4px 0', color: 'color-mix(in srgb, var(--foreground, currentColor) 82%, transparent)' }, children: (el.lines || []).map(function(line, i) { return jsx('div', { children: renderInline(line) }, i) }) })
    case 'hr':
      return jsx('hr', { 'data-md-hr': 'true', style: { border: 'none', borderTop: BORDER_SUBTLE, margin: '12px 0' } })
    case 'table':
      return jsx(MarkdownTable, { header: el.header, rows: el.rows, align: el.align })
    case 'fenced': {
      var isDiff = el.lang === 'diff' || el.lang === 'patch'
      var codeChildren = isDiff
        ? String(el.content || '').split('\n').map(function(line, i) { return jsx('span', { style: diffLineStyle(classifyDiffLine(line)), children: line + '\n' }, i) })
        : el.content
      return jsxs('div', { style: { margin: '4px 0' }, children: [
        el.lang ? jsx('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground, inherit)', opacity: 0.8, marginBottom: '2px' }, children: el.lang }) : null,
        jsx('pre', { style: { background: SURFACE_CODE, border: BORDER_SUBTLE, padding: '8px', borderRadius: '4px', margin: 0, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.9em', color: 'var(--foreground, inherit)' }, children: codeChildren }),
      ] })
    }
    default:
      return null
  }
}

function MarkdownView({ content }) {
  var elements = renderMarkdown(content)
  if (!elements || elements.length === 0) return jsx(EmptyState, { title: 'No content', description: 'This document is empty.' })
  return jsxs('div', { 'data-selectable-text': 'true', style: { padding: '12px' }, children: elements.map(function(el, i) { return jsx(MarkdownElement, Object.assign({}, el, { key: i })) }) })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query state wrapper
// ═══════════════════════════════════════════════════════════════════════════════

// Reusable retry error state: ErrorState with a Button child wired to onRetry.
// Real SDK ErrorStateProps has no onRetry — canonical pattern nests Button child.
function RetryErrorState({ title, description, onRetry }) {
  return jsx(ErrorState, {
    title: title,
    description: description,
    children: onRetry ? jsx(Button, {
      variant: 'outline',
      size: 'sm',
      onClick: onRetry,
      children: 'Retry'
    }) : null
  })
}

function QueryState({ query, onRetry, emptyTitle, emptyDescription, children }) {
  var state = classifyState(query)
  if (state === 'loading') return jsx(Loader, { type: 'lemniscate-bloom' })
  if (state === 'error') return jsx(RetryErrorState, {
    title: 'Request failed',
    description: (query.error && query.error.message) || 'Could not reach the backend.',
    onRetry: onRetry
  })
  if (state === 'empty') return jsx(EmptyState, { title: emptyTitle || 'Nothing found', description: emptyDescription || 'No data available.' })
  return children
}

// ═══════════════════════════════════════════════════════════════════════════════
// Source dialog — add/edit source registry entries
// ═══════════════════════════════════════════════════════════════════════════════

function SourceDialog({ mode, api, source, onClose, onSaved }) {
  var initialPath = source && source.path ? source.path : ''
  var initialName = source && source.name ? source.name : ''
  var _p = React.useState(initialPath)
  var _n = React.useState(initialName)
  var _busy = React.useState(false)
  var _err = React.useState('')
  var path = _p[0], setPath = _p[1]
  var name = _n[0], setName = _n[1]
  var busy = _busy[0], setBusy = _busy[1]
  var err = _err[0], setErr = _err[1]

  var title = mode === 'edit' ? 'Edit source' : 'Add source'

  function handleSave() {
    var trimmed = trimPath(path)
    if (!trimmed) { setErr('Path is required'); return }
    setBusy(true); setErr('')
    var promise = mode === 'edit' && source
      ? api.updateSource(source.id, trimmed, trimPath(name))
      : api.addSource(trimmed, trimPath(name))
    if (mode === 'add') {
      promise = promise.then(function(result) { return initializeAddedSource(api, result) })
    }
    promise.then(function(result) {
      setBusy(false)
      onSaved(result)
    }).catch(function(e) {
      setBusy(false)
      setErr(extractApiError(e))
    })
  }

  return jsx(Dialog, { open: true, onOpenChange: onClose, children: jsxs(DialogContent, { style: { padding: '16px', maxWidth: '480px' }, children: [
    jsx('h2', { style: { fontSize: '16px', fontWeight: 600, margin: '0 0 12px', color: 'var(--foreground, inherit)' }, children: title }),
    jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }, children: [
      jsxs('div', { children: [
        jsx('label', { style: { fontSize: '12px', fontWeight: 500, color: 'var(--muted-foreground, #888)', marginBottom: '4px', display: 'block' }, children: 'Path *' }),
        jsx(Input, { value: path, onChange: function(e) { setPath(e.target.value) }, placeholder: '/path/to/repo', disabled: busy }),
      ] }),
      jsxs('div', { children: [
        jsx('label', { style: { fontSize: '12px', fontWeight: 500, color: 'var(--muted-foreground, #888)', marginBottom: '4px', display: 'block' }, children: 'Display name' }),
        jsx(Input, { value: name, onChange: function(e) { setName(e.target.value) }, placeholder: 'Optional display name', disabled: busy }),
      ] }),
    ] }),
    err ? jsx('div', { style: { padding: '8px 12px', background: BANNER_ERROR, borderRadius: '4px', fontSize: '12px', color: 'var(--foreground, inherit)', marginBottom: '12px' }, children: err }) : null,
    jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, children: [
      jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, disabled: busy, children: 'Cancel' }),
      jsx(Button, { size: 'sm', onClick: handleSave, disabled: busy, children: busy ? 'Saving...' : 'Save' }),
    ] }),
  ] }) })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Card helpers
// ═══════════════════════════════════════════════════════════════════════════════

function CardTaskFraction({ item }) {
  var tasks = item.tasks || item.taskStats
  if (!tasks) return null
  var done = tasks.done != null ? tasks.done : (tasks.completed || 0)
  var total = tasks.total != null ? tasks.total : (tasks.count || 0)
  if (total === 0) return null
  return jsx(Badge, { variant: 'outline', children: '✅' + done + '/' + total })
}

function CardArtifacts({ item }) {
  var badges = []
  if (item.hasProposal) badges.push({ label: 'proposal', color: '#60a5fa' })
  if (item.hasTasks) badges.push({ label: 'tasks', color: '#34d399' })
  if (item.hasDesign) badges.push({ label: 'design', color: '#a78bfa' })
  if (item.hasSpecs) badges.push({ label: 'specs', color: '#fbbf24' })
  if (badges.length === 0) return null
  return jsxs('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
    children: badges.map(function(b, i) {
      return jsx(Badge, { variant: 'secondary', style: { fontSize: '10px', color: b.color }, children: b.label }, i)
    })
  })
}

function CardCrewPills({ item }) {
  var g = groupCrewCardsByStatus(crewCardsFor(item))
  if (g.total === 0) return null
  var defs = [
    { key: 'running', glyph: '\u25cf', color: 'var(--ui-success, #34d399)' },
    { key: 'review', glyph: '\u25d0', color: '#f59e0b' },
    { key: 'blocked', glyph: '!', color: 'var(--destructive, #ef4444)' },
    { key: 'queued', glyph: '\u25cb', color: 'var(--ui-text-secondary)' },
    { key: 'done', glyph: '\u2713', color: 'var(--ui-text-tertiary)' },
  ]
  return jsx('div', { 'data-crew-pills': 'true', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '10px' },
    children: defs.filter(function(d) { return g[d.key].length > 0 }).map(function(d) {
      return jsx('span', { 'data-crew-pill': d.key, style: { color: d.color, whiteSpace: 'nowrap' }, children: d.glyph + ' ' + g[d.key].length + ' ' + d.key }, d.key)
    })
  })
}

function BoardCard({ item, source, allSources, allItems, onSelect }) {
  var token = item.token || item.name || ''
  var title = item.title || item.name || 'Untitled'
  var sequencePosition = normalizeSequencePosition(item.sequence)
  var itemRef = buildItemReference(source, item, allSources)
  var canCopy = !!itemRef && hasUniqueItemToken(item, allItems)
  var onClick = function() { onSelect(item) }
  var status = effectiveChangeStatus(item)
  var activeState = groupCrewCardsByStatus(crewCardsFor(item)).activeState
  var radar = activeState === 'running' ? 'running' : (activeState === 'review' ? 'review' : null)
  return jsxs('div', {
    className: cn(
      radar === 'running' ? 'os-card-live' : null,
      radar === 'review' ? 'os-card-review' : null,
      'rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-3 pt-3 pb-0 cursor-pointer',
      'hover:border-(--ui-focus-border) hover:bg-primary/[0.06] hover:shadow-md transition-colors',
      'focus-visible:bg-(--ui-control-hover-background)'
    ),
    style: { borderLeftWidth: '2px', borderLeftColor: statusTone(status) },
    'data-selectable-text': 'true',
    'data-radar': radar || undefined,
    tabIndex: 0,
    role: 'button',
    onClick: onClick,
    onKeyDown: function(e) { handleActivateKey(e, onClick) },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }, children: [
        jsx('div', { style: { fontWeight: 500, fontSize: '13px', color: 'var(--foreground, inherit)' }, children: title }),
        sequencePosition != null ? jsx(Badge, { variant: 'outline', style: { fontSize: '10px', flexShrink: 0 }, children: '#' + sequencePosition }) : null
      ] }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }, children: [
        jsx(CardArtifacts, { item: item }),
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' }, children: [jsx(CardTaskFraction, { item: item })].concat(
          crewCardsFor(item).length > 0 ? [jsx(CardCrewPills, { item: item })] : [],
          [jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }, children: [
            canCopy ? jsx(CopyButton, { appearance: 'icon', text: itemRef, label: 'Copy item reference', title: itemRef, stopPropagation: true }) : null,
            token ? jsx('span', { style: { fontFamily: 'monospace', fontSize: '10px', color: 'var(--muted-foreground, #888)' }, children: token }) : null,
          ] })]
        ) }),
      ] }),
    ]
  }, token || title)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Board columns
// ═══════════════════════════════════════════════════════════════════════════════

var COLUMN_LABELS = {
  'ideas': 'Ideas',
  'draft': 'Draft',
  'todo': 'Todo',
  'in-progress': 'In Progress',
  'done': 'Done',
  'archived': 'Archived',
}

function BoardColumn({ status, items, source, allSources, allItems, onSelect, collapsed, onExpand }) {
  var label = COLUMN_LABELS[status] || status
  var sorted = sortItems(items)
  var count = items.length

  if (collapsed) {
    return jsx('div', {
      style: railStyle(),
      className: cn('focus-visible:bg-(--ui-control-hover-background) bg-[color-mix(in_srgb,var(--ui-bg-quinary)_50%,transparent)] hover:bg-(--ui-bg-quinary)'),
      tabIndex: 0,
      role: 'button',
      onClick: onExpand,
      onKeyDown: function(e) { handleActivateKey(e, onExpand) },
      title: label,
      'aria-label': label,
      children: [
        jsx('span', { style: { display: 'grid', height: '20px', placeItems: 'center', flexShrink: 0 }, children: [
          jsx('span', { style: { width: '6px', height: '6px', borderRadius: '50%', backgroundColor: statusTone(status) } }),
        ] }),
        jsx('span', { style: { fontSize: '11px', fontWeight: 600, color: 'var(--ui-text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap', writingMode: 'vertical-rl' }, children: label }),
        count > 0 ? jsx('span', { style: { fontSize: '10px', color: 'var(--ui-text-quaternary)', fontVariantNumeric: 'tabular-nums' }, children: count }) : null,
      ]
    })
  }

  return jsxs('div', { style: expandedStyle(), 'data-lane': status, children: [
    jsxs('button', {
      type: 'button',
      onClick: onExpand,
      title: 'Collapse ' + label,
      'aria-label': 'Collapse ' + label,
      className: cn(
        'flex w-full items-center justify-between px-1 pb-2 bg-transparent border-0 text-inherit cursor-pointer text-left',
        'focus-visible:bg-(--ui-control-hover-background)'
      ),
      style: { fontSize: 'inherit' },
      onKeyDown: function(e) { handleActivateKey(e, onExpand) },
      children: [
        jsxs('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
          jsx('span', { style: { width: '6px', height: '6px', borderRadius: '50%', backgroundColor: statusTone(status), flexShrink: 0 } }),
          jsx('span', { style: { fontWeight: 600, fontSize: '12px', textTransform: 'uppercase', color: 'var(--ui-text-tertiary)', letterSpacing: '0.05em' }, children: label }),
          count > 0 ? jsx('span', { style: { fontSize: '12px', color: 'var(--ui-text-quaternary)', fontVariantNumeric: 'tabular-nums' }, children: count }) : null,
        ] }),
        jsx('span', { style: { display: 'inline-flex', flexShrink: 0 }, children: jsx(Codicon, { name: 'chevron-left', size: '0.85rem' }) }),
      ]
    }),
    jsxs('div', { style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }, children: sorted.map(function(item) {
      return jsx(BoardCard, {
        item: item,
        source: source,
        allSources: allSources,
        allItems: allItems,
        onSelect: onSelect,
      }, item.token || item.name || item.title)
    }) }),
    items.length === 0 ? jsx('div', { style: { color: 'var(--muted-foreground, #666)', fontSize: '12px', padding: '12px 4px', fontStyle: 'italic' }, children: 'No items' }) : null,
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Detail drawer
// ═══════════════════════════════════════════════════════════════════════════════

function DetailDrawer({ title, secondary, itemRef, canCopy, token, taskStats, crewCards, width, onWidthChange, onClose, children }) {
  var drawerW = clampDrawerWidth(width == null ? DRAWER_WIDTH_DEFAULT : width)
  var refText = itemRef || token || ''
  var crew = groupCrewCardsByStatus(crewCards)

  function onSashPointerDown(e) {
    if (!onWidthChange) return
    beginResize(e, drawerW, -1, clampDrawerWidth,
      function(w) { onWidthChange(w, false) },
      function(w) { onWidthChange(w, true) })
  }
  function onSashKeyDown(e) {
    if (!e || !onWidthChange) return
    var step = e.key === 'ArrowLeft' ? 24 : (e.key === 'ArrowRight' ? -24 : 0)
    if (!step) return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    onWidthChange(clampDrawerWidth(drawerW + step), true)
  }

  return jsxs('div', {
    className: cn('absolute inset-y-0 right-0 z-20 flex flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) shadow-lg'),
    style: { minHeight: '0', width: drawerW + 'px', maxWidth: '100%' },
    'data-detail-drawer': 'true',
    children: [
      jsx('div', {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': 'Resize detail drawer',
        'aria-valuenow': drawerW,
        'aria-valuemin': DRAWER_WIDTH_MIN,
        'aria-valuemax': DRAWER_WIDTH_MAX,
        'data-drawer-resize-handle': 'true',
        tabIndex: 0,
        title: 'Drag to resize (double-click to reset)',
        onPointerDown: onSashPointerDown,
        onDoubleClick: function() { if (onWidthChange) onWidthChange(DRAWER_WIDTH_DEFAULT, true) },
        onKeyDown: onSashKeyDown,
        style: { position: 'absolute', left: '-3px', top: 0, bottom: 0, width: '6px', cursor: 'col-resize', zIndex: 30, touchAction: 'none' }
      }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: BORDER_SUBTLE, flexShrink: 0 }, children: [
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('h2', { style: { fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--foreground, inherit)' }, children: title }),
          secondary ? jsx('div', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', fontFamily: 'monospace', marginTop: '2px' }, children: secondary }) : null,
        ] }),
        jsx('button', {
          type: 'button',
          onClick: onClose,
          title: 'Close detail',
          'aria-label': 'Close detail',
          style: { background: 'none', border: 'none', color: 'var(--muted-foreground, #888)', cursor: 'pointer', padding: '4px', flexShrink: 0 },
          children: jsx(Codicon, { name: 'close', size: '1rem' })
        }),
      ] }),
      jsxs('div', { 'data-drawer-meta': 'true', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 16px', borderBottom: BORDER_SUBTLE, flexShrink: 0 }, children: [
        canCopy ? jsx(CopyButton, { appearance: 'icon', text: itemRef, label: 'Copy item reference', title: itemRef }) : null,
        refText ? jsx('span', { 'data-drawer-ref': refText, style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', fontFamily: 'monospace', wordBreak: 'break-all' }, children: refText }) : null,
        taskStats ? jsx(Badge, { variant: 'outline', 'data-drawer-badge': 'checklist', children: 'Checklist: ' + taskStats.done + '/' + taskStats.total }) : null,
        crew.total > 0 ? jsx(Badge, { variant: 'outline', 'data-drawer-badge': 'crew', children: crewProgressLabel(crew) }) : null,
      ] }),
      jsx('div', { 'data-selectable-text': 'true', style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: '0', padding: '8px 0' }, children: children }),
    ]
  })
}


// ═══════════════════════════════════════════════════════════════════════════════
// Change detail drawer
// ═══════════════════════════════════════════════════════════════════════════════

function ChangeDetailDrawer({ api, sourceId, change, source, allSources, allItems, ctx, width, onWidthChange, initialTab, onClose }) {
  var query = useQuery({
    queryKey: ['openspec', 'change', sourceId, change.name || change.token],
    queryFn: function() { return api.change(sourceId, change.name || change.token) },
    refetchInterval: POLL_INTERVAL_MS
  })

  var [activeTab, setActiveTab] = React.useState(null)

  var itemRef = buildItemReference(source, change, allSources)
  var canCopy = !!itemRef && hasUniqueItemToken(change, allItems)
  var title = query.data && query.data.title ? query.data.title : (change.title || change.name || 'Untitled change')
  var secondary = query.data && query.data.name ? query.data.name : (change.name || '')
  var token = change.token || change.name || ''

  if (query.isLoading) return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange, title: title, secondary: secondary, itemRef: itemRef, canCopy: canCopy, token: token, onClose: onClose, children: jsx(Loader, { type: 'lemniscate-bloom' }) })
  if (query.error) return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange, title: title, secondary: secondary, itemRef: itemRef, canCopy: canCopy, token: token, onClose: onClose, children: jsx(RetryErrorState, { title: 'Failed to load change', description: query.error.message, onRetry: function() { query.refetch() } }) })

  var data = query.data || {}
  var localExplorations = nonEmptyList(data.explorations) ? data.explorations : []
  var tabBuilders = {
    proposal: function() { return { key: 'proposal', label: 'Proposal', content: jsx(MarkdownView, { content: stripFrontmatter(data.proposal) }) } },
    tasks: function() { return { key: 'tasks', label: 'Tasks', content: jsx(TaskView, { content: stripFrontmatter(data.tasks) }) } },
    design: function() { return { key: 'design', label: 'Design', content: jsx(MarkdownView, { content: stripFrontmatter(data.design) }) } },
    specs: function() { return { key: 'specs', label: 'Specs (' + data.specs.length + ')', content: jsx(SpecsDetailView, { specs: data.specs }) } },
    reviews: function() { return { key: 'reviews', label: 'Reviews (' + data.reviews.length + ')', content: jsx(ReviewsView, { reviews: data.reviews }) } },
    explorations: function() {
      var pool = (source && source.openspec && source.openspec.explorations) || localExplorations
      return { key: 'explorations', label: 'Explorations (' + localExplorations.length + ')', content: jsx(ChangeExplorationsView, { api: api, sourceId: sourceId, explorations: localExplorations, source: source, allSources: allSources, allItems: pool, ctx: ctx }) }
    },
  }
  var tabs = changeTabKeys(data).map(function(key) { return tabBuilders[key]() })
  var crewCards = crewCardsFor(data)
  if (crewCards.length === 0) crewCards = crewCardsFor(change)

  var initialValid = initialTab && tabs.some(function(t) { return t.key === initialTab })
  var currentTab = activeTab || (initialValid ? initialTab : null) || (tabs.length > 0 ? tabs[0].key : null)

  // Use detailTitle/detailSecondaryName fallback helpers for consistency.
  title = detailTitle(data, change, change, 'change')
  secondary = detailSecondaryName(data, change)

  return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange,
    title: title,
    secondary: secondary,
    itemRef: itemRef,
    canCopy: canCopy,
    token: token,
    taskStats: data.taskStats,
    crewCards: crewCards,
    onClose: onClose,
    children: jsxs('div', { children: [
      jsx(CrewCardChips, { cards: crewCards, ctx: ctx }),
      tabs.length > 0 ? jsxs(Tabs, { value: currentTab, onValueChange: setActiveTab, children: [
        jsx(TabsList, { style: { display: 'flex', flexWrap: 'wrap', height: 'auto', width: '100%', justifyContent: 'flex-start', gap: '4px', padding: '4px' }, children: tabs.map(function(t) { return jsx(TabsTrigger, { value: t.key, children: t.label }, t.key) }) }),
        tabs.map(function(t) { return currentTab === t.key ? jsx('div', { key: t.key, children: t.content }) : null }),
      ] }) : jsx(EmptyState, { title: 'No artifacts', description: 'This change has no proposal, tasks, design, or spec content.' }),
    ] })
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Explorations, change reviews, Crew card chips
// ═══════════════════════════════════════════════════════════════════════════════

function renderExplorationRow(ex, source, sources, allItems, onSelect) {
  var itemRef = buildItemReference(source, ex, sources)
  var canCopy = !!itemRef && hasUniqueItemToken(ex, allItems)
  var title = ex.title || ex.name || 'Untitled exploration'
  var onClick = function() { onSelect(Object.assign({}, ex, { _type: 'exploration' })) }
  return jsxs('div', {
    'data-exploration-row': ex.token || ex.name,
    className: cn(
      'rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-3 py-2 cursor-pointer',
      'hover:border-(--ui-focus-border) hover:bg-primary/[0.06] transition-colors',
      'focus-visible:bg-(--ui-control-hover-background)'
    ),
    'data-selectable-text': 'true',
    tabIndex: 0,
    role: 'button',
    onClick: onClick,
    onKeyDown: function(e) { handleActivateKey(e, onClick) },
    children: [
      jsx('div', { 'data-exploration-title': 'true', style: { flex: 1, minWidth: 0, wordBreak: 'break-word', fontWeight: 500, fontSize: '13px', color: 'var(--foreground, inherit)' }, children: title }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', minWidth: 0, flexWrap: 'wrap' }, children: [
        ex.date ? jsx('span', { 'data-exploration-date': 'true', style: { fontSize: '11px', color: 'var(--muted-foreground, #888)', whiteSpace: 'nowrap', flexShrink: 0 }, children: ex.date }) : null,
        jsx(Badge, { variant: 'outline', title: explorationScopeLabel(ex.scope), style: { fontSize: '10px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }, children: explorationScopeLabel(ex.scope) }),
        jsx('span', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted-foreground, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, children: ex.filename || '' }),
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }, children: [
          canCopy ? jsx(CopyButton, { appearance: 'icon', text: itemRef, label: 'Copy item reference', title: itemRef, stopPropagation: true }) : null,
          ex.token ? jsx('span', { style: { fontFamily: 'monospace', fontSize: '10px', color: 'var(--muted-foreground, #888)' }, children: ex.token }) : null,
        ] }),
      ] }),
    ]
  }, ex.token || ex.name)
}

function ExplorationsView({ source, sources, onSelectItem }) {
  var all = (source.openspec && source.openspec.explorations) || []
  var [filter, setFilter] = React.useState('')
  var rows = sortExplorations(filterExplorations(all, filter))

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', overflow: 'hidden', minWidth: 0, minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 4px', flexShrink: 0 }, children: [
      jsx('span', { style: { display: 'inline-flex', alignItems: 'center', color: 'var(--muted-foreground, #888)', lineHeight: 1 }, title: 'Filter', 'aria-label': 'Filter', children: jsx(Codicon, { name: 'filter', size: '0.85rem' }) }),
      jsx(Input, { placeholder: 'title, scope, or token...', value: filter, onChange: function(e) { setFilter(e.target.value) }, style: { flex: 1 } }),
    ] }),
    all.length === 0
      ? jsx(EmptyState, { title: 'No explorations', description: 'No files under openspec/workspace/explorations or a change explorations folder.' })
      : jsx('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }, children: rows.map(function(ex) {
          return renderExplorationRow(ex, source, sources, all, onSelectItem)
        }) }),
  ] })
}

var SELECT_STYLE = { padding: '4px 8px', borderRadius: '4px', border: BORDER_SUBTLE, background: 'var(--ui-bg-quinary, transparent)', color: 'var(--foreground, inherit)', maxWidth: '100%' }

// Scope badge; for change-scoped explorations with a navigation handler it becomes a clickable "Change: <slug>" link.
function renderScopeBadge(scope, onOpenChange) {
  var badge = jsx(Badge, { variant: 'outline', style: { fontSize: '10px' }, children: explorationScopeLabel(scope) })
  var slug = changeSlugFromScope(scope)
  if (!slug || typeof onOpenChange !== 'function') return badge
  var open = function() { onOpenChange(slug) }
  return jsx('span', {
    role: 'button',
    tabIndex: 0,
    'data-change-link': slug,
    title: 'Open change ' + slug,
    onClick: open,
    onKeyDown: function(e) { handleActivateKey(e, open) },
    style: { cursor: 'pointer' },
    children: badge
  })
}

// Inline Explorations tab for ChangeDetailDrawer: dropdown when N > 1, direct selection when N === 1.
function ChangeExplorationsView({ api, sourceId, explorations, source, allSources, allItems, ctx, defaultIndex }) {
  var list = sortExplorations(explorations || [])
  var [selectedIdx, setSelectedIdx] = React.useState(defaultIndex || 0)
  if (list.length === 0) return jsx(EmptyState, { title: 'No explorations', description: 'This change has no explorations.' })
  var idx = Math.min(Math.max(selectedIdx || 0, 0), list.length - 1)
  var ex = list[idx]
  var itemRef = buildItemReference(source, ex, allSources)
  var canCopy = !!itemRef && hasUniqueItemToken(ex, allItems)
  var pooled = (allItems || []).find(function(x) { return x && ex.token && x.token === ex.token })
  var cards = crewCardsFor(ex)
  if (cards.length === 0 && pooled) cards = crewCardsFor(pooled)
  var key = ex.token || ex.name

  return jsxs('div', { 'data-selectable-text': 'true', style: { padding: '12px', minWidth: 0 }, children: [
    list.length > 1 ? jsx('div', { style: { marginBottom: '8px' }, children: jsx('select', {
      'data-exploration-select': 'true',
      value: idx,
      onChange: function(e) { setSelectedIdx(parseInt(e.target.value, 10)) },
      style: SELECT_STYLE,
      children: list.map(function(x, i) { return jsx('option', { value: i, children: x.title || x.name || ('Exploration ' + (i + 1)) }, i) })
    }) }) : null,
    jsxs('div', { 'data-exploration-meta': 'true', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0, marginBottom: '8px' }, children: [
      ex.date ? jsx('span', { style: { fontSize: '11px', color: 'var(--muted-foreground, #888)', whiteSpace: 'nowrap', flexShrink: 0 }, children: ex.date }) : null,
      jsx(Badge, { variant: 'outline', title: explorationScopeLabel(ex.scope), style: { fontSize: '10px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }, children: explorationScopeLabel(ex.scope) }),
      jsx('span', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted-foreground, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, children: ex.filename || '' }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexShrink: 0 }, children: [
        canCopy ? jsx(CopyButton, { appearance: 'icon', text: itemRef, label: 'Copy item reference', title: itemRef }) : null,
        ex.token ? jsx('span', { style: { fontFamily: 'monospace', fontSize: '10px', color: 'var(--muted-foreground, #888)' }, children: ex.token }) : null,
      ] }),
    ] }),
    jsx(CrewCardChips, { cards: cards, ctx: ctx }),
    jsx(ExplorationBody, { api: api, sourceId: sourceId, exploration: ex, ctx: ctx, inline: true }, key),
  ] })
}

function ExplorationBody({ api, sourceId, exploration, ctx, inline, onOpenChange }) {
  var query = useQuery({
    queryKey: ['openspec', 'exploration', sourceId, exploration.scope || 'workspace', exploration.name],
    queryFn: function() { return api.exploration(sourceId, exploration.name, exploration.scope) }
  })
  if (query.isLoading) return jsx(Loader, { type: 'lemniscate-bloom' })
  if (query.error) return jsx(RetryErrorState, { title: 'Failed to load exploration', description: query.error.message, onRetry: function() { query.refetch() } })

  var data = query.data || {}
  var scope = data.scope || exploration.scope
  var date = data.date || exploration.date
  var path = data.path || exploration.path
  var cards = crewCardsFor(data)
  if (cards.length === 0) cards = crewCardsFor(exploration)

  // Inline in the change drawer: ChangeExplorationsView already renders the metadata row and Crew chips.
  if (inline) return jsx(MarkdownView, { content: stripFrontmatter(data.content || '') })

  return jsxs('div', { children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px', flexWrap: 'wrap' }, children: [
      renderScopeBadge(scope, onOpenChange),
      date ? jsx('span', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)' }, children: date }) : null,
      path ? jsx(CopyButton, { appearance: 'icon', text: path, label: 'Copy file path', title: path }) : null,
    ] }),
    jsx(CrewCardChips, { cards: cards, ctx: ctx }),
    jsx(MarkdownView, { content: stripFrontmatter(data.content || '') }),
  ] })
}

function ExplorationDetailDrawer({ api, sourceId, exploration, source, allSources, allItems, ctx, width, onWidthChange, onBackToChange, onClose }) {
  var itemRef = buildItemReference(source, exploration, allSources)
  var canCopy = !!itemRef && hasUniqueItemToken(exploration, allItems)
  var changeSlug = changeSlugFromScope(exploration.scope)
  var canGoBack = !!changeSlug && typeof onBackToChange === 'function'
  return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange,
    title: exploration.title || exploration.name || 'Untitled exploration',
    secondary: exploration.filename || '',
    itemRef: itemRef,
    canCopy: canCopy,
    token: exploration.token || exploration.name || '',
    onClose: onClose,
    children: jsxs('div', { children: [
      canGoBack ? jsx('button', {
        type: 'button',
        'data-back-to-change': changeSlug,
        onClick: function() { onBackToChange(changeSlug) },
        style: { background: 'none', border: 'none', padding: '4px 12px', cursor: 'pointer', fontSize: '12px', color: semanticText(TOKEN_ACCENT) },
        children: '\u2190 Back to ' + changeSlug
      }) : null,
      jsx(ExplorationBody, { api: api, sourceId: sourceId, exploration: exploration, ctx: ctx, onOpenChange: canGoBack ? onBackToChange : undefined }),
    ] })
  })
}

function reviewOptionLabel(review) {
  return '[' + (review.verdict || 'PENDING') + '] ' + review.name + (review.round != null ? ' \u00b7 Round ' + review.round : '')
}

function ReviewsView({ reviews }) {
  var list = Array.isArray(reviews) ? reviews : []
  var [selected, setSelected] = React.useState(list.length - 1)
  if (list.length === 0) return jsx(EmptyState, { title: 'No reviews', description: 'This change has no review findings.' })
  var idx = Math.min(Math.max(selected, 0), list.length - 1)
  var current = list[idx]

  return jsxs('div', { 'data-selectable-text': 'true', style: { padding: '12px', minWidth: 0 }, children: [
    list.length > 1 ? jsx('div', { style: { marginBottom: '8px' }, children: jsx('select', {
      'data-review-select': 'true',
      value: idx,
      onChange: function(e) { setSelected(parseInt(e.target.value, 10)) },
      style: SELECT_STYLE,
      children: list.map(function(review, i) {
        return jsx('option', { value: i, 'data-review-item': review.token || review.name, children: reviewOptionLabel(review) }, review.token || review.name)
      })
    }) }) : null,
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0, marginBottom: '8px' }, children: [
      jsx(Badge, { variant: 'outline', style: { fontSize: '10px', color: verdictTone(current.verdict) }, children: current.verdict || 'PENDING' }),
      jsx('span', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted-foreground, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, children: current.filename || '' }),
      current.round != null ? jsx('span', { style: { fontSize: '11px', color: 'var(--muted-foreground, #888)' }, children: 'Round ' + current.round }) : null,
    ] }),
    jsx(MarkdownView, { content: stripFrontmatter(current.content || '') }),
  ] })
}

function CrewCardChips({ cards, ctx, defaultOpen, defaultFilter }) {
  var list = Array.isArray(cards) ? cards : []
  var grouped = groupCrewCardsByStatus(list)
  var _open = React.useState(defaultOpen != null ? !!defaultOpen : grouped.total <= CREW_INLINE_LIMIT)
  var _filter = React.useState(defaultFilter || null)
  var open = _open[0], setOpen = _open[1]
  var filter = _filter[0], setFilter = _filter[1]
  if (grouped.total === 0) return null

  var GLYPH = { running: '\u25cf', review: '\u25d0', blocked: '!', queued: '\u25cb', done: '\u2713' }
  var tickets = []
  for (var bi = 0; bi < CREW_BUCKETS.length; bi++) {
    if (filter && filter !== CREW_BUCKETS[bi]) continue
    tickets = tickets.concat(grouped[CREW_BUCKETS[bi]])
  }
  var showList = open || !!filter

  var summary = jsxs('div', { 'data-crew-summary': 'true', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 12px' }, children: [
    jsx('span', { style: { fontSize: '11px', fontWeight: 600, color: 'var(--muted-foreground, #888)' }, children: 'Crew' }),
    CREW_BUCKETS.filter(function(k) { return grouped[k].length > 0 }).map(function(k) {
      return jsx('button', {
        type: 'button',
        'data-crew-filter': k,
        'aria-pressed': filter === k,
        onClick: function() { setFilter(filter === k ? null : k); if (filter !== k) setOpen(true) },
        className: cn('rounded-md border px-2 py-0.5 cursor-pointer bg-transparent', filter === k ? 'border-(--ui-focus-border)' : 'border-(--ui-stroke-tertiary)'),
        style: { fontSize: '11px', color: 'var(--foreground, inherit)', whiteSpace: 'nowrap' },
        children: GLYPH[k] + ' ' + grouped[k].length + ' ' + k
      }, k)
    }),
    jsx('button', {
      type: 'button',
      'data-crew-toggle': 'true',
      onClick: function() { if (showList) { setOpen(false); setFilter(null) } else { setOpen(true) } },
      className: 'bg-transparent border-0 cursor-pointer',
      style: { marginLeft: 'auto', fontSize: '11px', color: 'var(--muted-foreground, #888)' },
      children: showList ? '\u25b4 Hide' : '\u25be ' + grouped.total + ' tickets'
    }),
  ] })

  var rows = !showList ? null : jsx('div', { 'data-crew-list': 'true', style: { maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 12px' }, children: tickets.map(function(card) {
    var go = function() { return navigateToCrewCard(ctx, card.url) }
    var detail = [card.title, card.assignee, card.board].filter(Boolean).join(' \u00b7 ')
    return jsxs('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }, children: [
      jsx('span', {
        'data-crew-card': card.id,
        role: 'button',
        tabIndex: 0,
        title: detail,
        onClick: go,
        onKeyDown: function(e) { handleActivateKey(e, go) },
        className: cn('rounded-md border border-(--ui-stroke-tertiary) px-2 py-0.5 cursor-pointer hover:border-(--ui-focus-border)'),
        style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--foreground, inherit)', flexShrink: 0 },
        children: card.id + ' ' + (card.status || '')
      }),
      jsx('span', { style: { fontSize: '11px', color: 'var(--muted-foreground, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, children: [card.title, card.assignee ? '@' + card.assignee : null].filter(Boolean).join(' \u00b7 ') }),
      jsx(CopyButton, { appearance: 'icon', text: card.id, label: 'Copy card id', title: card.id }),
    ] }, card.id)
  }) })

  return jsxs('div', { 'data-crew-chips': 'true', children: [summary, rows] })
}

function DiscoverControl({ api, sourceId, onRegistered }) {
  var [open, setOpen] = React.useState(false)
  var [busy, setBusy] = React.useState(false)
  var [result, setResult] = React.useState(null)
  var [error, setError] = React.useState('')

  function run(register) {
    setBusy(true); setError('')
    return api.discoverSources(sourceId, register).then(function(res) {
      setBusy(false); setResult(res)
      if (register && onRegistered) onRegistered(res)
    }).catch(function(e) {
      setBusy(false); setError(extractApiError(e))
    })
  }
  function openAndPreview() { setOpen(true); setResult(null); run(false) }

  var candidates = (result && result.candidates) || []
  var fresh = candidates.filter(function(c) { return !c.alreadyRegistered })

  return jsxs('span', { style: { display: 'inline-flex' }, children: [
    jsx(Button, { variant: 'ghost', size: 'sm', style: { padding: '2px 6px', fontSize: '11px', minWidth: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }, title: 'Discover OpenSpec repositories under this source', 'aria-label': 'Discover sources', onClick: openAndPreview, children: 'Discover' }),
    open ? jsx(Dialog, { open: true, onOpenChange: function() { if (!busy) setOpen(false) }, children: jsxs(DialogContent, { style: { padding: '16px', maxWidth: '520px' }, children: [
      jsx('h2', { style: { fontSize: '16px', fontWeight: 600, margin: '0 0 12px', color: 'var(--foreground, inherit)' }, children: 'Discover OpenSpec sources' }),
      busy && !result ? jsx(Loader, { type: 'lemniscate-bloom' }) : null,
      error ? jsx('div', { style: { padding: '8px 12px', background: BANNER_ERROR, borderRadius: '4px', fontSize: '12px', color: 'var(--foreground, inherit)', marginBottom: '12px' }, children: error }) : null,
      result && candidates.length === 0 ? jsx(EmptyState, { title: 'Nothing found', description: 'No child repositories with an openspec/ folder were found.' }) : null,
      candidates.length > 0 ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px', maxHeight: '260px', overflowY: 'auto' }, children: candidates.map(function(c) {
        return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [
          jsx('span', { style: { fontWeight: 500, fontSize: '12px', color: 'var(--foreground, inherit)' }, children: c.name }),
          jsx('span', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted-foreground, #888)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: c.path, children: c.path }),
          c.alreadyRegistered ? jsx(Badge, { variant: 'outline', style: { fontSize: '10px' }, children: 'registered' }) : null,
        ] }, c.path)
      }) }) : null,
      jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, children: [
        jsx(Button, { variant: 'outline', size: 'sm', onClick: function() { setOpen(false) }, disabled: busy, children: 'Close' }),
        jsx(Button, { size: 'sm', onClick: function() { run(true) }, disabled: busy || fresh.length === 0, children: busy ? 'Working...' : 'Register ' + fresh.length + ' new' }),
      ] }),
    ] }) }) : null,
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task view
// ═══════════════════════════════════════════════════════════════════════════════

function TaskView({ content }) {
  var parsed = parseTasks(content)
  return jsxs('div', { 'data-selectable-text': 'true', style: { padding: '12px' }, children: [
    jsxs('div', { style: { marginBottom: '12px', color: 'var(--muted-foreground, #888)', fontSize: '13px' }, children: [
      parsed.done + ' of ' + parsed.total + ' tasks completed',
    ] }),
    parsed.sections.map(function(section, i) {
      return jsxs('div', { style: { marginBottom: '12px' }, children: [
        jsx('div', { style: { fontWeight: 600, fontSize: '14px', marginBottom: '4px', color: 'var(--foreground, inherit)' }, children: section.title }),
        section.tasks.map(function(task, j) {
          return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', color: 'var(--foreground, inherit)' }, children: [
            jsx('span', { 'data-task-state': task.done ? 'done' : 'open', style: { color: task.done ? semanticText(TOKEN_SUCCESS) : 'var(--muted-foreground, inherit)' }, children: task.done ? '\u2611' : '\u2610' }),
            jsx('span', { style: { fontSize: '13px', textDecoration: task.done ? 'line-through' : 'none', opacity: task.done ? 0.6 : 1 }, children: task.text }),
          ] }, j)
        }),
      ] }, i)
    }),
    parsed.sections.length === 0 ? jsx(MarkdownView, { content: content }) : null,
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Idea detail drawer
// ═══════════════════════════════════════════════════════════════════════════════

function IdeaDetailDrawer({ api, sourceId, idea, source, allSources, allItems, width, onWidthChange, onClose }) {
  var query = useQuery({
    queryKey: ['openspec', 'idea', sourceId, idea.name || idea.token],
    queryFn: function() { return api.idea(sourceId, idea.name || idea.token) }
  })

  var itemRef = buildItemReference(source, idea, allSources)
  var canCopy = !!itemRef && hasUniqueItemToken(idea, allItems)
  var title = query.data && query.data.title ? query.data.title : (idea.title || idea.name || 'Untitled idea')
  var secondary = ideaSecondaryName(query.data && query.data.name ? query.data.name : (idea.name || ''))
  var token = idea.token || idea.name || ''

  if (query.isLoading) return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange, title: title, secondary: secondary, itemRef: itemRef, canCopy: canCopy, token: token, onClose: onClose, children: jsx(Loader, { type: 'lemniscate-bloom' }) })
  if (query.error) return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange, title: title, secondary: secondary, itemRef: itemRef, canCopy: canCopy, token: token, onClose: onClose, children: jsx(RetryErrorState, { title: 'Failed to load idea', description: query.error.message, onRetry: function() { query.refetch() } }) })

  var data = query.data || {}

  // Reconcile title/secondary with canonical fallback helpers.
  title = detailTitle(data, idea, idea, 'idea')
  secondary = ideaSecondaryName(detailSecondaryName(data, idea))

  // Strip YAML frontmatter from content before rendering
  var content = data.content || ''
  var stripped = stripFrontmatter(content)

  return jsx(DetailDrawer, { width: width, onWidthChange: onWidthChange, title: title, secondary: secondary, itemRef: itemRef, canCopy: canCopy, token: token, onClose: onClose, children: jsx(MarkdownView, { content: stripped }) })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change spec detail — Proposed and Diff views
// ═══════════════════════════════════════════════════════════════════════════════

function DiffModePanel({ data }) {
  var [diffMode, setDiffMode] = React.useState('semantic')
  var effMode = effectiveDiffMode(diffMode, data)
  return jsxs('div', { children: [
    hasDiffMode(data, 'semantic') || hasDiffMode(data, 'split') || hasDiffMode(data, 'raw') ? jsxs('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px' }, children: [
      hasDiffMode(data, 'semantic') ? jsx(Button, { variant: effMode === 'semantic' ? 'default' : 'outline', size: 'sm', onClick: function() { setDiffMode('semantic') }, children: 'Semantic' }) : null,
      hasDiffMode(data, 'split') ? jsx(Button, { variant: effMode === 'split' ? 'default' : 'outline', size: 'sm', onClick: function() { setDiffMode('split') }, children: 'Side-by-side' }) : null,
      hasDiffMode(data, 'raw') ? jsx(Button, { variant: effMode === 'raw' ? 'default' : 'outline', size: 'sm', onClick: function() { setDiffMode('raw') }, children: 'Raw' }) : null,
    ] }) : null,
    effMode === 'semantic' && hasDiffMode(data, 'semantic') ? jsx(SemanticDiffView, { data: data.semantic_diff }) : null,
    effMode === 'split' && hasDiffMode(data, 'split') ? jsx(SplitDiffView, { before: data.before, after: data.after }) : null,
    effMode === 'raw' && hasDiffMode(data, 'raw') ? jsx(RawDiffView, { diff: data.diff || data.raw_diff }) : null,
  ] })
}

function SpecsDetailView({ specs }) {
  var [selectedIdx, setSelectedIdx] = React.useState(0)

  if (!specs || specs.length === 0) return jsx(EmptyState, { title: 'No specs', description: 'No spec changes in this change.' })
  var spec = specs[selectedIdx] || specs[0]

  return jsxs('div', { 'data-selectable-text': 'true', style: { padding: '12px' }, children: [
    specs.length > 1 ? jsxs('div', { style: { marginBottom: '8px' }, children: [
      jsx('select', {
        value: selectedIdx,
        onChange: function(e) { setSelectedIdx(parseInt(e.target.value, 10)) },
        style: { padding: '4px 8px', borderRadius: '4px', border: BORDER_SUBTLE, background: 'var(--ui-bg-quinary, transparent)', color: 'var(--foreground, inherit)' },
        children: specs.map(function(s, i) { return jsx('option', { value: i, children: s.path || s.title || ('Spec ' + (i + 1)) }, i) })
      })
    ] }) : null,
    spec.path ? jsx('div', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', marginBottom: '8px', fontFamily: 'monospace' }, children: spec.path }) : null,
    spec.status ? jsx(Badge, { variant: 'outline', style: { marginBottom: '8px' }, children: spec.status }) : null,
    jsx(DiffModePanel, { data: spec }),
    spec.content ? jsx(StructuredSpecView, { content: spec.content }, spec.path || selectedIdx) : null,
  ] })
}

// Highlights RFC 2119 keywords inside a requirement or scenario sentence.
var SPEC_KEYWORD_RE = /\b(SHALL NOT|MUST NOT|SHOULD NOT|SHALL|MUST|SHOULD)\b/g

function renderSpecKeywords(text) {
  var parts = []
  var src = String(text || '')
  var last = 0
  var m
  SPEC_KEYWORD_RE.lastIndex = 0
  while ((m = SPEC_KEYWORD_RE.exec(src)) !== null) {
    if (m.index > last) parts.push(src.slice(last, m.index))
    parts.push(jsx('strong', { 'data-spec-keyword': m[1], style: { fontWeight: 700, color: semanticText(m[1].indexOf('NOT') >= 0 ? TOKEN_DANGER : TOKEN_ACCENT) }, children: m[1] }, 'kw' + m.index))
    last = m.index + m[0].length
  }
  if (last < src.length) parts.push(src.slice(last))
  return parts
}

var STEP_TONES = { WHEN: TOKEN_ACCENT, THEN: TOKEN_SUCCESS, AND: 'var(--muted-foreground, #888)', GIVEN: TOKEN_WARNING }

// Shared by SpecsView and the change drawer Specs tab: Purpose callout, R1..Rn requirement cards, WHEN/THEN/AND steps.
function StructuredSpecView({ content, defaultMode, defaultFilter }) {
  var [mode, setMode] = React.useState(defaultMode || 'structured')
  var [filter, setFilter] = React.useState(defaultFilter || '')
  var md = stripFrontmatter(content || '') || ''
  var parsed = parseSpec(md)
  if (parsed.requirements.length === 0) return jsx(MarkdownView, { content: md })

  var visible = filterSpecRequirements(parsed.requirements, filter)
  var toggle = jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }, children: [
    jsx(Button, { variant: mode === 'structured' ? 'default' : 'outline', size: 'sm', 'data-spec-mode': 'structured', onClick: function() { setMode('structured') }, children: 'Structured' }),
    jsx(Button, { variant: mode === 'raw' ? 'default' : 'outline', size: 'sm', 'data-spec-mode': 'raw', onClick: function() { setMode('raw') }, children: 'Raw' }),
    mode === 'structured' ? jsx(Input, { placeholder: 'Filter requirements...', value: filter, onChange: function(e) { setFilter(e.target.value) }, style: { flex: 1, minWidth: '140px' } }) : null,
  ] })
  if (mode === 'raw') return jsxs('div', { children: [toggle, jsx(MarkdownView, { content: md })] })

  return jsxs('div', { 'data-structured-spec': 'true', style: { minWidth: 0 }, children: [
    toggle,
    parsed.purpose ? jsxs('div', { 'data-spec-purpose': 'true', style: { borderLeft: '3px solid ' + semanticTint(TOKEN_ACCENT, 70), background: semanticTint(TOKEN_ACCENT, 8), borderRadius: '0 4px 4px 0', padding: '6px 12px', marginBottom: '10px' }, children: [
      jsx('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground, #888)', marginBottom: '2px' }, children: 'Purpose' }),
      jsx('div', { style: { fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--foreground, inherit)' }, children: parsed.purpose }),
    ] }) : null,
    visible.length === 0 ? jsx('div', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', padding: '8px 0' }, children: 'No requirements match the filter.' }) : null,
    visible.map(function(entry) {
      var req = entry.req
      var num = 'R' + (entry.index + 1)
      return jsxs('div', { 'data-spec-req': num, style: { border: BORDER_SUBTLE, borderRadius: '6px', marginBottom: '10px', overflow: 'hidden' }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', background: SURFACE_CODE }, children: [
          jsx('span', { style: { fontFamily: 'monospace', fontSize: '11px', fontWeight: 700, color: semanticText(TOKEN_ACCENT), background: semanticTint(TOKEN_ACCENT, 14), borderRadius: '3px', padding: '1px 5px' }, children: num }),
          jsx('span', { style: { fontSize: '13px', fontWeight: 600, minWidth: 0, wordBreak: 'break-word', color: 'var(--foreground, inherit)' }, children: req.name }),
        ] }),
        req.description ? jsx('div', { style: { padding: '6px 10px', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--foreground, inherit)' }, children: renderSpecKeywords(req.description) }) : null,
        (req.scenarios || []).map(function(scn, si) {
          return jsxs('div', { style: { margin: '0 10px 8px', padding: '6px 8px', borderLeft: '2px solid ' + semanticTint(TOKEN_ACCENT, 50), background: SURFACE_CODE, borderRadius: '0 4px 4px 0' }, children: [
            jsx('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: 'var(--foreground, inherit)' }, children: scn.name }),
            (scn.steps || []).map(function(st, ti) {
              return jsxs('div', { 'data-spec-step': st.type, style: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '1px 0', fontSize: '12px', lineHeight: 1.4 }, children: [
                jsx('span', { style: { flexShrink: 0, minWidth: '40px', textAlign: 'right', fontFamily: 'monospace', fontSize: '10px', fontWeight: 700, color: semanticText(STEP_TONES[st.type] || STEP_TONES.AND) }, children: st.type }),
                jsx('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word', color: 'var(--foreground, inherit)' }, children: renderSpecKeywords(st.text) }),
              ] }, ti)
            }),
          ] }, si)
        }),
      ] }, num)
    }),
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Diff views
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeSemanticGroups(data) {
  if (!data) return []
  // Legacy flat groups array (data.groups)
  if (data.groups && Array.isArray(data.groups)) return data.groups
  // Backend contract: {status, requirements: {added, modified, removed, unchanged}}
  var reqs = data.requirements
  if (!reqs || typeof reqs !== 'object' || Array.isArray(reqs)) return []
  var items = []
  var added = reqs.added || []
  var modified = reqs.modified || []
  var removed = reqs.removed || []
  for (var i = 0; i < added.length; i++) {
    var a = added[i]
    items.push({ label: 'Added', name: a.name || '', description: a.description || '', color: TOKEN_SUCCESS })
  }
  for (var j = 0; j < modified.length; j++) {
    var m = modified[j]
    var beforeDesc = m.before && typeof m.before === 'object' ? (m.before.description || '') : String(m.before || '')
    var afterDesc = m.after && typeof m.after === 'object' ? (m.after.description || '') : String(m.after || '')
    items.push({ label: 'Modified', name: m.name || '', description: '', before: beforeDesc, after: afterDesc, color: TOKEN_WARNING })
  }
  for (var k = 0; k < removed.length; k++) {
    var r = removed[k]
    items.push({ label: 'Removed', name: r.name || '', description: r.description || '', color: TOKEN_DANGER })
  }
  return items
}

function SemanticDiffView({ data }) {
  if (!data) return null
  var items = normalizeSemanticGroups(data)
  return jsxs('div', { style: { padding: '8px' }, children: [
    jsx('div', { style: { fontWeight: 600, marginBottom: '8px', color: 'var(--foreground, inherit)' }, children: 'Semantic Changes' }),
    items.map(function(item, i) {
      return jsxs('div', { style: { marginBottom: '8px', padding: '8px', background: SURFACE_CODE, borderRadius: '4px', border: BORDER_SUBTLE }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }, children: [
          jsx('span', { style: { fontSize: '10px', fontWeight: 600, padding: '1px 5px', borderRadius: '3px', background: semanticTint(item.color, 22), color: 'var(--foreground, inherit)', border: '1px solid ' + semanticTint(item.color, 60) }, children: item.label }),
          item.name ? jsx('span', { style: { fontWeight: 500, color: 'var(--foreground, inherit)' }, children: item.name }) : null,
        ] }),
        item.description ? jsx('div', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', marginBottom: '2px' }, children: item.description }) : null,
        item.before != null && item.before !== '' ? jsx('div', { style: { color: semanticText(TOKEN_DANGER), background: semanticTint(TOKEN_DANGER, 10), fontSize: '12px', marginBottom: '2px', padding: '1px 4px', borderRadius: '2px' }, children: '- ' + item.before }) : null,
        item.after != null && item.after !== '' ? jsx('div', { style: { color: semanticText(TOKEN_SUCCESS), background: semanticTint(TOKEN_SUCCESS, 10), fontSize: '12px', padding: '1px 4px', borderRadius: '2px' }, children: '+ ' + item.after }) : null,
      ] }, i)
    }),
  ] })
}

function SplitDiffView({ before, after }) {
  return jsxs('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '8px' }, children: [
    jsxs('div', { children: [
      jsx('div', { style: { fontWeight: 500, marginBottom: '4px', color: 'var(--muted-foreground, #888)', fontSize: '12px' }, children: 'Before' }),
      jsx('pre', { style: { fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', padding: '8px', background: SURFACE_CODE, border: BORDER_SUBTLE, borderRadius: '4px', color: 'var(--foreground, inherit)', margin: 0 }, children: before || '' }),
    ] }),
    jsxs('div', { children: [
      jsx('div', { style: { fontWeight: 500, marginBottom: '4px', color: 'var(--muted-foreground, #888)', fontSize: '12px' }, children: 'After' }),
      jsx('pre', { style: { fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', padding: '8px', background: SURFACE_CODE, border: BORDER_SUBTLE, borderRadius: '4px', color: 'var(--foreground, inherit)', margin: 0 }, children: after || '' }),
    ] }),
  ] })
}

function RawDiffView({ diff }) {
  if (!diff) return null
  var lines = Array.isArray(diff) ? diff : String(diff).split('\n')
  return jsxs('pre', { style: { fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', padding: '8px', background: SURFACE_CODE, border: BORDER_SUBTLE, borderRadius: '4px', margin: 0 }, children: lines.map(function(line, i) {
    var cls = classifyDiffLine(line)
    return jsx('span', { 'data-diff-line': cls, style: diffLineStyle(cls), children: line + '\n' }, i)
  }) })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Work view
// ═══════════════════════════════════════════════════════════════════════════════

function WorkView({ api, source, sources, onSelectItem, showArchived, onToggleArchived }) {
  var ideas = (source.openspec && source.openspec.ideas) || []
  var changes = (source.openspec && source.openspec.changes) || []
  var allItems = ideas.map(function(idea) {
    return Object.assign({}, idea, { _type: 'idea' })
  }).concat(changes.map(function(change) {
    return Object.assign({}, change, { _type: 'change' })
  }))

  var [filter, setFilter] = React.useState('')
  var [manualOverrides, setManualOverrides] = React.useState({})
  var prevLanePhase = React.useRef(null)

  var filtered = filterItems(allItems, filter)
  var visibleStatuses = showArchived ? STATUS_ORDER : STATUS_ORDER.filter(function(s) { return s !== 'archived' })
  var grouped = groupByStatus(filtered, showArchived)
  var autoCollapsed = autoCollapseEmptyLanes(grouped, visibleStatuses)

  // Lane phase tracking — prune overrides when empty/full flips
  var lanePhase = computeLanePhase(grouped, visibleStatuses)
  React.useEffect(function() {
    if (lanePhase === null || lanePhase === prevLanePhase.current) return
    var prev = prevLanePhase.current
    prevLanePhase.current = lanePhase
    if (prev === null) return
    setManualOverrides(function(prevOverrides) {
      return pruneStaleOverrides(prevOverrides, prev, lanePhase)
    })
  }, [lanePhase])

  var collapsedSet = computeCollapsedSet(autoCollapsed, manualOverrides, visibleStatuses)

  function toggleCollapse(status) {
    setManualOverrides(function(prev) {
      return toggleOverride(prev, status, autoCollapsed)
    })
  }

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', overflow: 'hidden', minWidth: 0, minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 4px', flexShrink: 0 }, children: [
      jsx('span', { style: { display: 'inline-flex', alignItems: 'center', color: 'var(--muted-foreground, #888)', lineHeight: 1 }, title: 'Filter', 'aria-label': 'Filter', children: jsx(Codicon, { name: 'filter', size: '0.85rem' }) }),
      jsx(Input, { placeholder: 'title, token, or name...', value: filter, onChange: function(e) { setFilter(e.target.value) }, style: { flex: 1 } }),
      jsx(Button, { variant: 'outline', size: 'sm', type: 'button', 'aria-pressed': showArchived, style: { backgroundColor: showArchived ? 'var(--ui-control-active-background)' : undefined }, onClick: function() { onToggleArchived(!showArchived) }, children: [showArchived ? '\u2713' : null, ' ', 'Archived'] }),
    ] }),
    jsx('div', { style: { display: 'flex', gap: '8px', flex: 1, overflowX: 'auto', overflowY: 'hidden', minWidth: 0, minHeight: 0, paddingBottom: '8px' }, children: visibleStatuses.map(function(status) {
      var items = grouped[status] || []
      return jsx(BoardColumn, {
        status: status,
        items: items,
        source: source,
        allSources: sources,
        allItems: allItems,
        onSelect: onSelectItem,
        collapsed: !!collapsedSet[status],
        onExpand: function() { toggleCollapse(status) },
      }, status)
    }) }),
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Specs view
// ═══════════════════════════════════════════════════════════════════════════════

function SpecsView({ api, sourceId, ctx }) {
  var [worktree, setWorktree] = React.useState(false)
  var [sidebarWidth, setSidebarWidth] = React.useState(readStoredWidth(ctx, 'specsSidebarWidth', clampSpecsSidebarWidth))
  var [specFilter, setSpecFilter] = React.useState('')

  var query = useQuery({
    queryKey: ['openspec', 'spec-browser', sourceId, worktree],
    queryFn: function() { return api.specBrowser(sourceId, { dirty: worktree }) },
  })

  var [selectedFile, setSelectedFile] = React.useState(null)

  // Reset selected file when source changes — component remounts via key prop
  React.useEffect(function() {
    setSelectedFile(null)
  }, [sourceId])

  // Gate spec query on file selection
  var specQuery = useQuery({
    queryKey: ['openspec', 'spec', sourceId, selectedFile],
    queryFn: function() { return api.spec(sourceId, selectedFile) },
    enabled: !!selectedFile && !worktree,
  })

  var files = (query.data && query.data.files) || []
  var visibleFiles = filterSpecFiles(files, specFilter)
  var branch = query.data && query.data.branch
  var changedCount = query.data && query.data.changedCount != null ? query.data.changedCount : files.length

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 4px' }, children: [
      jsx(Button, { variant: worktree ? 'outline' : 'default', size: 'sm', onClick: function() { setWorktree(false); setSelectedFile(null) }, children: 'Current' }),
      jsx(Button, { variant: worktree ? 'default' : 'outline', size: 'sm', onClick: function() { setWorktree(true); setSelectedFile(null) }, children: 'Worktree' }),
      branch ? jsx('span', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)' }, children: branch }) : null,
      worktree ? jsx(Badge, { variant: 'outline', children: changedCount + ' changed' }) : null,
    ] }),
    query.isLoading ? jsx(Loader, { type: 'lemniscate-bloom' }) : null,
    query.error ? jsx(RetryErrorState, { title: 'Failed to load specs', description: query.error.message, onRetry: function() { query.refetch() } }) : null,
    !query.isLoading && !query.error && files.length === 0 ? jsx(EmptyState, {
      title: worktree ? 'No spec changes between HEAD and worktree' : 'No specs found',
      description: worktree ? 'The working tree matches HEAD for all spec files.' : 'No spec files are registered for this source.',
    }) : null,
    !query.isLoading && files.length > 0 ? jsxs('div', { style: { display: 'flex', gap: '12px', flex: 1, overflow: 'hidden' }, children: [
      jsxs('div', { 'data-specs-sidebar': 'true', style: { width: sidebarWidth + 'px', flexShrink: 0, overflow: 'auto' }, children: [
        jsx(Input, { 'data-specs-filter': 'true', placeholder: 'Filter specs...', value: specFilter, onChange: function(e) { setSpecFilter(e.target.value) }, style: { width: '100%', marginBottom: '6px' } }),
        visibleFiles.length === 0 ? jsx('div', { style: { fontSize: '12px', color: 'var(--muted-foreground, #888)', padding: '8px 12px' }, children: 'No specs match the filter.' }) : null,
        visibleFiles.map(function(file) {
          var path = file.path || file.name || file
          var isSelected = selectedFile === path
          var purposeLine = String(file.purpose || '').split('\n')[0]
          var counts = specCountsLabel(file)
          var showTitle = file.title && file.title !== path
          return jsxs('div', {
            'data-spec-card': path,
            className: cn(
              'px-3 py-2 cursor-pointer text-sm rounded-md',
              isSelected ? 'bg-(--ui-control-active-background) text-foreground font-medium' : 'text-muted-foreground hover:bg-(--ui-control-hover-background) hover:text-foreground'
            ),
            style: { minWidth: 0 },
            role: 'button',
            tabIndex: 0,
            onClick: function() { setSelectedFile(path) },
            onKeyDown: function(e) { handleActivateKey(e, function() { setSelectedFile(path) }) },
            children: [
              jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }, children: [
                jsx('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '13px', color: 'var(--foreground, inherit)' }, title: showTitle ? file.title : path, children: showTitle ? file.title : path }),
                specStatusBadgeVisible(file.status) ? jsx(Badge, { variant: 'outline', style: { fontSize: '10px', flexShrink: 0 }, children: file.status }) : null,
              ] }),
              showTitle ? jsx('div', { style: { fontFamily: 'monospace', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: path, children: path }) : null,
              purposeLine ? jsx('div', { 'data-spec-card-purpose': 'true', title: purposeLine, style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }, children: purposeLine }) : null,
              counts ? jsx('div', { 'data-spec-card-counts': 'true', style: { fontFamily: 'monospace', fontSize: '10px', marginTop: '2px', opacity: 0.8 }, children: counts }) : null,
            ]
          }, path)
        }),
      ] }),
      jsx('div', {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': 'Resize specs sidebar',
        'aria-valuenow': sidebarWidth,
        'aria-valuemin': SPECS_SIDEBAR_MIN,
        'aria-valuemax': SPECS_SIDEBAR_MAX,
        'data-specs-resize-handle': 'true',
        tabIndex: 0,
        title: 'Drag to resize (double-click to reset)',
        onPointerDown: function(e) {
          beginResize(e, sidebarWidth, 1, clampSpecsSidebarWidth,
            function(w) { setSidebarWidth(w) },
            function(w) { setSidebarWidth(w); writeStoredWidth(ctx, 'specsSidebarWidth', w) })
        },
        onDoubleClick: function() { setSidebarWidth(SPECS_SIDEBAR_DEFAULT); writeStoredWidth(ctx, 'specsSidebarWidth', SPECS_SIDEBAR_DEFAULT) },
        onKeyDown: function(e) {
          var step = e && e.key === 'ArrowRight' ? 24 : (e && e.key === 'ArrowLeft' ? -24 : 0)
          if (!step) return
          if (typeof e.preventDefault === 'function') e.preventDefault()
          var w = clampSpecsSidebarWidth(sidebarWidth + step)
          setSidebarWidth(w); writeStoredWidth(ctx, 'specsSidebarWidth', w)
        },
        style: { width: '6px', flexShrink: 0, cursor: 'col-resize', alignSelf: 'stretch', touchAction: 'none', marginLeft: '-9px', marginRight: '-9px', zIndex: 1 }
      }),
      jsxs('div', { style: { flex: 1, overflow: 'auto' }, children: [
        worktree && selectedFile ? jsx(WorktreeDetailView, { sourceId: sourceId, file: selectedFile, files: files }) : null,
        !worktree && selectedFile && specQuery.isLoading ? jsx(Loader, { type: 'lemniscate-bloom' }) : null,
        !worktree && selectedFile && specQuery.error ? jsx(RetryErrorState, { title: 'Failed to load spec', description: specQuery.error.message, onRetry: function() { specQuery.refetch() } }) : null,
        !worktree && selectedFile && !specQuery.isLoading && !specQuery.error ? jsx(StructuredSpecView, { content: specQuery.data && specQuery.data.content }, selectedFile) : null,
        !selectedFile ? jsx(EmptyState, { title: 'Select a file', description: 'Choose a spec file from the list to view its content.' }) : null,
      ] }),
    ] }) : null,
  ] })
}

function WorktreeDetailView({ sourceId, file, files }) {
  var fileInfo = files.find(function(f) { return (f.path || f.name || f) === file }) || {}

  var data = fileInfo

  return jsxs('div', { style: { padding: '12px' }, children: [
    jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }, children: [
      jsx('h3', { style: { fontSize: '14px', fontWeight: 500, margin: 0, color: 'var(--foreground, inherit)' }, children: file }),
      fileInfo.status ? jsx(Badge, { variant: 'outline', children: fileInfo.status }) : null,
    ] }),
    jsx(DiffModePanel, { data: data }),
    !hasDiffMode(data, 'semantic') && !hasDiffMode(data, 'split') && !hasDiffMode(data, 'raw') && data.content ? jsx(MarkdownView, { content: stripFrontmatter(data.content) }) : null,
    !hasDiffMode(data, 'semantic') && !hasDiffMode(data, 'split') && !hasDiffMode(data, 'raw') && !data.content ? jsx(EmptyState, { title: 'No diff data', description: 'No diff representation available for this file.' }) : null,
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════════

function OpenSpecPage({ api, sessionStore, ctx }) {
  var sourcesQuery = useQuery({
    queryKey: ['openspec', 'sources'],
    queryFn: function() { return api.sources() },
    refetchInterval: POLL_INTERVAL_MS,
  })

  var [selectedSourceId, setSelectedSourceId] = React.useState(sessionStore ? sessionStore.selectedSourceId : null)
  var [view, setView] = React.useState('work')
  var [showArchived, setShowArchived] = React.useState(sessionStore ? sessionStore.showArchived : true)
  var [selectedItem, setSelectedItem] = React.useState(null) // {item, sourceId, type}
  var [sourceDialog, setSourceDialog] = React.useState(null) // {mode: 'add'|'edit'} or null
  var [removeConfirm, setRemoveConfirm] = React.useState(null) // source object or null
  var [removeBusy, setRemoveBusy] = React.useState(false)
  var [removeError, setRemoveError] = React.useState('')
  var [initBusy, setInitBusy] = React.useState(false)
  var [initError, setInitError] = React.useState('')
  var [drawerWidth, setDrawerWidth] = React.useState(readStoredWidth(ctx, 'drawerWidth', clampDrawerWidth))

  // Entering via the full-page `#/openspec` hash route would hide the workspace tab bar and drop the
  // tab on the next switch: re-enter through the router so /openspec docks as a persistent route tile.
  React.useEffect(function() {
    if (typeof window === 'undefined') return
    var hash = String((window.location && window.location.hash) || '')
    if (hash.indexOf('#/openspec') === 0) navigateToCrewCard(ctx, '/openspec')
  }, [])

  // Back from an exploration drawer to its owning change drawer, landing on the Explorations tab.
  function handleBackToChange(slug) {
    var changes = (selectedSource && selectedSource.openspec && selectedSource.openspec.changes) || []
    var found = changes.find(function(c) { return c.name === slug || c.token === slug })
    var item = Object.assign({}, found || { name: slug, title: slug }, { _type: 'change' })
    setSelectedItem({ item: item, sourceId: selectedSourceId, type: 'change', initialTab: 'explorations' })
  }

  function handleDrawerWidth(w, commit) {
    setDrawerWidth(w)
    if (commit) writeStoredWidth(ctx, 'drawerWidth', w)
  }

  // Resolve selection after refreshed /sources data: restore the retained source
  // while its ID remains present (including invalid sources), otherwise fall back
  // to first-valid / first-returned; update the registration-scope store both ways.
  // The effect is gated on data arrival: during the loading window
  // sourcesQuery.data is still undefined, and resolving against the pre-data
  // empty list would wipe a retained selection (both React state and the
  // registration-scope store) before refreshed /sources data ever arrives. The
  // retained ID survives the loading render, so resolution — and the null rule
  // for genuinely empty results — only ever runs against the refreshed list.
  var sources = (sourcesQuery.data && sourcesQuery.data.sources) || []
  var previousResolvedInvalid = React.useRef(false)
  // The status bar chip selects a source through the store (possibly one it just registered): follow it.
  React.useEffect(function() {
    if (!sessionStore || typeof sessionStore.subscribe !== 'function') return undefined
    return sessionStore.subscribe(function(id) { setSelectedSourceId(id) })
  }, [sessionStore])
  React.useEffect(function() {
    if (sourcesQuery.data === undefined) return
    if (sessionStore && sessionStore.pendingSourceId != null) {
      var pendingId = sessionStore.pendingSourceId
      var known = sources.some(function(s) { return s.id === pendingId })
      sessionStore.pendingSourceId = null
      // Just-registered source missing from the cached list: refetch once instead of falling back.
      if (!known && pendingId === selectedSourceId && typeof sourcesQuery.refetch === 'function') {
        sourcesQuery.refetch()
        return
      }
    }
    var next = resolveRetainedSource(sources, selectedSourceId)
    var resolved = sources.find(function(s) { return s.id === next }) || null
    var resolvedInvalid = resolved && resolved.valid === false
    if (next === selectedSourceId) {
      if (resolvedInvalid && !previousResolvedInvalid.current) {
        setSelectedItem(null)
      }
      previousResolvedInvalid.current = !!resolvedInvalid
      if (sessionStore && next !== null) sessionStore.selectedSourceId = next
      return
    }
    setSelectedSourceId(next)
    setSelectedItem(null)
    previousResolvedInvalid.current = !!resolvedInvalid
    if (sessionStore) sessionStore.selectedSourceId = next
  }, [sources, sourcesQuery.data, selectedSourceId])

  // Close detail on explicit source change by user
  React.useEffect(function() {
    setSelectedItem(null)
  }, [selectedSourceId])

  var selectedSource = sources.find(function(s) { return s.id === selectedSourceId }) || null
  var sourceRef = buildSourceReference(selectedSource, sources)
  var allItems = []
  if (selectedSource && selectedSource.openspec) {
    var loadedIdeas = selectedSource.openspec.ideas || []
    var loadedChanges = selectedSource.openspec.changes || []
    allItems = loadedIdeas.map(function(idea) {
      return Object.assign({}, idea, { _type: 'idea' })
    }).concat(loadedChanges.map(function(change) {
      return Object.assign({}, change, { _type: 'change' })
    }))
  }

  function handleSelectSource(v) {
    setSelectedSourceId(v)
    if (sessionStore) sessionStore.selectedSourceId = v
  }
  function handleToggleArchived(v) {
    setShowArchived(v)
    if (sessionStore) sessionStore.showArchived = v
  }

  if (sourcesQuery.isLoading) return jsx(Loader, { type: 'lemniscate-bloom' })
  if (sourcesQuery.error) return jsx(RetryErrorState, { title: 'Failed to load sources', description: sourcesQuery.error.message, onRetry: function() { sourcesQuery.refetch() } })

  var onSelectItem = function(item) {
    setSelectedItem({ item: item, sourceId: selectedSourceId, type: item._type || 'change' })
  }

  function handleAddSource() { setSourceDialog({ mode: 'add' }) }
  function handleEditSource() { if (selectedSource) setSourceDialog({ mode: 'edit' }) }
  function handleInitSource() {
    if (!selectedSource || initBusy) return
    setInitBusy(true); setInitError('')
    api.initSource(selectedSource.id).then(function() {
      setInitBusy(false)
      sourcesQuery.refetch()
    }).catch(function(e) {
      setInitBusy(false)
      setInitError(extractApiError(e))
    })
  }
  function handleRemoveSource() {
    if (!selectedSource) return
    setRemoveConfirm(selectedSource)
    setRemoveError('')
  }
  function confirmRemove() {
    if (!removeConfirm) return
    setRemoveBusy(true); setRemoveError('')
    api.removeSource(removeConfirm.id).then(function() {
      setRemoveBusy(false); setRemoveConfirm(null)
      setSelectedSourceId(null)
      sourcesQuery.refetch()
    }).catch(function(e) {
      setRemoveBusy(false)
      setRemoveError(extractApiError(e))
    })
  }
  function onSourceSaved(result) {
    setSourceDialog(null)
    setInitError(result && result.initError ? result.initError : '')
    var refresh = sourcesQuery.refetch()
    if (result && result.source && result.source.id) {
      var selectReturnedSource = function() {
        setSelectedSourceId(result.source.id)
        if (sessionStore) sessionStore.selectedSourceId = result.source.id
      }
      if (refresh && typeof refresh.then === 'function') {
        refresh.then(selectReturnedSource, selectReturnedSource)
      } else {
        selectReturnedSource()
      }
    }
  }

  return jsxs('div', { className: cn('relative flex flex-col h-full overflow-hidden'), children: [
    jsx('style', { 'data-openspec-styles': 'true', children: OPENSPEC_PAGE_CSS }),

    // Header
    jsxs('div', { style: { padding: '6px 16px', borderBottom: BORDER_SUBTLE, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap' }, children: [
      jsx('h1', { style: { fontSize: '13px', fontWeight: 600, margin: 0, color: 'var(--foreground, inherit)' }, children: 'OpenSpec' }),
      selectedSource && selectedSource.path ? jsx('span', { style: { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted-foreground, #888)' }, title: selectedSource.path, children: selectedSource.path }) : null,
    ] }),

    // Source controls and path line
    jsxs('div', { style: { padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--muted-foreground, #888)', borderBottom: BORDER_SUBTLE }, children: [
      selectedSource ? jsx(CopyButton, { appearance: 'icon', text: sourceRef, label: 'Copy source reference', title: sourceRef, disabled: !sourceRef }) : null,
      jsx(Select, {
        value: selectedSourceId || undefined,
        onValueChange: handleSelectSource,
        children: [
          jsx(SelectTrigger, { className: 'bg-(--ui-bg-quinary) transition-colors hover:bg-primary/[0.06] hover:bg-primary/[0.06]!', 'data-openspec-source-trigger': 'true', style: { minWidth: '120px', flexShrink: 1 }, children: jsx(SelectValue, { placeholder: 'Select source' }) }),
          jsx(SelectContent, { children: sources.map(function(s) {
            return jsx(SelectItem, { value: s.id, children: (s.name || s.id) + (s.valid === false ? ' (invalid)' : '') }, s.id)
          }) })
        ]
      }),
      jsx(Button, { variant: 'outline', size: 'sm', style: { padding: '4px', minWidth: 'auto', flexShrink: 0 }, title: 'Refresh sources', 'aria-label': 'Refresh sources', onClick: function() { sourcesQuery.refetch() }, children: jsx(Codicon, { name: 'refresh', size: '0.85rem' }) }),
      jsx(Button, { variant: 'ghost', size: 'sm', style: { padding: '2px 6px', fontSize: '11px', minWidth: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }, title: 'Add source', 'aria-label': 'Add source', onClick: handleAddSource, children: ['+', ' Add'] }),
      selectedSource ? jsx(Button, { variant: 'ghost', size: 'sm', style: { padding: '2px 6px', fontSize: '11px', minWidth: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }, title: 'Edit source', 'aria-label': 'Edit source', onClick: handleEditSource, children: ['\u270E', ' Edit'] }) : null,
      selectedSource ? jsx(Button, { variant: 'ghost', size: 'sm', style: { padding: '2px 6px', fontSize: '11px', minWidth: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }, title: 'Delete source', 'aria-label': 'Delete source', onClick: handleRemoveSource, children: ['\u2715', ' Delete'] }) : null,
    ] }),

    // View switch
    jsxs('div', { style: { padding: '8px 16px', borderBottom: BORDER_SUBTLE, display: 'flex', alignItems: 'center', gap: '12px' }, children: [
      jsx(SegmentedControl, {
        value: view,
        onChange: setView,
        options: [
          { id: 'work', label: 'Work' },
          { id: 'explorations', label: 'Explorations' },
          { id: 'specs', label: 'Specs' },
        ]
      }),
      selectedSource && selectedSource.valid !== false ? jsx(DiscoverControl, { api: api, sourceId: selectedSource.id, onRegistered: function() { sourcesQuery.refetch() } }) : null,
      selectedSource && selectedSource.openspec && selectedSource.openspec.counts ? jsxs('div', { style: { display: 'flex', gap: '4px', fontSize: '10px', color: 'var(--muted-foreground, #888)' }, children: [
        selectedSource.openspec.counts.changes != null ? jsx(Badge, { variant: 'outline', children: selectedSource.openspec.counts.changes + ' changes' }) : null,
        selectedSource.openspec.counts.ideas != null ? jsx(Badge, { variant: 'outline', children: selectedSource.openspec.counts.ideas + ' ideas' }) : null,
        selectedSource.openspec.counts.specs != null ? jsx(Badge, { variant: 'outline', children: selectedSource.openspec.counts.specs + ' specs' }) : null,
        selectedSource.openspec.counts.explorations != null ? jsx(Badge, { variant: 'outline', children: selectedSource.openspec.counts.explorations + ' explorations' }) : null,
      ] }) : null,
    ] }),

    // Invalid source warning
    selectedSource && selectedSource.valid === false ? jsx('div', { style: { padding: '12px 16px', background: BANNER_WARNING, color: 'var(--foreground, inherit)', borderRadius: '4px', margin: '8px 16px', fontSize: '13px' }, children: jsxs('div', { children: [
      jsxs('div', { children: [
        jsx('strong', { children: 'Invalid source' }),
        selectedSource.error ? ': ' + selectedSource.error : '',
        selectedSource.path ? jsxs('div', { style: { fontFamily: 'monospace', fontSize: '11px', marginTop: '4px', opacity: 0.7 }, children: ['Path: ', selectedSource.path] }) : null,
      ] }),
      selectedSource.error === 'No openspec/ directory found' ? jsx(Button, { size: 'sm', onClick: handleInitSource, disabled: initBusy, style: { marginTop: '10px' }, children: initBusy ? 'Initializing...' : 'Initialize OpenSpec' }) : null,
      initError ? jsx('div', { style: { marginTop: '8px', color: semanticText(TOKEN_DANGER), fontSize: '12px' }, children: initError }) : null,
    ] }) }) : null,

    // View body
    jsx('div', { style: { flex: 1, overflow: 'hidden', padding: '12px 16px' }, children: selectedSource && selectedSource.valid !== false ? (
      view === 'work'
        ? jsx(WorkView, { key: selectedSource.id, api: api, source: selectedSource, sources: sources, showArchived: showArchived, onToggleArchived: handleToggleArchived, onSelectItem: onSelectItem })
        : view === 'explorations'
          ? jsx(ExplorationsView, { key: selectedSource.id, source: selectedSource, sources: sources, onSelectItem: onSelectItem })
          : jsx(SpecsView, { key: selectedSource.id, api: api, sourceId: selectedSource.id, ctx: ctx })
    ) : selectedSource && selectedSource.valid === false ? null : jsx(EmptyState, {
      title: sources.length === 0 ? 'No sources registered' : 'Select a source',
      description: sources.length === 0 ? 'Add a source to get started.' : 'Choose a source to view its OpenSpec project.'
    }) }),

    // Detail drawer — synchronous gate: reject stale item from different source
    selectedItem && selectedItem.sourceId === selectedSourceId && selectedItem.type === 'change' && selectedSource && selectedSource.valid !== false ? jsx(ChangeDetailDrawer, { api: api, sourceId: selectedSourceId, change: selectedItem.item, source: selectedSource, allSources: sources, allItems: allItems, ctx: ctx, width: drawerWidth, onWidthChange: handleDrawerWidth, initialTab: selectedItem.initialTab, onClose: function() { setSelectedItem(null) } }, 'change:' + (selectedItem.item.name || selectedItem.item.token)) : null,
    selectedItem && selectedItem.sourceId === selectedSourceId && selectedItem.type === 'exploration' && selectedSource && selectedSource.valid !== false ? jsx(ExplorationDetailDrawer, { api: api, sourceId: selectedSourceId, exploration: selectedItem.item, source: selectedSource, allSources: sources, allItems: (selectedSource.openspec && selectedSource.openspec.explorations) || [], ctx: ctx, width: drawerWidth, onWidthChange: handleDrawerWidth, onBackToChange: handleBackToChange, onClose: function() { setSelectedItem(null) } }) : null,
    selectedItem && selectedItem.sourceId === selectedSourceId && selectedItem.type === 'idea' && selectedSource && selectedSource.valid !== false ? jsx(IdeaDetailDrawer, { api: api, sourceId: selectedSourceId, idea: selectedItem.item, source: selectedSource, allSources: sources, allItems: allItems, width: drawerWidth, onWidthChange: handleDrawerWidth, onClose: function() { setSelectedItem(null) } }) : null,

    // Source add/edit dialog
    sourceDialog ? jsx(SourceDialog, { mode: sourceDialog.mode, api: api, source: sourceDialog.mode === 'edit' ? selectedSource : null, onClose: function() { setSourceDialog(null) }, onSaved: onSourceSaved }) : null,

    // Remove source confirmation dialog
    removeConfirm ? jsx(Dialog, { open: true, onOpenChange: function() { if (!removeBusy) { setRemoveConfirm(null); setRemoveError('') } }, children: jsxs(DialogContent, { style: { padding: '16px', maxWidth: '400px' }, children: [
      jsx('h2', { style: { fontSize: '16px', fontWeight: 600, margin: '0 0 8px', color: 'var(--foreground, inherit)' }, children: 'Remove source' }),
      jsx('p', { style: { fontSize: '13px', color: 'var(--muted-foreground, #888)', margin: '0 0 12px' }, children: 'Remove source "' + (removeConfirm.name || removeConfirm.id) + '"? This unregisters the source from OpenSpec but does not delete any files.' }),
      removeError ? jsx('div', { style: { padding: '8px 12px', background: BANNER_ERROR, borderRadius: '4px', fontSize: '12px', color: 'var(--foreground, inherit)', marginBottom: '12px' }, children: removeError }) : null,
      jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, children: [
        jsx(Button, { variant: 'outline', size: 'sm', onClick: function() { setRemoveConfirm(null); setRemoveError('') }, disabled: removeBusy, children: 'Cancel' }),
        jsx(Button, { variant: 'destructive', size: 'sm', onClick: confirmRemove, disabled: removeBusy, children: removeBusy ? 'Removing...' : 'Remove' }),
      ] }),
    ] }) }) : null,
  ] })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Status bar chip — session-folder OpenSpec project (nearest `openspec/` ancestor of host.state.cwd)
// ═══════════════════════════════════════════════════════════════════════════════

var CHIP_CSS = ' @property --os-chip-arc { syntax: "<angle>"; inherits: false; initial-value: 0deg; }' +
  ' @keyframes os-chip-spin { to { --os-chip-arc: 360deg; } }' +
  ' @keyframes os-chip-glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }' +
  ' .os-status-chip { position: relative; display: flex; align-items: center; gap: 5px; border: 0; background: none; cursor: pointer; font-size: 11px; align-self: center; height: 16px; margin: 0 2px; padding: 0 6px; box-sizing: border-box; line-height: 1; border-radius: 4px; color: var(--ui-text-tertiary); }' +
  ' .os-status-chip:hover { color: var(--ui-text-primary); }' +
  ' .os-status-chip b { font-weight: 600; color: var(--ui-accent, #60a5fa); }' +
  ' .os-status-chip.os-chip-live { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-success, #34d399) 28%, transparent); }' +
  ' .os-status-chip.os-chip-live::after { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;' +
  ' background: conic-gradient(from var(--os-chip-arc), transparent 0 68%, var(--ui-success, #34d399) 88%, transparent 100%);' +
  ' -webkit-mask: linear-gradient(rgb(0 0 0 / 0.78) 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(rgb(0 0 0 / 0.78) 0 0) content-box exclude, linear-gradient(#000 0 0);' +
  ' animation: os-chip-spin 2.2s linear infinite; }' +
  ' .os-status-chip.os-chip-live .codicon { color: var(--ui-success, #34d399); animation: os-chip-glow 2.2s ease-in-out infinite; }' +
  ' @media (prefers-reduced-motion: reduce) { .os-status-chip.os-chip-live, .os-status-chip.os-chip-live::after, .os-status-chip.os-chip-live .codicon { animation: none; } }'

var CHIP_UNDONE_STATUSES = ['todo', 'in-progress', 'draft']

// Forward-slash, lowercase drive letter, collapsed separators, no trailing slash (roots keep theirs).
function normalizeFsPath(path) {
  var p = String(path == null ? '' : path).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!p) return ''
  p = p.replace(/^([A-Za-z]):/, function(_m, d) { return d.toLowerCase() + ':' })
  if (p.length > 1 && p.charAt(p.length - 1) === '/' && !/^[a-z]:\/$/.test(p)) p = p.replace(/\/+$/, '')
  return p
}

function pathWithin(child, root) {
  if (!child || !root) return false
  if (child === root) return true
  return child.indexOf(root.charAt(root.length - 1) === '/' ? root : root + '/') === 0
}

// Session source = backend-resolved `sessionSource` (nearest ancestor, registered or not); when the backend
// predates it (undefined) fall back to the longest path-boundary ancestor among the registered sources.
function resolveSessionOpenSpecSource(sources, cwd, sessionSource) {
  if (!normalizeFsPath(cwd)) return null
  if (sessionSource === null) return null
  if (sessionSource && typeof sessionSource === 'object') return sessionSource
  var target = normalizeFsPath(cwd)
  var best = null
  var bestLen = -1
  var list = Array.isArray(sources) ? sources : []
  for (var i = 0; i < list.length; i++) {
    var src = list[i]
    if (!src || src.valid === false) continue
    var root = normalizeFsPath(src.repoRoot || src.path)
    if (pathWithin(target, root) && root.length > bestLen) { best = src; bestLen = root.length }
  }
  return best
}

function summarizeOpenSpecChip(source) {
  var hidden = { visible: false, sourceId: null, sourceName: '', sourcePath: '', unregistered: false, undoneCount: 0, runningChangesCount: 0, runningTicketsCount: 0, radar: false }
  if (!source || source.valid === false) return hidden
  var changes = (source.openspec && source.openspec.changes) || []
  var undone = 0
  var runningChanges = 0
  var runningTickets = 0
  for (var i = 0; i < changes.length; i++) {
    var change = changes[i]
    if (!change) continue
    if (CHIP_UNDONE_STATUSES.indexOf(effectiveChangeStatus(change)) >= 0) undone++
    var running = groupCrewCardsByStatus(crewCardsFor(change)).running.length
    if (running > 0) { runningChanges++; runningTickets += running }
  }
  return {
    visible: true,
    sourceId: source.id || null,
    sourceName: source.name || '',
    sourcePath: source.path || source.repoRoot || '',
    unregistered: source.unregistered === true,
    undoneCount: undone,
    runningChangesCount: runningChanges,
    runningTicketsCount: runningTickets,
    radar: runningTickets > 0,
  }
}

function sessionCwdAtom(ctx) {
  var fromCtx = ctx && ctx.host && ctx.host.state && ctx.host.state.cwd
  if (fromCtx) return fromCtx
  return (host && host.state && host.state.cwd) || null
}

function readAtom(atom) {
  return atom && typeof atom.get === 'function' ? String(atom.get() || '') : ''
}

// Click flow: register an unregistered folder first, then select it in the session store, then open /openspec.
function openSessionSource(summary, api, sessionStore, ctx) {
  var finish = function(sourceId) {
    if (sessionStore && sourceId) sessionStore.selectSource(sourceId)
    navigateToCrewCard(ctx, '/openspec')
  }
  if (!summary.unregistered) { finish(summary.sourceId); return null }
  return Promise.resolve(api.addSource(summary.sourcePath, summary.sourceName)).then(function(result) {
    finish(result && result.source ? result.source.id : null)
  })
}

function OpenSpecStatusChip({ api, sessionStore, ctx }) {
  var cwdAtom = sessionCwdAtom(ctx)
  var [cwd, setCwd] = React.useState(readAtom(cwdAtom))
  var [error, setError] = React.useState('')
  React.useEffect(function() {
    if (!cwdAtom || typeof cwdAtom.subscribe !== 'function') return undefined
    var off = cwdAtom.subscribe(function(value) { setCwd(String(value || '')) })
    return typeof off === 'function' ? off : undefined
  }, [cwdAtom])
  var query = useQuery({
    queryKey: ['openspec', 'session-source', cwd],
    queryFn: function() { return api.sources(cwd) },
    refetchInterval: POLL_INTERVAL_MS,
    enabled: !!cwd,
  })
  var data = query.data || {}
  var summary = summarizeOpenSpecChip(resolveSessionOpenSpecSource(data.sources, cwd, data.sessionSource))
  if (!summary.visible) return null
  var onClick = function() {
    setError('')
    var pending = openSessionSource(summary, api, sessionStore, ctx)
    if (pending && typeof pending.catch === 'function') return pending.catch(function(e) { setError(extractApiError(e)) })
    return pending
  }
  var title = 'OpenSpec ' + summary.sourceName + ': ' + summary.undoneCount + ' undone change' + (summary.undoneCount === 1 ? '' : 's') +
    (summary.radar ? ' · ' + summary.runningTicketsCount + ' Crew running' : '') +
    (summary.unregistered ? ' · click to register this folder' : '') + (error ? ' · ' + error : '')
  var props = { type: 'button', className: 'os-status-chip' + (summary.radar ? ' os-chip-live' : ''), title: title, 'data-openspec-chip': 'true', onClick: onClick }
  if (summary.radar) props['data-radar'] = 'running'
  props.children = [
    jsx('style', { 'data-openspec-chip-styles': 'true', children: CHIP_CSS }, 'css'),
    jsx(Codicon, { name: 'list-tree' }, 'icon'),
    jsx('b', { children: String(summary.undoneCount) }, 'count'),
  ]
  return jsxs('button', props)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin definition
// ═══════════════════════════════════════════════════════════════════════════════

var plugin = {
  id: 'openspec',
  name: 'OpenSpec',
  description: 'OpenSpec source registry + project surface — sources, changes, ideas, specs, and diffs.',
  register: function(ctx) {
    var api = createApi(ctx)
    var sessionStore = createSessionStore()
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        title: 'OpenSpec',
        data: { path: '/openspec' },
        render: function() { return jsx(OpenSpecPage, { api: api, sessionStore: sessionStore, ctx: ctx }) }
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 50,
        data: { codicon: 'list-tree', label: 'OpenSpec', path: '/openspec', asTile: true }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: function() { return jsx(OpenSpecStatusChip, { api: api, sessionStore: sessionStore, ctx: ctx }) }
      }
    ])
  }
}

export default plugin
export const __test = Object.freeze({
  sourcesPath: sourcesPath,
  normalizeFsPath: normalizeFsPath,
  resolveSessionOpenSpecSource: resolveSessionOpenSpecSource,
  summarizeOpenSpecChip: summarizeOpenSpecChip,
  OpenSpecStatusChip: OpenSpecStatusChip,
  CHIP_CSS: CHIP_CSS,
  changePath: changePath,
  ideaPath: ideaPath,
  specBrowserPath: specBrowserPath,
  specPath: specPath,
  explorationPath: explorationPath,
  discoverSourcesPath: discoverSourcesPath,
  explorationScopeLabel: explorationScopeLabel,
  filterExplorations: filterExplorations,
  sortExplorations: sortExplorations,
  verdictTone: verdictTone,
  changeTabKeys: changeTabKeys,
  crewCardsFor: crewCardsFor,
  ExplorationsView: ExplorationsView,
  ExplorationDetailDrawer: ExplorationDetailDrawer,
  ExplorationBody: ExplorationBody,
  ReviewsView: ReviewsView,
  CrewCardChips: CrewCardChips,
  DiscoverControl: DiscoverControl,
  ChangeDetailDrawer: ChangeDetailDrawer,
  OpenSpecPage: OpenSpecPage,
  selectFirstValid: selectFirstValid,
  normalizeStatus: normalizeStatus,
  groupByStatus: groupByStatus,
  normalizeSequencePosition: normalizeSequencePosition,
  sortItems: sortItems,
  groupCrewCardsByStatus: groupCrewCardsByStatus,
  itemActivityRank: itemActivityRank,
  effectiveChangeStatus: effectiveChangeStatus,
  crewProgressLabel: crewProgressLabel,
  clampDrawerWidth: clampDrawerWidth,
  clampSpecsSidebarWidth: clampSpecsSidebarWidth,
  navigateToCrewCard: navigateToCrewCard,
  CardCrewPills: CardCrewPills,
  SpecsView: SpecsView,
  renderExplorationRow: renderExplorationRow,
  filterItems: filterItems,
  toggleArchived: toggleArchived,
  parseTasks: parseTasks,
  renderMarkdown: renderMarkdown,
  classifyState: classifyState,
  classifyDiffLine: classifyDiffLine,
  hasDiffMode: hasDiffMode,
  normalizeSemanticGroups: normalizeSemanticGroups,
  effectiveDiffMode: effectiveDiffMode,
  isSafeUrl: isSafeUrl,
  renderInline: renderInline,
  MarkdownTable: MarkdownTable,
  headingStyle: headingStyle,
  semanticText: semanticText,
  SemanticDiffView: SemanticDiffView,
  RawDiffView: RawDiffView,
  TaskView: TaskView,
  MarkdownElement: MarkdownElement,
  RetryErrorState: RetryErrorState,
  autoCollapseEmptyLanes: autoCollapseEmptyLanes,
  laneWidth: laneWidth,
  railStyle: railStyle,
  expandedStyle: expandedStyle,
  LANE_EXPANDED_WIDTH: LANE_EXPANDED_WIDTH,
  LANE_COLLAPSED_WIDTH: LANE_COLLAPSED_WIDTH,
  STATUS_TONE: STATUS_TONE,
  statusTone: statusTone,
  computeCollapsedSet: computeCollapsedSet,
  toggleOverride: toggleOverride,
  computeLanePhase: computeLanePhase,
  pruneStaleOverrides: pruneStaleOverrides,
  BoardColumn: BoardColumn,
  BoardCard: BoardCard,
  CardArtifacts: CardArtifacts,
  CardTaskFraction: CardTaskFraction,
  DetailDrawer: DetailDrawer,
  WorkView: WorkView,
  stripFrontmatter: stripFrontmatter,
  buildSourceReference: buildSourceReference,
  buildItemReference: buildItemReference,
  hasUniqueItemToken: hasUniqueItemToken,
  createSessionStore: createSessionStore,
  resolveRetainedSource: resolveRetainedSource,
  detailTitle: detailTitle,
  detailSecondaryName: detailSecondaryName,
  ideaSecondaryName: ideaSecondaryName,
  handleActivateKey: handleActivateKey,
  trimPath: trimPath,
  extractApiError: extractApiError,
  sourceNeedsInitialization: sourceNeedsInitialization,
  initializeAddedSource: initializeAddedSource,
  createApi: createApi,
  parseSpec: parseSpec,
  filterSpecFiles: filterSpecFiles,
  filterSpecRequirements: filterSpecRequirements,
  specCountsLabel: specCountsLabel,
  specStatusBadgeVisible: specStatusBadgeVisible,
  StructuredSpecView: StructuredSpecView,
  ChangeExplorationsView: ChangeExplorationsView,
  SpecsDetailView: SpecsDetailView,
  MarkdownView: MarkdownView,
})
