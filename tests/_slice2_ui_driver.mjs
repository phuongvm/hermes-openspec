#!/usr/bin/env node
/**
 * Slice 2 UI driver — executed by desktop-plugin-smoke.mjs.
 *
 * Imports desktop/plugin.js with SDK/react shims and exercises the Slice 2 surface:
 * exploration + review artifacts (tasks 2.3) and the Crew linkage / Discover /
 * asTile additions (tasks 3.3). Prints one JSON object of results to stdout.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginSrc = readFileSync(resolve(__dirname, '../desktop/plugin.js'), 'utf8')

const names = [
  'Codicon', 'Loader', 'EmptyState', 'ErrorState', 'Badge', 'Button',
  'CopyButton', 'Dialog', 'DialogContent', 'Input', 'ScrollArea', 'SearchField',
  'Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue',
  'SegmentedControl', 'Tabs', 'TabsList', 'TabsTrigger',
]
const sdkShim = names.map(n => 'export const ' + n + '=(...a)=>a').join(';')
  + ';export const useQuery=(o)=>globalThis.__uq(o)'
  + ';export function cn(...a){ return a.filter(Boolean).join(" ") }'
  + ';export const ROUTES_AREA="routes"'
  + ';export const SIDEBAR_NAV_AREA="sidebar.nav"'
  + ';export default {}'
const reactShim = 'export function useState(v){return[v,function(){}]};'
  + 'export function useEffect(f,d){return undefined};'
  + 'export function useRef(v){return{current:v}};'
  + 'export function useCallback(f,d){return f};'
  + 'export function useMemo(f,d){return f()};'
  + 'export default { useState, useEffect, useRef, useCallback, useMemo }'
const jsxShim = 'export function jsx(c,p,k){return{component:c,props:p,key:k,_t:"jsx"}}'
  + 'export function jsxs(c,p,k){return{component:c,props:p,key:k,_t:"jsxs"}}'
  + 'export function Fragment(p){return p&&p.children}'

const sdkUrl = 'data:text/javascript,' + encodeURIComponent(sdkShim)
const reactUrl = 'data:text/javascript,' + encodeURIComponent(reactShim)
const jsxUrl = 'data:text/javascript,' + encodeURIComponent(jsxShim)
const sdk = await import(sdkUrl)

// useQuery fixture: globalThis.__fixtures maps queryKey[1] ('sources'|'change'|'exploration'|...) to a result.
globalThis.__fixtures = {}
globalThis.__uq = function(o) {
  const key = o && o.queryKey && o.queryKey[1]
  const fx = globalThis.__fixtures[key]
  if (fx === undefined) return { data: undefined, isLoading: false, error: null, refetch() {} }
  return Object.assign({ isLoading: false, error: null, refetch() {} }, fx)
}

const blob = pluginSrc
  .replace(/from\s+['"]@hermes\/plugin-sdk['"]/g, "from '" + sdkUrl + "'")
  .replace(/from\s+['"]react\/jsx-runtime['"]/g, "from '" + jsxUrl + "'")
  .replace(/from\s+['"]react['"]/g, "from '" + reactUrl + "'")
const mod = await import('data:text/javascript,' + encodeURIComponent(blob))
const t = mod.__test
const plugin = mod.default

// ── helpers ────────────────────────────────────────────────────────────────
function visit(node, fn) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => visit(n, fn)); return }
  if (node._t) {
    fn(node)
    const p = node.props || {}
    for (const k of Object.keys(p)) {
      if (k === 'children' || k === 'options') visit(p[k], fn)
    }
  }
}
function find(node, pred) { const out = []; visit(node, n => { if (pred(n)) out.push(n) }); return out }
function texts(node) {
  const out = []
  const walkText = (n) => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walkText); return }
    if (n._t) { const c = n.props && n.props.children; walkText(c) }
  }
  walkText(node)
  return out.join(' ')
}
function safe(fn) { try { return fn() } catch (e) { return { __error: String(e && e.message || e) } } }

const R = {}

// ── exports present ────────────────────────────────────────────────────────
R.exports = {}
for (const n of ['explorationPath', 'discoverSourcesPath', 'explorationScopeLabel', 'filterExplorations',
  'sortExplorations', 'verdictTone', 'changeTabKeys', 'ExplorationsView', 'ExplorationDetailDrawer',
  'ReviewsView', 'ExplorationBody', 'CrewCardChips', 'crewCardsFor', 'DiscoverControl', 'ChangeDetailDrawer',
  'OpenSpecPage', 'createApi']) {
  R.exports[n] = typeof t[n]
}

// ── path builders ──────────────────────────────────────────────────────────
R.paths = {
  ws: safe(() => t.explorationPath('src-1', '2026-10-30-topic', 'workspace')),
  change: safe(() => t.explorationPath('src-1', 'spike', 'change:demo')),
  dflt: safe(() => t.explorationPath('src-1', 'spike')),
  special: safe(() => t.explorationPath('a b', 'x&y', 'change:d/e')),
  discover: safe(() => t.discoverSourcesPath('src 1')),
}

// ── pure helpers ───────────────────────────────────────────────────────────
const EX = [
  { name: 'old', title: 'Old Topic', scope: 'workspace', token: 'os_000001', date: '2026-01-01' },
  { name: 'new', title: 'New Topic', scope: 'change:demo', token: 'os_000002', date: '2026-10-30' },
  { name: 'mid', title: 'Mid', scope: 'workspace', token: 'os_000003', date: '2026-05-05' },
]
R.helpers = safe(() => ({
  scopeWs: t.explorationScopeLabel('workspace'),
  scopeChange: t.explorationScopeLabel('change:demo'),
  scopeEmpty: t.explorationScopeLabel(undefined),
  filterEmpty: t.filterExplorations(EX, '').length,
  filterTitle: t.filterExplorations(EX, 'new').map(e => e.name),
  filterScope: t.filterExplorations(EX, 'change:demo').map(e => e.name),
  filterToken: t.filterExplorations(EX, 'OS_000003').map(e => e.name),
  filterNone: t.filterExplorations(EX, 'zzz').length,
  sorted: t.sortExplorations(EX).map(e => e.name),
  toneApproved: t.verdictTone('APPROVED'),
  toneRejected: t.verdictTone('REJECTED'),
  tonePending: t.verdictTone('PENDING'),
  toneUnknown: t.verdictTone(undefined),
  tabsAll: t.changeTabKeys({ proposal: 'p', tasks: 't', design: 'd', specs: [{}], reviews: [{}], explorations: [{}] }),
  tabsReviewsOnly: t.changeTabKeys({ proposal: 'p', reviews: [{}] }),
  tabsEmptyArrays: t.changeTabKeys({ proposal: 'p', reviews: [], explorations: [] }),
  tabsNone: t.changeTabKeys({}),
}))

// ── api adapter ────────────────────────────────────────────────────────────
{
  const calls = []
  const ctx = { rest: function(path, opts) { calls.push({ path, opts }); return Promise.resolve({}) } }
  const api = t.createApi(ctx)
  safe(() => api.exploration('s1', 'spike', 'change:demo'))
  safe(() => api.discoverSources('s1', true))
  safe(() => api.discoverSources('s1', false))
  R.api = { calls }
}

// ── component fixtures ─────────────────────────────────────────────────────
const SRC = {
  id: 'src-1', token: 'os_src001', name: 'demoapp', valid: true, path: '/repos/demoapp',
  openspec: {
    changes: [{ name: 'demo', token: 'os_c00001', title: 'Demo', status: 'todo', hasReviews: true, hasExplorations: true, latestVerdict: 'APPROVED', reviewCount: 2 }],
    ideas: [], specs: [],
    explorations: EX.map(e => Object.assign({ filename: e.name + '.md', path: '/repos/demoapp/openspec/' + e.name + '.md' }, e)),
    counts: { changes: 1, ideas: 0, specs: 0, explorations: 3 },
  },
}

// ExplorationsView
R.view = safe(() => {
  const selected = []
  const node = t.ExplorationsView({ api: {}, source: SRC, sources: [SRC], onSelectItem: (i) => selected.push(i) })
  const rows = find(node, n => n.props && n.props['data-exploration-row'] != null)
  rows.sort((a, b) => 0)
  const labels = rows.map(r => texts(r))
  const badges = find(node, n => n.component === sdk.Badge).map(n => texts(n))
  if (rows[0] && rows[0].props.onClick) rows[0].props.onClick()
  const keyed = rows[0] && rows[0].props.onKeyDown ? (rows[0].props.onKeyDown({ key: 'Enter', preventDefault() {} }), selected.length) : -1
  const copy = find(node, n => n.component === sdk.CopyButton).map(n => n.props.text)
  return {
    rowCount: rows.length,
    firstRowText: labels[0] || '',
    allRowText: labels.join(' | '),
    scopeBadges: badges.filter(b => b === 'Workspace' || b.indexOf('Change: ') === 0),
    selectedType: selected[0] && selected[0]._type,
    selectedName: selected[0] && selected[0].name,
    keyboardSelects: keyed,
    copyRefs: copy,
    hasInput: find(node, n => n.component === sdk.Input).length,
  }
})
R.viewEmpty = safe(() => {
  const empty = Object.assign({}, SRC, { openspec: Object.assign({}, SRC.openspec, { explorations: [] }) })
  const node = t.ExplorationsView({ api: {}, source: empty, sources: [empty], onSelectItem() {} })
  return { emptyStates: find(node, n => n.component === sdk.EmptyState).length }
})

// ExplorationDetailDrawer (loaded)
globalThis.__fixtures.exploration = {
  data: {
    name: 'new', filename: 'new.md', scope: 'change:demo', token: 'os_000002', title: 'New Topic',
    date: '2026-10-30', path: '/repos/demoapp/openspec/changes/demo/explorations/new.md',
    content: '---\ntitle: x\n---\n# New Topic\nbody text',
  },
}
R.drawer = safe(() => {
  const ex = SRC.openspec.explorations[1]
  const node = t.ExplorationDetailDrawer({ api: {}, sourceId: 'src-1', exploration: ex, source: SRC, allSources: [SRC], allItems: SRC.openspec.explorations, onClose() {} })
  const drawer = find(node, n => n.component === t.DetailDrawer)[0]
  const p = drawer ? drawer.props : {}
  const body = find(node, n => n.component === t.ExplorationBody)[0]
  return { title: p.title, secondary: p.secondary, itemRef: p.itemRef, canCopy: p.canCopy, token: p.token, hasBody: !!body, bodyScope: body && body.props.exploration.scope }
})
R.body = safe(() => {
  const ex = SRC.openspec.explorations[1]
  const node = t.ExplorationBody({ api: {}, sourceId: 'src-1', exploration: ex })
  const md = find(node, n => n.component === t.MarkdownViewRef)
  const copy = find(node, n => n.component === sdk.CopyButton).map(n => n.props.text)
  const text = texts(node)
  return { copy, mentionsDate: text.indexOf('2026-10-30') >= 0, mentionsScope: text.indexOf('Change: demo') >= 0 }
})

// ReviewsView
const REVIEWS = [
  { name: 'findings-proposal-v1', filename: 'findings-proposal-v1.md', change: 'demo', token: 'os_r00001', verdict: 'REJECTED', round: 1, content: '# v1\n- **Verdict**: **REJECTED**' },
  { name: 'findings-proposal-v2', filename: 'findings-proposal-v2.md', change: 'demo', token: 'os_r00002', verdict: 'APPROVED', round: 2, content: '# v2\nall good' },
]
R.reviews = safe(() => {
  const node = t.ReviewsView({ reviews: REVIEWS })
  const badges = find(node, n => n.component === sdk.Badge)
  const text = texts(node)
  return {
    badgeTexts: badges.map(b => texts(b)),
    badgeColors: badges.map(b => (b.props.style && b.props.style.color) || null),
    mentionsV2: text.indexOf('v2') >= 0,
    mentionsRound: text.indexOf('Round 2') >= 0,
    listButtons: find(node, n => n.props && n.props['data-review-item'] != null).length,
  }
})
R.reviewsEmpty = safe(() => find(t.ReviewsView({ reviews: [] }), n => n.component === sdk.EmptyState).length)

// ChangeDetailDrawer tabs
globalThis.__fixtures.change = {
  data: {
    name: 'demo', title: 'Demo', proposal: '# p', tasks: '- [ ] a', design: '# d',
    specs: [{ path: 'a/spec.md', content: '# s' }],
    reviews: REVIEWS, explorations: [SRC.openspec.explorations[1]],
    taskStats: { done: 0, total: 1 },
    crewCards: [{ id: 't_aaa111', title: 'Impl demo', status: 'running', assignee: 'coder', board: 'crew', url: '/crew?card=t_aaa111' }],
  },
}
R.changeTabs = safe(() => {
  const change = SRC.openspec.changes[0]
  const node = t.ChangeDetailDrawer({ api: {}, sourceId: 'src-1', change, source: SRC, allSources: [SRC], allItems: [change], onClose() {} })
  const triggers = find(node, n => n.component === sdk.TabsTrigger).map(n => n.props.value + ':' + texts(n))
  const chips = find(node, n => n.component === t.CrewCardChips)
  return { triggers, chipsRendered: chips.length, chipCards: chips[0] ? chips[0].props.cards.length : 0 }
})

// Page: view switch + counts + drawer routing
globalThis.__fixtures.sources = { data: { sources: [SRC] } }
R.page = safe(() => {
  const store = { selectedSourceId: 'src-1', showArchived: true }
  const node = t.OpenSpecPage({ api: {}, sessionStore: store })
  const seg = find(node, n => n.component === sdk.SegmentedControl)[0]
  const options = seg ? seg.props.options.map(o => o.id + ':' + o.label) : []
  const badgeTexts = find(node, n => n.component === sdk.Badge).map(n => texts(n))
  return { options, hasExplorationsBadge: badgeTexts.indexOf('3 explorations') >= 0, badgeTexts }
})

// Page: asTile + registration
R.register = safe(() => {
  const contribs = []
  plugin.register({ registerMany(arr) { arr.forEach(c => contribs.push(c)) }, rest() { return Promise.resolve({}) } })
  const nav = contribs.find(c => c.area === 'sidebar.nav')
  const route = contribs.find(c => c.area === 'routes')
  return { nav: nav && nav.data, route: route && route.data }
})

// ── Crew linkage + Discover (task 3.3) ─────────────────────────────────────
R.crew = safe(() => {
  const cards = [
    { id: 't_aaa111', title: 'Impl demo', status: 'running', assignee: 'coder', board: 'crew', url: '/crew?card=t_aaa111' },
    { id: 't_bbb222', title: 'Review', status: 'done', assignee: 'reviewer', board: 'default', url: '/crew?card=t_bbb222' },
  ]
  const navigated = []
  const ctx = { host: { navigate: (u) => navigated.push(u) } }
  const node = t.CrewCardChips({ cards, ctx })
  const chips = find(node, n => n.props && n.props['data-crew-card'] != null)
  chips[0] && chips[0].props.onClick && chips[0].props.onClick()
  chips[1] && chips[1].props.onKeyDown && chips[1].props.onKeyDown({ key: 'Enter', preventDefault() {} })
  const copies = find(node, n => n.component === sdk.CopyButton).map(n => n.props.text)
  // no host.navigate -> must not throw
  let noHost = 'ok'
  try { const n2 = t.CrewCardChips({ cards, ctx: {} }); const c2 = find(n2, n => n.props && n.props['data-crew-card'] != null); c2[0].props.onClick() } catch (e) { noHost = 'threw' }
  const empty = t.CrewCardChips({ cards: [], ctx })
  return {
    chipCount: chips.length,
    chipText: chips.map(c => texts(c)),
    navigated,
    copies,
    noHost,
    emptyIsNull: empty === null || empty === undefined,
    forItem: t.crewCardsFor({ crewCards: cards }).length,
    forNone: t.crewCardsFor({}).length,
  }
})

R.discover = safe(() => {
  const calls = []
  const api = { discoverSources: (id, reg) => { calls.push([id, reg]); return Promise.resolve({ ok: true, candidates: [], registered: [] }) } }
  const node = t.DiscoverControl({ api, sourceId: 'src-1', onRegistered() {} })
  const buttons = find(node, n => n.component === sdk.Button)
  return { buttonLabels: buttons.map(b => texts(b)), disabled: buttons.map(b => !!b.props.disabled) }
})

process.stdout.write(JSON.stringify(R))
