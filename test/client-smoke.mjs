// Client-half smoke test: load the ModuleLoader bundle, inspect the slot registration,
// and exercise the pure decoration helpers without a browser.
import { strict as assert } from 'node:assert'

/** Minimal React stand-in: this smoke test never renders the component. */
const React = {
  useState: () => [null, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  createElement: () => null,
  memo: fn => fn,
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
}

await import('../lib/client.js')
assert.ok(registration !== undefined, 'client bundle must call window.__ModuleLoader__.load')
assert.equal(registration.id, 'dsh-coderef')

const exportsOfBundle = registration.factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-chat') {
    return { AssistantNodeView: function FakeAssistantNodeView() { return null } }
  }
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})

assert.equal(typeof exportsOfBundle.apply, 'function')
assert.deepEqual(exportsOfBundle.inject, ['slots'])

// --- registration options ---------------------------------------------------
const seen = []
const fakeCtx = {
  slots: {
    inject(name, callback) {
      seen.push({ injected: name })
      return callback()
    },
    register(options, component) {
      seen.push({ options, component })
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
  get(name) {
    if (name === 'uiSession') return { adapter: { current: { getSnapshot: () => ({ key: 'session-abc' }) } } }
    return undefined
  },
}
exportsOfBundle.apply(fakeCtx)
const slotEntry = seen.find(entry => entry.options !== undefined)
assert.ok(slotEntry !== undefined, 'apply must register one slot occupant')
assert.equal(slotEntry.options.name, 'conversation.chat.node')
assert.equal(slotEntry.options.key, 'assistant-step')
assert.equal(slotEntry.options.priority, -1)
assert.equal(slotEntry.options.locale, 'chat')
assert.equal(typeof slotEntry.component, 'function')

// --- candidate extraction / rewriting --------------------------------------
const blocks = [
  { kind: 'text', text: '调用 **AssistantNodeView** 与 **Foo.bar**，也提 **UnknownSymbol**。' },
  { kind: 'reasoning', text: '**AssistantNodeView** 不应被改写' },
  { kind: 'text', text: '普通文本，没有加粗 *斜体*。' },
]
const candidates = exportsOfBundle.collectCandidates(blocks)
assert.deepEqual(candidates, ['AssistantNodeView', 'Foo.bar', 'UnknownSymbol'])

// Candidate precision filter: emphasis, tool names, keywords and 1–2 letter caps
// are never sent to the resolver.
const noisy = exportsOfBundle.collectCandidates([
  { kind: 'text', text: '**Important** **read** **OK** **API** **line** **AssistantNodeView**' },
])
assert.deepEqual(noisy, ['API', 'AssistantNodeView'], 'noise tokens are filtered before resolve')

// Resolved items: only `linked` items become clickable; ambiguous stays plain.
const items = new Map([
  ['Linked', { status: 'linked', chosen: { file: 'D:/a.ts', line: 6, kind: 'const', evidence: 'grep' }, candidates: [{}, {}] }],
  ['Ambiguous', { status: 'ambiguous', chosen: { file: 'D:/b.ts', line: 2, kind: 'type' }, candidates: [{}, {}] }],
  ['Unresolved', { status: 'unresolved', chosen: null, candidates: [] }],
])
const linkedOnly = exportsOfBundle.linkedHits(items)
assert.deepEqual([...linkedOnly.keys()], ['Linked'], 'only linked items are mentionable')
assert.equal(linkedOnly.get('Linked').candidateCount, 2)
assert.equal(linkedOnly.get('Linked').evidence, 'grep')
assert.match(exportsOfBundle.formatTitle(linkedOnly.get('Linked')), /grep 命中.*2 个候选/, 'title exposes evidence and candidate count')

// Cross-message resolve cache.
exportsOfBundle.tokenCache.clear()
exportsOfBundle.rememberItem('session-abc', 'D:/x', 'CachedSymbol', { status: 'linked' })
assert.equal(exportsOfBundle.cachedItem('session-abc', 'D:/x', 'CachedSymbol').status, 'linked')
assert.equal(exportsOfBundle.cachedItem('session-abc', 'D:/x', 'Other'), undefined)

const hits = new Map([
  ['AssistantNodeView', { file: 'D:/x/AssistantNodeView.tsx', line: 6, kind: 'const' }],
  ['Foo.bar', { file: 'D:/x/Foo.ts', line: 12, kind: 'member', ambiguous: 2 }],
])
const rewritten = exportsOfBundle.linkifyBlocks(blocks, hits)
assert.equal(rewritten[0].text, '调用 `AssistantNodeView` 与 `Foo.bar`，也提 **UnknownSymbol**。')
assert.equal(rewritten[1], blocks[1], 'reasoning block must stay untouched')
assert.equal(rewritten[2], blocks[2], 'block without candidates must keep identity')
assert.equal(exportsOfBundle.linkifyBlocks(blocks, new Map()), blocks, 'no hits -> identity, no rewrite')

// --- mention resolver composition -------------------------------------------
const baseResolved = []
const baseMentions = () => ({
  resolve(value) {
    if (value !== 'base-file.ts') return undefined
    baseResolved.push(value)
    return { label: value, title: 'base', open: () => {} }
  },
})
const composed = exportsOfBundle.composeMentions(baseMentions, hits, () => ({ openFile: async () => {} }))(undefined)
const mine = composed.resolve('AssistantNodeView')
assert.ok(mine !== undefined)
assert.match(mine.title, /AssistantNodeView\.tsx:6/)
assert.match(composed.resolve('Foo.bar').title, /2 个同名候选/)
assert.equal(composed.resolve('unknown'), undefined)
assert.equal(composed.resolve('base-file.ts').title, 'base', 'fallback to host vocabulary')
assert.equal(composed.resolve('nope'), undefined)

// --- closing-owner gate (only rewrite where the host computes mentions) -----
const closedNode = {
  data: { status: 'settled', finalNode: { seq: 42 }, blocks: [] },
  location: { kind: 'turn', turn: { status: 'closed' } },
}
assert.equal(exportsOfBundle.hasClosingOwner({ node: closedNode }, { closing: { finalNode: { seq: 42 } } }), true)
assert.equal(exportsOfBundle.hasClosingOwner({ node: closedNode }, { closing: { finalNode: { seq: 7 } } }), false)
assert.equal(exportsOfBundle.hasClosingOwner({ node: { ...closedNode, location: { kind: 'turn', turn: { status: 'open' } } } }, { closing: { finalNode: { seq: 42 } } }), false)
assert.equal(exportsOfBundle.hasClosingOwner({ node: { data: { status: 'settled' }, location: closedNode.location } }, undefined), false)

// --- path hints for history-first resolution --------------------------------
const hintBlocks = [
  {
    kind: 'tool-call',
    arguments: JSON.stringify({ path: 'D:/work/repo/packages/ui-chat/AssistantNodeView.tsx' }),
  },
  { kind: 'text', text: '定义在 `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx:6`。' },
  { kind: 'text', text: '无关的内联代码 `assistant-step` 与 `const`。' },
]
const hints = exportsOfBundle.collectHints(hintBlocks, 'D:/work/repo')
assert.ok(hints.includes('D:/work/repo/packages/ui-chat/AssistantNodeView.tsx'), 'tool-call absolute path becomes a hint')
assert.ok(
  hints.some(hint => hint.endsWith('packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx')),
  'inline-code relative path resolves against cwd',
)
assert.ok(!hints.some(hint => hint.endsWith('assistant-step')), 'non-file inline code is not a hint')
assert.deepEqual(exportsOfBundle.collectHints([], undefined), [], 'no blocks -> no hints')

const relativePaths = exportsOfBundle.collectRelativePaths([
  { kind: 'text', text: '定义在 `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx:6`，另有 `src/contract/slots.ts`。' },
  { kind: 'text', text: '绝对路径 `D:/repo/src/a.ts` 与文本 `assistant-step` 不算相对路径提示。' },
])
assert.deepEqual(relativePaths, [
  'packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx',
  'src/contract/slots.ts',
], 'prose-relative source paths are collected; absolute paths and bare words are not')

// --- inline-code candidates (paths become mention chips without rewriting) ---
const inlineBlocks = [{
  kind: 'text',
  text: '查看 `lib/index.js:1216`、`AssistantNodeView.tsx:14-18`、`window.__dshCoderef`、`node test/smoke.mjs`、`**X**`、`stock` 与 `fileMentions`。',
}]
const inlineTokens = exportsOfBundle.collectInlineCandidates(inlineBlocks)
assert.deepEqual(
  inlineTokens,
  ['lib/index.js:1216', 'AssistantNodeView.tsx:14-18', 'window.__dshCoderef', 'fileMentions'],
  'inline candidates keep paths/symbols and drop commands, markdown fragments and stop-words',
)
assert.equal(exportsOfBundle.isInlineCandidate('test/resolution-eval.mjs'), true)
assert.equal(exportsOfBundle.isInlineCandidate('node test/smoke.mjs'), false)
assert.equal(exportsOfBundle.isInlineCandidate('stock'), false)
assert.equal(exportsOfBundle.isInlineCandidate('**X**'), false)
assert.deepEqual(exportsOfBundle.collectInlineCandidates([{ kind: 'reasoning', text: '`lib/client.js` 是 reasoning 块' }]), [], 'reasoning blocks stay untouched')

// Expressions: extractable references inside larger inline code spans are kept.
const expressionTokens = exportsOfBundle.collectInlineCandidates([{
  kind: 'text',
  text: "`require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView`、`findMemberInLines:713`、`composeMentions()`、`EVIDENCE_SCORE`、`:493`、`export const inject = ['webServer']`",
}])
assert.ok(expressionTokens.some(value => value.includes('AssistantNodeView') && value.startsWith('require(')), 'expression with symbol is kept')
assert.ok(expressionTokens.includes('findMemberInLines:713'), 'symbol:line form is kept')
assert.ok(expressionTokens.includes('composeMentions()'), 'call form is kept')
assert.ok(expressionTokens.includes('EVIDENCE_SCORE'), 'plain symbol is kept')
assert.ok(!expressionTokens.includes(':493'), 'bare line suffix stays plain (fused at render time)')
assert.ok(!expressionTokens.some(value => value.includes("inject = ['webServer']")), 'arbitrary statements are filtered')

// Display-time fusion: `` `X`（`:N`） `` becomes one chip.
const fusedBlocks = [{ kind: 'text', text: '`EVIDENCE_SCORE`（`:493`）与 `Unknown`（`:1`）' }]
const fusedHits = new Map([['EVIDENCE_SCORE', { file: 'D:/x/index.js', line: 493, kind: 'const', evidence: 'read', candidateCount: 1 }]])
const fused = exportsOfBundle.fuseLineSuffix(fusedBlocks, fusedHits)
assert.equal(fused.blocks[0].text, '`EVIDENCE_SCORE:493`与 `Unknown`（`:1`）', 'known split reference is fused')
assert.equal(fused.extra.get('EVIDENCE_SCORE:493').line, 493, 'fused hit carries the line')
assert.equal(fused.extra.size, 1, 'unknown split reference is left untouched')

// --- current session discovery ---------------------------------------------
assert.equal(exportsOfBundle.resolveCurrentSessionId(), 'session-abc', 'uiSession binding supplies the session id')

// --- click order: sidebar first (always), IDE last (best effort) ----------
const opened = []
const sequence = []
let fetchCalls = []
globalThis.fetch = async (url, init) => {
  sequence.push('ide')
  fetchCalls.push({ url, body: JSON.parse(init.body) })
  throw new Error('network-down')
}
const props = { cwd: 'D:/x', openFile: async (path, options) => { sequence.push('preview'); opened.push({ path, options }) } }
const composedFallback = exportsOfBundle.composeMentions(undefined, hits, () => props)(undefined)
composedFallback.resolve('AssistantNodeView').open()
await new Promise(resolve => setTimeout(resolve, 20))
assert.deepEqual(sequence, ['preview', 'ide'], 'sidebar preview must run before the IDE attempt')
assert.equal(fetchCalls[0].url, '/coderef/open')
assert.deepEqual(fetchCalls[0].body, { file: 'D:/x/AssistantNodeView.tsx', line: 6, column: 1 })
assert.deepEqual(opened, [{ path: 'D:/x/AssistantNodeView.tsx', options: { line: 6 } }], 'sidebar preview must always open')
assert.equal(exportsOfBundle.debug.lastOpen.previewOpened, true)
assert.equal(exportsOfBundle.debug.lastOpen.ideOpened, false)

// --- IDE succeeds: sidebar jump still happened -----------------------------
sequence.length = 0
opened.length = 0
globalThis.fetch = async () => { sequence.push('ide'); return { ok: true, json: async () => ({ ok: true }) } }
const composedOk = exportsOfBundle.composeMentions(undefined, hits, () => props)(undefined)
composedOk.resolve('AssistantNodeView').open()
await new Promise(resolve => setTimeout(resolve, 20))
assert.deepEqual(sequence, ['preview', 'ide'], 'sidebar jump must not be skipped when the IDE opens')
assert.equal(opened.length, 1, 'preview opens even when IDE succeeds')
assert.equal(exportsOfBundle.debug.lastOpen.ideOpened, true)

// --- preview throws: IDE is still attempted --------------------------------
sequence.length = 0
globalThis.fetch = async () => { sequence.push('ide'); return { ok: true, json: async () => ({ ok: true }) } }
const brokenProps = { cwd: 'D:/x', openFile: async () => { sequence.push('preview'); throw new Error('no-sidebar') } }
const composedBroken = exportsOfBundle.composeMentions(undefined, hits, () => brokenProps)(undefined)
composedBroken.resolve('AssistantNodeView').open()
await new Promise(resolve => setTimeout(resolve, 20))
assert.deepEqual(sequence, ['preview', 'ide'], 'IDE must still be tried when preview fails')
assert.equal(exportsOfBundle.debug.lastOpen.previewOpened, false)
assert.equal(exportsOfBundle.debug.lastOpen.ideOpened, true)

console.log('client-smoke: OK (registration, candidates, rewrite, mention composition, open fallback)')
