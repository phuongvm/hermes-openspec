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
  + ';export const host={navigate(u){if(globalThis.__sdkNav)globalThis.__sdkNav.push(u)}}'
  + ';export const ROUTES_AREA="routes"'
  + ';export const SIDEBAR_NAV_AREA="sidebar.nav"'
  + ';export default {}'
const reactShim = 'export function useState(v){return[v,function(){}]};'
  + 'export function useEffect(f,d){if(globalThis.__effects)globalThis.__effects.push(f);return undefined};'
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
globalThis.__uqOpts = {}
globalThis.__uq = function(o) {
  const key = o && o.queryKey && o.queryKey[1]
  if (key) globalThis.__uqOpts[key] = o
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
    optionTexts: find(node, n => n.component === 'option').map(o => texts(o)),
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
  return { nav: nav && nav.data, route: route && route.data, routeTitle: route && route.title }
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

// ── Slice 3 UI probes ──────────────────────────────────────────────────────
R.slice3 = safe(() => {
  // 1. Polling intervals recorded on sources + change queries
  const sourcesRefetch = globalThis.__uqOpts.sources && globalThis.__uqOpts.sources.refetchInterval
  const changeRefetch = globalThis.__uqOpts.change && globalThis.__uqOpts.change.refetchInterval

  // 2. Hash promotion: #/openspec -> host.navigate('/openspec'); #/other -> no navigation
  globalThis.__sdkNav = []
  globalThis.__effects = []
  globalThis.window = { location: { hash: '#/openspec' } }
  t.OpenSpecPage({ api: {}, sessionStore: { selectedSourceId: 'src-1', showArchived: true } })
  globalThis.__effects.forEach(fn => fn())
  const hashPromoted = globalThis.__sdkNav.slice()

  globalThis.__sdkNav = []
  globalThis.__effects = []
  globalThis.window = { location: { hash: '#/settings' } }
  t.OpenSpecPage({ api: {}, sessionStore: { selectedSourceId: 'src-1', showArchived: true } })
  globalThis.__effects.forEach(fn => fn())
  const nonMatchNav = globalThis.__sdkNav.slice()
  delete globalThis.window

  // 3. Board swimlane promotion + active-first sorting + radar attributes (alpha vs beta scenario)
  const alpha = { name: 'alpha', token: 'os_alpha', title: 'Alpha', status: 'todo', sequence: { position: 10 }, taskStats: { done: 0, total: 7 }, crewCards: [{ id: 't_run1', status: 'running', title: 'Impl', url: '/crew?card=t_run1' }] }
  const beta = { name: 'beta', token: 'os_beta', title: 'Beta', status: 'in_progress', sequence: { position: 1 }, taskStats: { done: 2, total: 5 }, crewCards: [{ id: 't_done1', status: 'done', title: 'Done', url: '/crew?card=t_done1' }] }
  const gamma = { name: 'gamma', token: 'os_gamma', title: 'Gamma', status: 'draft', sequence: { position: 2 }, crewCards: [{ id: 't_rev1', status: 'review', title: 'Rev', url: '/crew?card=t_rev1' }] }
  const grouped = t.groupByStatus([beta, gamma, alpha], true)
  const inProgSorted = t.sortItems(grouped['in-progress']).map(i => i.name)
  const cardAlpha = t.BoardCard({ item: alpha, source: SRC, allSources: [SRC], allItems: [alpha, beta, gamma], onSelect() {} })
  const cardBeta = t.BoardCard({ item: beta, source: SRC, allSources: [SRC], allItems: [alpha, beta, gamma], onSelect() {} })
  const cardGamma = t.BoardCard({ item: gamma, source: SRC, allSources: [SRC], allItems: [alpha, beta, gamma], onSelect() {} })

  // 4. DetailDrawer: clamp bounds, resize handle, pointer drag, storage persistence, disambiguated Checklist + Crew badges
  const clamp = [t.clampDrawerWidth(100), t.clampDrawerWidth(540), t.clampDrawerWidth(2000), t.clampDrawerWidth(undefined),
                 t.clampSpecsSidebarWidth(50), t.clampSpecsSidebarWidth(260), t.clampSpecsSidebarWidth(900), t.clampSpecsSidebarWidth(null)]
  const fiveCards = [
    { id: 'c1', status: 'done', url: '/crew?card=c1' },
    { id: 'c2', status: 'done', url: '/crew?card=c2' },
    { id: 'c3', status: 'done', url: '/crew?card=c3' },
    { id: 'c4', status: 'running', url: '/crew?card=c4' },
    { id: 'c5', status: 'todo', url: '/crew?card=c5' },
  ]
  const widthEvents = []
  const dd = t.DetailDrawer({
    title: 'Demo', secondary: 'demo', itemRef: 'workspaces/os_e80720', canCopy: true, token: 'os_e80720',
    taskStats: { done: 0, total: 7 }, crewCards: fiveCards, width: 640,
    onWidthChange: (w, commit) => widthEvents.push([w, commit]), onClose() {}, children: null,
  })
  const sash = find(dd, n => n.props && n.props['data-drawer-resize-handle'] === 'true')[0]
  // Simulate pointer drag left by 80px -> 640 + 80 = 720, then double-click reset -> 540
  const listeners = {}
  globalThis.window = {
    addEventListener(ev, fn) { listeners[ev] = fn },
    removeEventListener(ev) { delete listeners[ev] },
  }
  sash.props.onPointerDown({ clientX: 500, preventDefault() {} })
  listeners.pointermove && listeners.pointermove({ clientX: 420 })
  listeners.pointerup && listeners.pointerup({ clientX: 420 })
  sash.props.onDoubleClick()
  sash.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  delete globalThis.window
  const ddBadges = find(dd, n => n.component === sdk.Badge).map(b => texts(b))
  const ddRef = find(dd, n => n.props && n.props['data-drawer-ref'] != null).map(n => texts(n))

  // Stored drawerWidth & specsSidebarWidth read through ctx.storage
  const saved = { drawerWidth: 700, specsSidebarWidth: 320 }
  const storageCtx = { storage: { get: (k, fb) => (k in saved ? saved[k] : fb), set: (k, v) => { saved[k] = v } } }
  globalThis.__fixtures.specBrowser = { data: { files: [{ path: 'a/spec.md', status: 'current' }], branch: 'main' } }
  const origUq = globalThis.__uq
  globalThis.__uq = (o) => o.queryKey[1] === 'spec-browser' ? globalThis.__fixtures.specBrowser : origUq(o)
  const specsNode = t.SpecsView({ api: {}, sourceId: 'src-1', ctx: storageCtx })
  globalThis.__uq = origUq
  const specsSidebar = find(specsNode, n => n.props && n.props['data-specs-sidebar'] === 'true')[0]
  const specsSash = find(specsNode, n => n.props && n.props['data-specs-resize-handle'] === 'true')[0]
  specsSash && specsSash.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })

  // 5. Wrapping 6-tab TabsList + exploration row title & nowrap date
  const changeNode = t.ChangeDetailDrawer({ api: {}, sourceId: 'src-1', change: SRC.openspec.changes[0], source: SRC, allSources: [SRC], allItems: SRC.openspec.changes, ctx: storageCtx, width: 700, onClose() {} })
  const tabsList = find(changeNode, n => n.component === sdk.TabsList)[0]
  const exRow = t.renderExplorationRow(
    { name: 'long', token: 'os_l1', title: 'Full Width Title', scope: 'change:very-long-change-slug-that-used-to-crush-titles', date: '2026-10-30', filename: '2026-10-30-long.md' },
    SRC, [SRC], [], () => {}
  )
  const dateNode = find(exRow, n => n.props && n.props['data-exploration-date'] === 'true')[0]
  const titleNode = find(exRow, n => n.props && n.props['data-exploration-title'] === 'true')[0]

  // 6. 20-ticket CrewCardChips collapsed by default + SDK host.navigate when ctx.host is absent
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    id: 't_' + String(i + 1).padStart(2, '0'),
    title: 'Ticket ' + (i + 1),
    status: ['running', 'review', 'blocked', 'todo', 'done'][i % 5],
    assignee: 'coder', board: 'crew', url: '/crew?card=t_' + String(i + 1).padStart(2, '0'),
  }))
  const collapsed20 = t.CrewCardChips({ cards: twenty, ctx: {} })
  const expanded20 = t.CrewCardChips({ cards: twenty, ctx: {}, defaultOpen: true })
  globalThis.__sdkNav = []
  const firstChip = find(expanded20, n => n.props && n.props['data-crew-card'] != null)[0]
  firstChip && firstChip.props.onClick()
  const listBox = find(expanded20, n => n.props && n.props['data-crew-list'] === 'true')[0]

  return {
    sourcesRefetch, changeRefetch,
    hashPromoted, nonMatchNav,
    inProgSorted,
    alphaRadar: cardAlpha.props['data-radar'], alphaClass: cardAlpha.props.className,
    betaRadar: cardBeta.props['data-radar'] || null, betaClass: cardBeta.props.className,
    gammaRadar: cardGamma.props['data-radar'], gammaClass: cardGamma.props.className,
    alphaPills: find(cardAlpha, n => n.component === t.CardCrewPills).length === 1 ? texts(t.CardCrewPills({ item: alpha })) : '',
    clamp,
    ddWidth: dd.props.style.width,
    sashRole: sash && sash.props.role, sashOrient: sash && sash.props['aria-orientation'],
    widthEvents,
    ddBadges, ddRef,
    specsSidebarW: specsSidebar && specsSidebar.props.style.width,
    specsSashExists: !!specsSash,
    savedAfterKey: saved.specsSidebarWidth,
    tabsWrap: tabsList && tabsList.props.style && tabsList.props.style.flexWrap,
    tabLabels: find(changeNode, n => n.component === sdk.TabsTrigger).map(n => texts(n)),
    dateNowrap: dateNode && dateNode.props.style && dateNode.props.style.whiteSpace,
    titleFullWidth: !!(titleNode && titleNode.props.style && titleNode.props.style.flex === 1),
    collapsed20ListCount: find(collapsed20, n => n.props && n.props['data-crew-list'] === 'true').length,
    collapsed20Summary: texts(find(collapsed20, n => n.props && n.props['data-crew-summary'] === 'true')[0]),
    expanded20Cards: find(expanded20, n => n.props && n.props['data-crew-card'] != null).length,
    expanded20MaxH: listBox && listBox.props.style && listBox.props.style.maxHeight,
    sdkHostNav: globalThis.__sdkNav.slice(),
  }
})

