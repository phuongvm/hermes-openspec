#!/usr/bin/env node
/**
 * Headless driver for dashboard/dist/index.js (web dashboard IIFE).
 *
 * Runs the real shipped file against a stub window.__HERMES_PLUGIN_SDK__. A test export is
 * injected into the source text at load time only (the shipped file is not modified), and
 * components are invoked directly with stubbed hooks. Prints one JSON object to stdout.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, '../dashboard/dist/index.js'), 'utf8')

const fetched = []
const registered = {}
const comp = (name) => { const f = function(props) { return { type: f, props: props || {} } }; f.displayName = name; return f }
const C = {}
for (const n of ['Button', 'Card', 'CardContent', 'Badge', 'Input', 'Label', 'Select', 'SelectOption', 'Separator']) C[n] = comp(n)

const sandbox = {
  console,
  navigator: { clipboard: { writeText() { return Promise.resolve() } } },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, isFinite, NaN,
  URLSearchParams,
  encodeURIComponent,
  decodeURIComponent,
  JSON,
  Math,
  Number,
  String,
  Array,
  Object,
  window: {
    location: { hash: '' },
    addEventListener() {}, removeEventListener() {},
    confirm: () => true,
    __HERMES_PLUGINS__: { register(name, component) { registered[name] = component } },
    __HERMES_PLUGIN_SDK__: {
      React: {
        createElement(type, props, ...children) {
          const kids = children.length === 1 ? children[0] : children
          return { type, props: Object.assign({}, props || {}, children.length ? { children: kids } : {}) }
        },
        Component: function() {},
      },
      components: C,
      hooks: {
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useCallback: (f) => f,
        useMemo: (f) => f(),
        useRef: (v) => ({ current: v }),
      },
      utils: { cn: (...a) => a.filter(Boolean).join(' '), isoTimeAgo: (x) => String(x) },
      fetchJSON: (url, opts) => { fetched.push({ url, opts }); return Promise.resolve({}) },
    },
  },
}
sandbox.window.window = sandbox.window
sandbox.React = sandbox.window.__HERMES_PLUGIN_SDK__.React
vm.createContext(sandbox)

const injected = src.replace(/\}\)\(\);\s*$/, 'window.__OS_TEST__ = { ReviewsTab: ReviewsTab, CrewCards: CrewCards, ExplorationList: ExplorationList, ExplorationsPanel: ExplorationsPanel, ChangeDetailTabs: ChangeDetailTabs, DiscoverDialog: DiscoverDialog, ExplorationDialog: ExplorationDialog, Toolbar: Toolbar, Board: Board, DetailDialog: DetailDialog, Modal: Modal, scopeLabel: scopeLabel, verdictClass: verdictClass, sortExplorations: sortExplorations, getExploration: getExploration, discoverSources: discoverSources, renderMarkdown: renderMarkdown, ChangeExplorationsPanel: ChangeExplorationsPanel, StructuredSpecView: StructuredSpecView, SpecCard: SpecCard, filterSpecFiles: filterSpecFiles, specCountsLabel: specCountsLabel };\n})();')
if (injected === src) throw new Error('could not inject test export')
vm.runInContext(injected, sandbox, { filename: 'dashboard/dist/index.js' })
const T = sandbox.window.__OS_TEST__

function walk(node, fn) {
  if (node == null || node === false || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return }
  fn(node)
  walk(node.props && node.props.children, fn)
}
function text(node) {
  const out = []
  const w = (n) => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(w); return }
    if (typeof n.type === 'function' && n.type.name && n.type !== C.Badge && !(n.type in C) && false) return
    w(n.props && n.props.children)
  }
  w(node)
  return out.join(' ')
}
function collect(node, pred) { const out = []; walk(node, n => { if (pred(n)) out.push(n) }); return out }
function expand(node) {
  // Invoke user function components (those not in the SDK component table) so their output is visible.
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  let cur = node
  if (typeof cur.type === 'function' && !Object.values(C).includes(cur.type) && !cur.type.displayName) {
    cur = expand(cur.type(cur.props))
    return cur
  }
  const props = Object.assign({}, cur.props)
  if (props.children !== undefined) props.children = expand(props.children)
  return { type: cur.type, props }
}

const R = {}
R.registered = typeof registered.openspec
R.helpers = {
  scopeWs: T.scopeLabel('workspace'),
  scopeChange: T.scopeLabel('change:demo'),
  verdictApproved: T.verdictClass('APPROVED'),
  verdictRejected: T.verdictClass('REJECTED'),
  verdictOther: T.verdictClass('weird'),
  sorted: T.sortExplorations([{ name: 'a', date: '2026-01-01' }, { name: 'b', date: '2026-10-30' }]).map(x => x.name),
}
T.getExploration('src 1', 'spike', 'change:demo')
T.discoverSources('src 1', true)
R.fetched = fetched.map(f => ({ url: f.url, method: f.opts && f.opts.method, body: f.opts && f.opts.body }))

const reviews = [
  { name: 'findings-v1', filename: 'findings-v1.md', token: 'os_r1', verdict: 'REJECTED', round: 1, content: '# one' },
  { name: 'findings-v2', filename: 'findings-v2.md', token: 'os_r2', verdict: 'APPROVED', round: 2, content: '# two' },
]
{
  const tree = expand(T.ReviewsTab({ reviews }))
  const badges = collect(tree, n => n.type === C.Badge).map(b => text(b))
  const sel = collect(tree, n => n.type === 'select')[0]
  R.reviews = { badges, round: text(tree).indexOf('Round 2') >= 0, options: sel ? collect(sel, n => n.type === 'option').length : 0, optionTexts: sel ? collect(sel, n => n.type === 'option').map(o => text(o)) : [] }
  R.reviewsEmpty = text(T.ReviewsTab({ reviews: [] }))
}
{
  const tree = expand(T.CrewCards({ cards: [{ id: 't_aaa111', title: 'Impl', status: 'running', assignee: 'coder', board: 'crew', url: '/crew?card=t_aaa111' }] }))
  const links = collect(tree, n => n.type === 'a')
  R.crew = { hrefs: links.map(l => l.props.href), text: links.map(l => text(l)), none: T.CrewCards({ cards: [] }) }
}
const SRC = {
  id: 'src-1', name: 'demoapp', valid: true,
  openspec: { explorations: [
    { name: 'old', title: 'Old', scope: 'workspace', token: 'os_1', date: '2026-01-01', filename: 'old.md' },
    { name: 'new', title: 'New', scope: 'change:demo', token: 'os_2', date: '2026-10-30', filename: 'new.md' },
  ] },
}
{
  const picked = []
  const tree = expand(T.ExplorationsPanel({ source: SRC, onSelect: (x) => picked.push(x.name) }))
  const rows = collect(tree, n => n.type === 'button' && n.props.className === 'os-expl-row')
  rows[0] && rows[0].props.onClick()
  R.panel = { rows: rows.length, firstRow: rows[0] ? text(rows[0]) : '', picked, input: collect(tree, n => n.type === C.Input).length }
  R.panelEmpty = text(T.ExplorationsPanel({ source: { name: 'x', openspec: { explorations: [] } }, onSelect() {} }))
}
{
  const detail = { proposal: '# p', tasks: '- [ ] a', design: '# d', specs: [{ path: 'a', content: '' }], reviews, explorations: [SRC.openspec.explorations[1]], crewCards: [{ id: 't_x', url: '/crew?card=t_x', status: 'done' }] }
  const tree = expand(T.ChangeDetailTabs({ detail, anchor: null, onTabChange() {}, source: SRC, onSelectExploration() {} }))
  const tabs = collect(tree, n => n.type === 'button' && /os-tab-btn/.test(n.props.className || '')).map(b => text(b))
  R.tabs = { tabs, crewLinks: collect(tree, n => n.type === 'a').map(a => a.props.href) }
  const bare = expand(T.ChangeDetailTabs({ detail: { proposal: '# p' }, source: SRC }))
  R.tabsBare = collect(bare, n => n.type === 'button' && /os-tab-btn/.test(n.props.className || '')).map(b => text(b))
}
{
  const tree = expand(T.Toolbar({ sources: [{ id: 's', name: 'demoapp', valid: true }], activeId: 's', onSelect() {}, onRefresh() {}, onAdd() {}, onEdit() {}, onRemove() {}, onDiscover() {} }))
  const btn = collect(tree, n => n.type === C.Button && text(n) === 'Discover')[0]
  R.toolbar = { discover: !!btn, disabled: btn ? !!btn.props.disabled : null }
  const treeNo = expand(T.Toolbar({ sources: [], activeId: null, onSelect() {}, onRefresh() {}, onAdd() {}, onEdit() {}, onRemove() {}, onDiscover() {} }))
  const btnNo = collect(treeNo, n => n.type === C.Button && text(n) === 'Discover')[0]
  R.toolbarNoSource = { disabled: btnNo ? !!btnNo.props.disabled : null }
}

{
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    id: 't_' + i, title: 'T' + i, status: ['running', 'review', 'blocked', 'todo', 'done'][i % 5], url: '/crew?card=t_' + i,
  }))
  const collapsed = expand(T.CrewCards({ cards: twenty }))
  const boardSrc = {
    id: 's1', name: 'demoapp', path: '/r', valid: true,
    openspec: {
      ideas: [],
      changes: [
        { id: '1', name: 'beta', title: 'Beta', token: 'os_b', status: 'in_progress', sequence: { position: 1 }, crewCards: [{ id: 'd1', status: 'done', url: '/crew?card=d1' }] },
        { id: '2', name: 'alpha', title: 'Alpha', token: 'os_a', status: 'todo', sequence: { position: 10 }, crewCards: [{ id: 'r1', status: 'running', url: '/crew?card=r1' }] },
      ],
    },
  }
  const btree = expand(T.Board({ source: boardSrc, onSelectItem() {} }))
  const cards = collect(btree, n => n.type === 'button' && /\bos-card\b/.test(n.props.className || ''))
  const dlg = expand(T.DetailDialog({
    source: { id: 's1', name: 'workspaces' },
    item: { name: 'demo', title: 'Demo', token: 'os_e80720', status: 'todo', taskStats: { done: 0, total: 7 }, crewCards: [
      { id: 'c1', status: 'done', url: '/crew?card=c1' }, { id: 'c2', status: 'done', url: '/crew?card=c2' },
      { id: 'c3', status: 'done', url: '/crew?card=c3' }, { id: 'c4', status: 'running', url: '/crew?card=c4' },
      { id: 'c5', status: 'todo', url: '/crew?card=c5' },
    ] },
    onClose() {},
  }))
  R.slice3 = {
    collapsed20Links: collect(collapsed, n => n.type === 'a').length,
    collapsed20Summary: text(collapsed),
    cardOrder: cards.map(c => text(c)),
    firstRadar: cards[0] && cards[0].props['data-radar'],
    secondRadar: (cards[1] && cards[1].props['data-radar']) || null,
    dlgBadges: collect(dlg, n => n.type === C.Badge).map(b => text(b)),
    hasModalSash: collect(dlg, n => n.props && n.props.className === 'os-modal-sash').length === 1,
  }
}

R.slice3bMd = (() => {
  const md = ['# H1', '#### H4', '', '| Name | Qty |', '| :--- | ---: |', '| a | 3 |', '', '> quote line', '', '---', '', 'x *it* _un_ **b** [ok](https://example.com) [bad](javascript:alert(1))'].join('\n')
  return { html: T.renderMarkdown(md) }
})()
// Slice 3c — web surface: inline explorations/reviews dropdowns, back-to-change, rich specs
R.slice3c = (() => {
  const SPEC_MD = [
    '# Compose Specification', '', '## Purpose', 'Define how compose stacks start.', '', '## Requirements', '',
    '### Requirement: Start order', 'The stack SHALL start db before app and MUST NOT race.', '',
    '#### Scenario: Cold start', '- **WHEN** the stack boots', '- **THEN** db starts first', '',
    '### Requirement: Health', 'Each service MUST expose a health check.', '',
    '#### Scenario: Unhealthy', '- **WHEN** a check fails', '- **THEN** the stack reports failure', '- **AND** exits non-zero',
  ].join('\n')
  const files = [
    { path: 'compose/spec.md', token: 'os_s1', title: 'Compose', domain: 'compose', purpose: 'Define how compose stacks start.\nSecond line.', requirementCount: 2, scenarioCount: 3, status: 'current', changed: false },
    { path: 'agents/spec.md', token: 'os_s2', title: 'Agent Tools', domain: 'agents', purpose: 'Tool registry', requirementCount: 1, scenarioCount: 1, status: 'modified', changed: true },
  ]
  const exs = [
    { name: 'a', title: 'Alpha Note', scope: 'change:demo', token: 'os_e1', date: '2026-10-30', filename: 'a.md' },
    { name: 'b', title: 'Beta Note', scope: 'change:demo', token: 'os_e2', date: '2026-10-29', filename: 'b.md' },
  ]
  const SRC2 = { id: 'src-1', name: 'demoapp', valid: true, openspec: { explorations: exs, changes: [{ name: 'demo', token: 'os_c1' }] } }
  const many = expand(T.ChangeExplorationsPanel({ explorations: exs, source: SRC2, onSelect() {} }))
  const one = expand(T.ChangeExplorationsPanel({ explorations: [exs[0]], source: SRC2, onSelect() {} }))
  const manySel = collect(many, n => n.type === 'select')[0]
  const back = []
  const dlg = expand(T.ExplorationDialog({ source: SRC2, item: exs[0], onClose() {}, onBackToChange: (s) => back.push(s) }))
  const backBtn = collect(dlg, n => n.type === 'button' && /os-back-to-change/.test(n.props.className || ''))[0]
  backBtn && backBtn.props.onClick()
  const chip = collect(dlg, n => n.props && /os-change-link/.test(n.props.className || ''))[0]
  chip && chip.props.onClick && chip.props.onClick()
  const wsDlg = expand(T.ExplorationDialog({ source: SRC2, item: Object.assign({}, exs[0], { scope: 'workspace' }), onClose() {}, onBackToChange: (s) => back.push('ws:' + s) }))
  const reviews2 = expand(T.ReviewsTab({ reviews: [
    { name: 'findings-v1', filename: 'findings-v1.md', token: 'os_r1', verdict: 'REJECTED', round: 1, content: '# one' },
    { name: 'findings-v2', filename: 'findings-v2.md', token: 'os_r2', verdict: 'APPROVED', round: 2, content: '# two' },
  ] }))
  const rvSel = collect(reviews2, n => n.type === 'select')[0]
  const reviews1 = expand(T.ReviewsTab({ reviews: [{ name: 'findings-v2', filename: 'findings-v2.md', token: 'os_r2', verdict: 'APPROVED', round: 2, content: '# two' }] }))
  const sv = expand(T.StructuredSpecView({ md: SPEC_MD }))
  const svRaw = expand(T.StructuredSpecView({ md: SPEC_MD, defaultMode: 'raw' }))
  const svPlain = expand(T.StructuredSpecView({ md: '# Plain\nno reqs' }))
  const svFilt = expand(T.StructuredSpecView({ md: SPEC_MD, defaultFilter: 'health' }))
  const card = expand(T.SpecCard({ file: files[1], active: false, onSelect() {} }))
  const cardCur = expand(T.SpecCard({ file: files[0], active: true, onSelect() {} }))
  return {
    filterAll: T.filterSpecFiles(files, '').length,
    filterPath: T.filterSpecFiles(files, 'COMPOSE').map(f => f.path),
    filterPurpose: T.filterSpecFiles(files, 'registry').map(f => f.path),
    filterToken: T.filterSpecFiles(files, 'OS_S2').map(f => f.path),
    filterNone: T.filterSpecFiles(files, 'zzz').length,
    counts: T.specCountsLabel(files[0]),
    ce: {
      selects: collect(many, n => n.type === 'select').length,
      options: manySel ? collect(manySel, n => n.type === 'option').map(o => text(o)) : [],
      oneSelects: collect(one, n => n.type === 'select').length,
      body: collect(many, n => /(^|\s)os-expl-inline(\s|$)/.test((n.props && n.props.className) || '')).length,
      oneBody: collect(one, n => /(^|\s)os-expl-inline(\s|$)/.test((n.props && n.props.className) || '')).length,
    },
    back: {
      text: backBtn ? text(backBtn) : null,
      calls: back.slice(),
      wsButtons: collect(wsDlg, n => n.type === 'button' && /os-back-to-change/.test(n.props.className || '')).length,
    },
    rv: {
      selects: collect(reviews2, n => n.type === 'select').length,
      options: rvSel ? collect(rvSel, n => n.type === 'option').map(o => text(o)) : [],
      oneSelects: collect(reviews1, n => n.type === 'select').length,
      badges: collect(reviews2, n => n.type === C.Badge).map(b => text(b)),
    },
    sv: {
      reqs: collect(sv, n => /(^|\s)os-spec-req(\s|$)/.test((n.props && n.props.className) || '')).length,
      reqNums: collect(sv, n => /os-spec-req-num/.test((n.props && n.props.className) || '')).map(n => text(n)),
      purpose: collect(sv, n => /(^|\s)os-spec-purpose(\s|$)/.test((n.props && n.props.className) || '')).length,
      steps: collect(sv, n => /os-spec-step-label/.test((n.props && n.props.className) || '')).map(n => text(n)),
      keywords: collect(sv, n => /os-spec-kw/.test((n.props && n.props.className) || '')).map(n => text(n)),
      toggles: collect(sv, n => n.type === C.Button).map(n => text(n)),
      filterInputs: collect(sv, n => n.type === C.Input).length,
    },
    svRaw: { reqs: collect(svRaw, n => /(^|\s)os-spec-req(\s|$)/.test((n.props && n.props.className) || '')).length, md: collect(svRaw, n => /(^|\s)os-md(\s|$)/.test((n.props && n.props.className) || '')).length },
    svPlain: { reqs: collect(svPlain, n => /(^|\s)os-spec-req(\s|$)/.test((n.props && n.props.className) || '')).length, md: collect(svPlain, n => /(^|\s)os-md(\s|$)/.test((n.props && n.props.className) || '')).length },
    svFilt: { reqNums: collect(svFilt, n => /os-spec-req-num/.test((n.props && n.props.className) || '')).map(n => text(n)) },
    card: {
      text: text(card),
      purposeCls: collect(card, n => /os-spec-card-purpose/.test((n.props && n.props.className) || '')).length,
      countsCls: collect(card, n => /os-spec-card-counts/.test((n.props && n.props.className) || '')).map(n => text(n)),
      badges: collect(card, n => n.type === C.Badge).map(b => text(b)),
      curBadges: collect(cardCur, n => n.type === C.Badge).map(b => text(b)),
      active: /os-spec-item-active/.test((cardCur.props && cardCur.props.className) || ''),
    },
  }
})()

process.stdout.write(JSON.stringify(R))
