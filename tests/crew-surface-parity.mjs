#!/usr/bin/env node
/**
 * Cross-surface parity guard for Slice 3 Crew activity helpers.
 *
 * desktop/plugin.js (uncompiled ESM) and dashboard/dist/index.js (plain IIFE) intentionally
 * keep parallel definitions of groupCrewCardsByStatus, itemActivityRank, effectiveChangeStatus,
 * and sortItems. This suite loads both real files and asserts deep-equal outputs across one
 * shared fixture matrix so any semantic drift fails CI immediately.
 */
import { deepStrictEqual } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Load Desktop ESM surface ─────────────────────────────────────────────────
const desktopSrc = readFileSync(resolve(__dirname, '../desktop/plugin.js'), 'utf8')
const sdkNames = [
  'Codicon', 'Loader', 'EmptyState', 'ErrorState', 'Badge', 'Button',
  'CopyButton', 'Dialog', 'DialogContent', 'Input', 'ScrollArea', 'SearchField',
  'Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue',
  'SegmentedControl', 'Tabs', 'TabsList', 'TabsTrigger',
]
const sdkShim = sdkNames.map(n => 'export const ' + n + '=(...a)=>a').join(';')
  + ';export const useQuery=()=>({data:undefined,isLoading:false,error:null,refetch(){}})'
  + ';export function cn(...a){return a.filter(Boolean).join(" ")}'
  + ';export const host={navigate(){}}'
  + ';export const ROUTES_AREA="routes";export const SIDEBAR_NAV_AREA="sidebar.nav";export const STATUSBAR_AREAS={right:"statusBar.right"};export default {}'
const reactShim = 'export function useState(v){return[v,()=>{}]};export function useEffect(){};export function useRef(v){return{current:v}};export function useCallback(f){return f};export function useMemo(f){return f()};export default {useState,useEffect,useRef,useCallback,useMemo}'
const jsxShim = 'export function jsx(c,p,k){return{component:c,props:p,key:k,_t:"jsx"}};export function jsxs(c,p,k){return{component:c,props:p,key:k,_t:"jsxs"}};export function Fragment(p){return p&&p.children}'