// Slice 3b — structured Markdown + semantic diff/task tokens
R.slice3b = safe(() => {
  const MD = [
    '# H1 title', '## H2 title', '### H3 title', '#### H4 title', '',
    '| Name | Qty |', '| :--- | ---: |', '| apple | 3 |', '| pear \\| green | 4 |', '',
    '> quoted **bold**', '> second line', '', '---', '',
    'Some *italic* and _under_ and **bold** text with `code` and [ok](https://example.com) and [bad](javascript:alert(1)).', '',
    '```diff', '+added', '-removed', '@@ hunk', ' ctx', '```',
  ].join('\n')
  const blocks = t.renderMarkdown(MD)
  const types = blocks.map(b => b.type)
  const table = blocks.find(b => b.type === 'table')
  const rendered = blocks.map(b => t.MarkdownElement(b))
  const headings = rendered.filter(n => n && n.props && n.props['data-md-heading']).map(n => ({ lvl: n.props['data-md-heading'], fs: n.props.style.fontSize, fw: n.props.style.fontWeight }))
  const tableNode = rendered[blocks.findIndex(b => b.type === 'table')]
  const tableFn = tableNode.component
  const tableTree = tableFn(tableNode.props)
  const ths = find(tableTree, n => n.component === 'th')
  const tds = find(tableTree, n => n.component === 'td')
  const bq = rendered.find(n => n && n.props && n.props['data-md-blockquote'])
  const hr = rendered.find(n => n && n.props && n.props['data-md-hr'])
  const para = blocks.find(b => b.type === 'paragraph')
  const inl = t.renderInline(para.text)
  const em = inl.filter(n => n && n.component === 'em').map(n => n.props.children)
  const link = inl.filter(n => n && n.component === 'a')[0]
  const fenced = rendered[blocks.findIndex(b => b.type === 'fenced')]
  const diffSpans = find(fenced, n => n.props && n.props.style && n.component === 'span' && n.props.style.display === 'block')
  // semantic diff + task + raw diff
  const sem = t.SemanticDiffView({ data: { requirements: { added: [{ name: 'A', description: 'd' }], modified: [{ name: 'M', before: 'old', after: 'new' }], removed: [{ name: 'R', description: 'x' }] } } })
  const badges = find(sem, n => n.component === 'span' && n.props.style && n.props.style.fontWeight === 600)
  const raw = t.RawDiffView({ diff: '+a\n-b\n@@ h\n c' })
  const rawLines = find(raw, n => n.props && n.props['data-diff-line'])
  const task = t.TaskView({ content: '## S\n- [x] done\n- [ ] open' })
  const taskMarks = find(task, n => n.props && n.props['data-task-state'])
  return {
    types, headings,
    tableHeader: table.header, tableRows: table.rows, tableAlign: table.align,
    thCount: ths.length, tdCount: tds.length,
    thBorder: ths[0] && ths[0].props.style.border, thBg: ths[0] && ths[0].props.style.background, tdAlign: tds[1] && tds[1].props.style.textAlign,
    bqLines: blocks.find(b => b.type === 'blockquote').lines, bqBorder: bq && bq.props.style.borderLeft,
    hrBorder: hr && hr.props.style.borderTop,
    em, linkColor: link && link.props.style.color, unsafe: texts(inl).indexOf('[unsafe link]') >= 0,
    diffColors: diffSpans.map(n => n.props.style.color),
    semBadgeBg: badges.map(n => n.props.style.background), semBadgeFg: badges.map(n => n.props.style.color),
    rawKinds: rawLines.map(n => n.props['data-diff-line']), rawColors: rawLines.map(n => n.props.style.color),
    taskStates: taskMarks.map(n => n.props['data-task-state']), taskDoneColor: taskMarks[0] && taskMarks[0].props.style.color,
  }
})

