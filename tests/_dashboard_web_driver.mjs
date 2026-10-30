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
  setTimeout,
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

const injected = src.replace(/\}\)\(\);\s*$/, 'window.__OS_TEST__ = { ReviewsTab: ReviewsTab, CrewCards: CrewCards, ExplorationList: ExplorationList, ExplorationsPanel: ExplorationsPanel, ChangeDetailTabs: ChangeDetailTabs, DiscoverDialog: DiscoverDialog, ExplorationDialog: ExplorationDialog, Toolbar: Toolbar, scopeLabel: scopeLabel, verdictClass: verdictClass, sortExplorations: sortExplorations, getExploration: getExploration, discoverSources: discoverSources };\n})();')
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
  R.reviews = { badges, round: text(tree).indexOf('Round 2') >= 0, buttons: collect(tree, n => n.type === 'button').length }
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

process.stdout.write(JSON.stringify(R))