const blob = desktopSrc
  .replace(/from\s+['"]@hermes\/plugin-sdk['"]/g, "from 'data:text/javascript," + encodeURIComponent(sdkShim) + "'")
  .replace(/from\s+['"]react\/jsx-runtime['"]/g, "from 'data:text/javascript," + encodeURIComponent(jsxShim) + "'")
  .replace(/from\s+['"]react['"]/g, "from 'data:text/javascript," + encodeURIComponent(reactShim) + "'")
const desktop = (await import('data:text/javascript,' + encodeURIComponent(blob))).__test

// ── Load Web IIFE surface ────────────────────────────────────────────────────
const webSrc = readFileSync(resolve(__dirname, '../dashboard/dist/index.js'), 'utf8')
const C = {}
for (const n of ['Button', 'Card', 'CardContent', 'Badge', 'Input', 'Label', 'Select', 'SelectOption', 'Separator']) {
  C[n] = function(props) { return { type: n, props: props || {} } }
}
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Number, String, Array, Object, isFinite, NaN,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  window: {
    location: { hash: '' }, addEventListener() {}, removeEventListener() {}, confirm: () => true,
    __HERMES_PLUGINS__: { register() {} },
    __HERMES_PLUGIN_SDK__: {
      React: { createElement: (t, p, ...c) => ({ type: t, props: Object.assign({}, p, { children: c }) }), Component: function() {} },
      components: C,
      hooks: { useState: v => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useCallback: f => f, useMemo: f => f(), useRef: v => ({ current: v }) },
      utils: { cn: (...a) => a.filter(Boolean).join(' '), isoTimeAgo: String },
      fetchJSON: () => Promise.resolve({}),
    },
  },
}
sandbox.window.window = sandbox.window
sandbox.React = sandbox.window.__HERMES_PLUGIN_SDK__.React
vm.createContext(sandbox)
const injected = webSrc.replace(/\}\)\(\);\s*$/, 'window.__PARITY__ = { groupCrewCardsByStatus: groupCrewCardsByStatus, itemActivityRank: itemActivityRank, effectiveChangeStatus: effectiveChangeStatus, sortItems: sortItems }; })();')
if (injected === webSrc) throw new Error('Failed to inject parity export into dashboard/dist/index.js')
vm.runInContext(injected, sandbox, { filename: 'dashboard/dist/index.js' })
const web = sandbox.window.__PARITY__

// ── Shared fixture matrix ────────────────────────────────────────────────────
const card = (id, status, extra) => Object.assign({ id, title: 'Task ' + id, status, assignee: 'coder', board: 'crew', url: '/crew?card=' + id }, extra || {})

const MIXED_20 = [
  card('t_01', 'running'), card('t_02', 'RUNNING'), card('t_03', 'review'), card('t_04', 'review'),
  card('t_05', 'blocked'), card('t_06', 'triage'), card('t_07', 'todo'), card('t_08', 'ready'),
  card('t_09', 'scheduled'), card('t_10', 'queued'), card('t_11', 'done'), card('t_12', 'completed'),
  card('t_13', 'done'), card('t_14', 'done'), card('t_15', 'done'), card('t_16', 'todo'),
  card('t_17', 'review'), card('t_18', 'blocked'), card('t_19', 'done'), card('t_20', 'ready'),
  card('t_arch', 'archived'), // archived cards are excluded from active totals on both surfaces
]

const CARD_SETS = {
  undefinedCards: undefined,
  empty: [],
  runningOnly: [card('r1', 'running'), card('r2', 'running')],
  reviewOnly: [card('v1', 'review')],
  blockedAndTriage: [card('b1', 'blocked'), card('b2', 'triage')],
  queuedOnly: [card('q1', 'todo'), card('q2', 'ready')],
  doneOnly: [card('d1', 'done'), card('d2', 'completed')],
  archivedOnly: [card('a1', 'archived')],
  mixed20: MIXED_20,
}

const ITEMS_FOR_STATUS_AND_RANK = [
  { label: 'todo+empty', item: { name: 'c1', title: 'C1', status: 'todo', crewCards: [] } },
  { label: 'todo+running', item: { name: 'c2', title: 'C2', status: 'todo', crewCards: CARD_SETS.runningOnly } },
  { label: 'draft+review', item: { name: 'c3', title: 'C3', status: 'draft', crewCards: CARD_SETS.reviewOnly } },
  { label: 'draft+done', item: { name: 'c4', title: 'C4', status: 'draft', crewCards: CARD_SETS.doneOnly } },
  { label: 'todo+blocked', item: { name: 'c5', title: 'C5', status: 'todo', crewCards: CARD_SETS.blockedAndTriage } },
  { label: 'draft+queued', item: { name: 'c6', title: 'C6', status: 'draft', crewCards: CARD_SETS.queuedOnly } },
  { label: 'archived+running', item: { name: 'c7', title: 'C7', status: 'archived', crewCards: CARD_SETS.runningOnly } },
  { label: 'done+running', item: { name: 'c8', title: 'C8', status: 'done', crewCards: CARD_SETS.runningOnly } },
  { label: 'ideas+running', item: { name: 'c9', title: 'C9', status: 'ideas', crewCards: CARD_SETS.runningOnly } },
  { label: 'in_progress+empty', item: { name: 'c10', title: 'C10', status: 'in_progress', crewCards: [] } },
  { label: 'todo+mixed20', item: { name: 'c11', title: 'C11', status: 'todo', crewCards: MIXED_20 } },
]

const SORT_FIXTURES = {
  // Active running outranks lower sequence idle/done/review/blocked/queued
  activityLadder: [
    { name: 'idle-seq1', title: 'Idle First Seq', sequence: { position: 1 }, status: 'in_progress', crewCards: [] },
    { name: 'done-seq2', title: 'Done Only', sequence: { position: 2 }, status: 'todo', crewCards: CARD_SETS.doneOnly },
    { name: 'queued-seq3', title: 'Queued', sequence: { position: 3 }, status: 'todo', crewCards: CARD_SETS.queuedOnly },
    { name: 'blocked-seq4', title: 'Blocked', sequence: { position: 4 }, status: 'todo', crewCards: CARD_SETS.blockedAndTriage },
    { name: 'review-seq5', title: 'In Review', sequence: { position: 5 }, status: 'todo', crewCards: CARD_SETS.reviewOnly },
    { name: 'running-seq10', title: 'Running Work', sequence: { position: 10 }, status: 'todo', crewCards: CARD_SETS.runningOnly },
  ],
  // Equal-rank ties broken by sequence.position, then case-insensitive title/name
  tieBreakers: [
    { name: 'z-no-seq', title: 'zeta', sequence: null, crewCards: CARD_SETS.runningOnly },
    { name: 'a-no-seq', title: 'Alpha', crewCards: CARD_SETS.runningOnly },
    { name: 'seq2-b', title: 'Bravo', sequence: { position: 2 }, crewCards: CARD_SETS.runningOnly },
    { name: 'seq2-a', title: 'able', sequence: { position: 2 }, crewCards: CARD_SETS.runningOnly },
    { name: 'seq1', title: 'Zulu', sequence: { position: 1 }, crewCards: CARD_SETS.runningOnly },
  ],
  // Spec scenario: alpha (0/7, seq 10, running) vs beta (2/5, seq 1, done-only)
  specAlphaBeta: [
    { name: 'beta', title: 'Beta', sequence: { position: 1 }, status: 'in_progress', crewCards: CARD_SETS.doneOnly },
    { name: 'alpha', title: 'Alpha', sequence: { position: 10 }, status: 'todo', crewCards: CARD_SETS.runningOnly },
  ],
}

let passed = 0
let failed = 0
function assertParity(name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (e) {
    failed++
    console.error('  FAIL  ' + name + ': ' + (e && e.message || e))
  }
}

console.log('=== Cross-surface parity: desktop/plugin.js <-> dashboard/dist/index.js ===\n')

for (const fnName of ['groupCrewCardsByStatus', 'itemActivityRank', 'effectiveChangeStatus', 'sortItems']) {
  assertParity('Both surfaces expose ' + fnName, () => {
    if (typeof desktop[fnName] !== 'function') throw new Error('missing on desktop: ' + fnName)
    if (typeof web[fnName] !== 'function') throw new Error('missing on web: ' + fnName)
  })
}

for (const [label, cards] of Object.entries(CARD_SETS)) {
  assertParity('groupCrewCardsByStatus parity [' + label + ']', () => {
    const d = desktop.groupCrewCardsByStatus(cards)
    const w = structuredClone(web.groupCrewCardsByStatus(cards))
    deepStrictEqual(d, w)
  })
}

assertParity('groupCrewCardsByStatus 20-card counts and activeState', () => {
  const g = desktop.groupCrewCardsByStatus(MIXED_20)
  deepStrictEqual(
    { total: g.total, running: g.running.length, review: g.review.length, blocked: g.blocked.length, queued: g.queued.length, done: g.done.length, activeState: g.activeState },
    { total: 20, running: 2, review: 3, blocked: 3, queued: 6, done: 6, activeState: 'running' }
  )
})

for (const { label, item } of ITEMS_FOR_STATUS_AND_RANK) {
  assertParity('itemActivityRank + effectiveChangeStatus parity [' + label + ']', () => {
    deepStrictEqual(desktop.itemActivityRank(item), web.itemActivityRank(item))
    deepStrictEqual(desktop.effectiveChangeStatus(item), web.effectiveChangeStatus(item))
  })
}

assertParity('Promotion semantics: todo/draft with running/review/done -> in-progress; archived/blocked/queued unchanged', () => {
  const byLabel = Object.fromEntries(ITEMS_FOR_STATUS_AND_RANK.map(x => [x.label, desktop.effectiveChangeStatus(x.item)]))
  deepStrictEqual(byLabel, {
    'todo+empty': 'todo',
    'todo+running': 'in-progress',
    'draft+review': 'in-progress',
    'draft+done': 'in-progress',
    'todo+blocked': 'todo',
    'draft+queued': 'draft',
    'archived+running': 'archived',
    'done+running': 'done',
    'ideas+running': 'ideas',
    'in_progress+empty': 'in-progress',
    'todo+mixed20': 'in-progress',
  })
})

for (const [label, list] of Object.entries(SORT_FIXTURES)) {
  assertParity('sortItems parity [' + label + ']', () => {
    const d = desktop.sortItems(list)
    const w = structuredClone(web.sortItems(list))
    deepStrictEqual(d, w)
  })
}

assertParity('sortItems exact order: running -> review -> blocked -> queued -> idle, then sequence, then lowercase title', () => {
  deepStrictEqual(
    desktop.sortItems(SORT_FIXTURES.activityLadder).map(i => i.name),
    ['running-seq10', 'review-seq5', 'blocked-seq4', 'queued-seq3', 'idle-seq1', 'done-seq2']
  )
  deepStrictEqual(
    desktop.sortItems(SORT_FIXTURES.tieBreakers).map(i => i.name),
    ['seq1', 'seq2-a', 'seq2-b', 'a-no-seq', 'z-no-seq']
  )
  deepStrictEqual(
    desktop.sortItems(SORT_FIXTURES.specAlphaBeta).map(i => i.name),
    ['alpha', 'beta']
  )
})

// Self-check that divergence detection is non-vacuous
assertParity('Divergence detector rejects mismatched outputs', () => {
  let caught = false
  try { deepStrictEqual(['alpha', 'beta'], ['beta', 'alpha']) } catch { caught = true }
  if (!caught) throw new Error('deepStrictEqual did not throw on divergent order')
})

console.log('\n=== Parity results: ' + passed + ' passed, ' + failed + ' failed ===')
process.exit(failed > 0 ? 1 : 0)