// Slice 3c — inline Explorations/Reviews viewers, back-to-change nav, rich Specs sidebar, StructuredSpecView
R.slice3c = safe(() => {
  const SPEC_MD = [
    '---', 'title: x', '---',
    '# Compose Specification', '', '## Purpose', 'Define how compose stacks start.', '', '## Requirements', '',
    '### Requirement: Start order', 'The stack SHALL start db before app and MUST NOT race.', '',
    '#### Scenario: Cold start', '- **WHEN** the stack boots', '- **THEN** db starts first', '',
    '### Requirement: Health', 'Each service MUST expose a health check.', '',
    '#### Scenario: Unhealthy', '- **WHEN** a check fails', '- **THEN** the stack reports failure', '- **AND** exits non-zero',
  ].join('\n')
  const parsed = t.parseSpec(t.stripFrontmatter(SPEC_MD))
  const files = [
    { path: 'compose/spec.md', token: 'os_s1', title: 'Compose', domain: 'compose', purpose: 'Define how compose stacks start.\nSecond line.', requirementCount: 2, scenarioCount: 3, status: 'current' },
    { path: 'agents/spec.md', token: 'os_s2', title: 'Agent Tools', domain: 'agents', purpose: 'Tool registry', requirementCount: 1, scenarioCount: 1, status: 'modified' },
    { path: 'bare.md', token: 'os_s3', title: 'bare.md', domain: 'bare', purpose: '', status: 'added' },
  ]

  // StructuredSpecView — structured, raw and filtered modes
  const sv = t.StructuredSpecView({ content: SPEC_MD })
  const reqCards = find(sv, n => n.props && n.props['data-spec-req'] != null)
  const steps = find(sv, n => n.props && n.props['data-spec-step'] != null)
  const kws = find(sv, n => n.props && n.props['data-spec-keyword'] != null)
  const purposeNode = find(sv, n => n.props && n.props['data-spec-purpose'] === 'true')[0]
  const toggles = find(sv, n => n.props && n.props['data-spec-mode'] != null).map(n => n.props['data-spec-mode'] + ':' + texts(n))
  const filtered = t.StructuredSpecView({ content: SPEC_MD, defaultFilter: 'health' })
  const raw = t.StructuredSpecView({ content: SPEC_MD, defaultMode: 'raw' })
  const plain = t.StructuredSpecView({ content: '# Just text\nno requirements here' })

  // ChangeExplorationsView — dropdown when N>1, direct selection when N===1
  const exs = SRC.openspec.explorations.filter(e => e.scope === 'change:demo').concat([
    { name: 'spike', title: 'Spike Notes', scope: 'change:demo', token: 'os_000009', date: '2026-10-29', filename: 'spike.md', path: '/repos/demoapp/openspec/changes/demo/explorations/spike.md' },
  ])
  const pool = SRC.openspec.explorations.map(e => e.token === 'os_000002' ? Object.assign({}, e, { crewCards: [{ id: 't_pool01', title: 'Pooled', status: 'running', url: '/crew?card=t_pool01' }] }) : e)
  const srcPool = Object.assign({}, SRC, { openspec: Object.assign({}, SRC.openspec, { explorations: pool }) })
  const many = t.ChangeExplorationsView({ api: {}, sourceId: 'src-1', explorations: exs, source: srcPool, allSources: [srcPool], allItems: pool, ctx: {} })
  const manySecond = t.ChangeExplorationsView({ api: {}, sourceId: 'src-1', explorations: exs, source: srcPool, allSources: [srcPool], allItems: pool, ctx: {}, defaultIndex: 1 })
  const one = t.ChangeExplorationsView({ api: {}, sourceId: 'src-1', explorations: [exs[0]], source: srcPool, allSources: [srcPool], allItems: pool, ctx: {} })
  const manySel = find(many, n => n.component === 'select')[0]
  const bodyOf = (node) => find(node, n => n.component === t.ExplorationBody)[0]
  const chipsOf = (node) => find(node, n => n.component === t.CrewCardChips)[0]
  const meta = find(many, n => n.props && n.props['data-exploration-meta'] === 'true')[0]

  // ReviewsView — dropdown when N>1
  const rv2 = t.ReviewsView({ reviews: REVIEWS })
  const rv1 = t.ReviewsView({ reviews: [REVIEWS[1]] })
  const rvSel = find(rv2, n => n.component === 'select')[0]

  // ExplorationDetailDrawer — back-to-change navigation
  const backCalls = []
  const exChange = SRC.openspec.explorations[1]
  const dBack = t.ExplorationDetailDrawer({ api: {}, sourceId: 'src-1', exploration: exChange, source: SRC, allSources: [SRC], allItems: SRC.openspec.explorations, onClose() {}, onBackToChange: (slug) => backCalls.push(slug) })
  const backBtn = find(dBack, n => n.props && n.props['data-back-to-change'] != null)[0]
  backBtn && backBtn.props.onClick && backBtn.props.onClick()
  const dNoHandler = t.ExplorationDetailDrawer({ api: {}, sourceId: 'src-1', exploration: exChange, source: SRC, allSources: [SRC], allItems: SRC.openspec.explorations, onClose() {} })
  const dWorkspace = t.ExplorationDetailDrawer({ api: {}, sourceId: 'src-1', exploration: SRC.openspec.explorations[0], source: SRC, allSources: [SRC], allItems: SRC.openspec.explorations, onClose() {}, onBackToChange: (s) => backCalls.push(s) })
  const bodyWithNav = t.ExplorationBody({ api: {}, sourceId: 'src-1', exploration: exChange, onOpenChange: (slug) => backCalls.push('badge:' + slug) })
  const badgeLink = find(bodyWithNav, n => n.props && n.props['data-change-link'] != null)[0]
  badgeLink && badgeLink.props.onClick && badgeLink.props.onClick()
  badgeLink && badgeLink.props.onKeyDown && badgeLink.props.onKeyDown({ key: 'Enter', preventDefault() {} })

  // ChangeDetailDrawer: Explorations tab renders ChangeExplorationsView (explorations-only change => first tab)
  const prevChange = globalThis.__fixtures.change
  globalThis.__fixtures.change = { data: { name: 'demo', title: 'Demo', explorations: exs } }
  const cdd = t.ChangeDetailDrawer({ api: {}, sourceId: 'src-1', change: SRC.openspec.changes[0], source: srcPool, allSources: [srcPool], allItems: SRC.openspec.changes, ctx: {}, width: 700, onClose() {} })
  const cddView = find(cdd, n => n.component === t.ChangeExplorationsView)[0]
  const cddLegacyRows = find(cdd, n => n.props && n.props['data-exploration-row'] != null).length
  globalThis.__fixtures.change = { data: { name: 'demo', title: 'Demo', specs: [{ path: 'a/spec.md', content: SPEC_MD }] } }
  const cddSpecs = t.ChangeDetailDrawer({ api: {}, sourceId: 'src-1', change: SRC.openspec.changes[0], source: srcPool, allSources: [srcPool], allItems: SRC.openspec.changes, ctx: {}, width: 700, onClose() {} })
  const sdv = find(cddSpecs, n => n.component === t.SpecsDetailView)[0]
  const sdvTree = sdv ? t.SpecsDetailView(sdv.props) : null
  globalThis.__fixtures.change = prevChange

  // SpecsView — rich sidebar cards + filter
  const origUq = globalThis.__uq
  globalThis.__uq = (o) => o.queryKey[1] === 'spec-browser' ? { data: { files, branch: 'main' }, isLoading: false, error: null, refetch() {} } : origUq(o)
  const specsNode = t.SpecsView({ api: {}, sourceId: 'src-1', ctx: {} })
  globalThis.__uq = origUq
  const cards = find(specsNode, n => n.props && n.props['data-spec-card'] != null)
  const cardInfo = cards.map(c => ({
    path: c.props['data-spec-card'],
    text: texts(c),
    purpose: find(c, n => n.props && n.props['data-spec-card-purpose'] === 'true').map(n => ({ text: texts(n), ws: n.props.style && n.props.style.whiteSpace })),
    counts: find(c, n => n.props && n.props['data-spec-card-counts'] === 'true').map(n => texts(n)),
    badges: find(c, n => n.component === sdk.Badge).map(n => texts(n)),
  }))
  const filterInput = find(specsNode, n => n.props && n.props['data-specs-filter'] === 'true')[0]

  return {
    parsed: { title: parsed.title, purpose: parsed.purpose, reqs: parsed.requirements.map(r => ({ name: r.name, scns: r.scenarios.length, steps: r.scenarios.map(s => s.steps.map(x => x.type)) })) },
    filterAll: t.filterSpecFiles(files, '').length,
    filterTitle: t.filterSpecFiles(files, 'agent tools').map(f => f.path),
    filterPath: t.filterSpecFiles(files, 'COMPOSE/').map(f => f.path),
    filterDomain: t.filterSpecFiles(files, 'agents').map(f => f.path),
    filterPurpose: t.filterSpecFiles(files, 'registry').map(f => f.path),
    filterToken: t.filterSpecFiles(files, 'OS_S3').map(f => f.path),
    filterNone: t.filterSpecFiles(files, 'zzz').length,
    countsLabel: [t.specCountsLabel(files[0]), t.specCountsLabel(files[2])],
    reqFilter: t.filterSpecRequirements(parsed.requirements, 'exits non-zero').map(x => 'R' + (x.index + 1)),
    statusBadges: ['current', 'unchanged', 'missing', 'added', 'modified', 'deleted', undefined].map(s => t.specStatusBadgeVisible(s)),
    sv: {
      reqNums: reqCards.map(c => c.props['data-spec-req']),
      stepTypes: steps.map(s => s.props['data-spec-step']),
      stepText: steps.map(s => texts(s)),
      keywords: kws.map(k => k.props['data-spec-keyword']),
      purpose: purposeNode && texts(purposeNode),
      toggles,
      inputs: find(sv, n => n.component === sdk.Input).length,
      noFrontmatter: texts(sv).indexOf('title: x') < 0,
    },
    svFiltered: { reqNums: find(filtered, n => n.props && n.props['data-spec-req'] != null).map(c => c.props['data-spec-req']) },
    svRaw: { structured: find(raw, n => n.props && n.props['data-structured-spec'] === 'true').length, markdown: find(raw, n => n.component === t.MarkdownView).length, toggles: find(raw, n => n.props && n.props['data-spec-mode'] != null).length },
    svPlain: { structured: find(plain, n => n.props && n.props['data-structured-spec'] === 'true').length, markdown: find(plain, n => n.component === t.MarkdownView).length },
    ce: {
      selectCount: find(many, n => n.component === 'select').length,
      options: manySel ? find(manySel, n => n.component === 'option').length : 0,
      optionText: manySel ? find(manySel, n => n.component === 'option').map(o => texts(o)) : [],
      selectedValue: manySel && manySel.props.value,
      bodyName: bodyOf(many) && bodyOf(many).props.exploration.name,
      bodyInline: bodyOf(many) && bodyOf(many).props.inline,
      secondBodyName: bodyOf(manySecond) && bodyOf(manySecond).props.exploration.name,
      metaText: meta ? texts(meta) : '',
      copyRefs: find(many, n => n.component === sdk.CopyButton).map(n => n.props.text),
      chipCards: chipsOf(many) ? chipsOf(many).props.cards.map(c => c.id) : null,
      oneSelectCount: find(one, n => n.component === 'select').length,
      oneBodyName: bodyOf(one) && bodyOf(one).props.exploration.name,
      oneChipsRendered: !!chipsOf(one),
    },
    rv: {
      selectCount: find(rv2, n => n.component === 'select').length,
      options: rvSel ? find(rvSel, n => n.component === 'option').map(o => texts(o)) : [],
      value: rvSel && rvSel.props.value,
      badges: find(rv2, n => n.component === sdk.Badge).map(b => texts(b)),
      mentionsV2: texts(rv2).indexOf('v2') >= 0,
      oneSelectCount: find(rv1, n => n.component === 'select').length,
      oneBadges: find(rv1, n => n.component === sdk.Badge).map(b => texts(b)),
    },
    back: {
      text: backBtn ? texts(backBtn) : null,
      calls: backCalls.slice(),
      noHandlerBtn: find(dNoHandler, n => n.props && n.props['data-back-to-change'] != null).length,
      workspaceBtn: find(dWorkspace, n => n.props && n.props['data-back-to-change'] != null).length,
      badgeRole: badgeLink && badgeLink.props.role,
      badgeText: badgeLink ? texts(badgeLink) : null,
    },
    cdd: { hasView: !!cddView, viewCount: cddView && cddView.props.explorations.length, legacyRows: cddLegacyRows, hasSpecsView: !!sdv, specsStructured: sdvTree ? find(sdvTree, n => n.component === t.StructuredSpecView).length : 0 },
    cards: cardInfo,
    filterInput: !!filterInput,
  }
})

process.stdout.write(JSON.stringify(R))
