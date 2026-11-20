// End-to-end check against the running local prototype:
// boot the GUI in headless Chrome, open the existing test session, and inspect
// whether the bold code references became clickable mentions.
// usage: node test/e2e-check.mjs <token> ; env CDP_BASE=https://127.0.0.1:9333
import { strict as assert } from 'node:assert'

const token = process.argv[2]
assert.ok(typeof token === 'string' && token.length > 10, 'usage: node test/e2e-check.mjs <token>')
const cdpBase = process.env.CDP_BASE ?? 'http://127.0.0.1:9333'

const targets = await (await fetch(`${cdpBase}/json/list`)).json()
const page = targets.find(target => target.type === 'page')
assert.ok(page !== undefined, 'no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
const consoleLines = []
const errors = []
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const handler = pending.get(message.id)
    if (handler === undefined) return
    pending.delete(message.id)
    message.error !== undefined ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push((message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '))
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception')
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return result.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:3080/?token=${encodeURIComponent(token)}` })
await new Promise(resolve => setTimeout(resolve, 7000))

const opened = await evaluate(`(async () => {
  const byLabel = label => [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === label)
  byLabel('打开侧边栏')?.click()
  await new Promise(r => setTimeout(r, 1200))
  const row = [...document.querySelectorAll('div')].find(e => /sessionRow/.test(String(e.className)) && (e.textContent || '').includes('加粗列出两个符号'))
  row?.click()
  await new Promise(r => setTimeout(r, 4000))
  return true
})()`)
assert.equal(opened, true)

const state = await evaluate(`(() => {
  const mentionButtons = [...document.querySelectorAll('button[title]')]
    .map(b => ({ title: b.title, text: (b.textContent || '').trim() }))
    .filter(b => /\\.(tsx?|jsx?):\\d+/.test(b.title))
  return {
    coderef: window.__dshCoderef ?? null,
    rawAsterisks: (document.body.innerText || '').includes('**AssistantNodeView**'),
    strongCount: document.querySelectorAll('strong').length,
    mentionButtons,
    bodyTail: (document.body.innerText || '').slice(0, 1400),
  }
})()`)

console.log(JSON.stringify({
  coderef: state.coderef,
  rawAsterisks: state.rawAsterisks,
  strongCount: state.strongCount,
  mentionButtons: state.mentionButtons,
  consoleErrors: errors,
  coderefConsole: consoleLines.filter(line => line.includes('dsh-coderef')),
  bodyTail: state.bodyTail,
}, null, 2))

assert.equal(state.rawAsterisks, false, 'raw **X** must not remain in rendered text')
assert.ok(state.mentionButtons.length >= 3, `expected several mention buttons, got ${state.mentionButtons.length}`)
assert.ok(
  state.mentionButtons.some(button => button.title.replace(/\\/g, '/').includes('lib/index.js:1216')),
  `inline code path mention expected: ${JSON.stringify(state.mentionButtons)}`,
)
assert.ok(
  state.mentionButtons.some(button => button.title.includes('AssistantNodeView.tsx:14')),
  'inline code basename mention expected',
)
assert.ok(
  state.mentionButtons.some(button => button.text === 'findMemberInLines:713'),
  `symbol:line inline token expected: ${JSON.stringify(state.mentionButtons.map(button => button.text))}`,
)
assert.ok(
  state.mentionButtons.some(button => button.text.includes('EVIDENCE_SCORE:493')),
  'split `X`（`:N`） reference should fuse into one chip',
)
assert.ok(
  state.mentionButtons.some(button => button.text.includes('require(') && button.text.includes('AssistantNodeView') && button.title.includes('AssistantNodeView.tsx')),
  'expression token should resolve to its inner symbol',
)
assert.ok(
  state.mentionButtons.some(button => button.text.includes("useTurnData('turn-tail')") && button.title.includes('AssistantNodeView.tsx:16')),
  `paraphrased snippet should link to the read line: ${JSON.stringify(state.mentionButtons.map(button => button.text))}`,
)
assert.ok((state.coderef?.lastResolve?.inlineLinked ?? 0) >= 10, 'inline resolver must link many tokens')
assert.ok(errors.filter(text => !/favicon/i.test(text)).length === 0, `console errors: ${JSON.stringify(errors)}`)

// Click an inline path chip: the sidebar fallback must open the file AND ping
// (highlight) the jumped-to line, not just scroll.
const ping = await evaluate(`(async () => {
  const button = [...document.querySelectorAll('button[title]')]
    .find(candidate => candidate.title.replace(/\\\\/g, '/').includes('lib/index.js:1216'));
  if (button === undefined) return { clicked: false };
  button.click();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (document.querySelectorAll('.dsh-coderef-line-ping').length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const marked = [...document.querySelectorAll('.dsh-coderef-line-ping')];
  const allLines = [...document.querySelectorAll('[data-code-preview] pre .line')];
  const rowIndex = marked.length > 0 ? allLines.indexOf(marked[0]) : -1;
  return {
    clicked: true,
    count: marked.length,
    text: marked.slice(0, 3).map(row => (row.textContent || '').trim().slice(0, 100)),
    lineNumber: rowIndex >= 0 ? rowIndex + 1 : null,
    lastPing: window.__dshCoderef?.lastPing ?? null,
    lastOpen: window.__dshCoderef?.lastOpen ?? null,
    previewOpen: allLines.length > 0,
  };
})()`)
assert.equal(ping.clicked, true, 'inline chip must be clickable')
assert.equal(ping.previewOpen, true, 'sidebar code preview must open on click')
assert.equal(ping.lastOpen?.previewOpened, true, 'sidebar jump must happen before/independent of the IDE attempt')
assert.ok(ping.count >= 1, `jumped line must be highlighted (ping), got ${JSON.stringify(ping)}`)
assert.equal(ping.lastPing?.line, 1216, `ping must target the requested line: ${JSON.stringify(ping.lastPing)}`)
assert.equal(ping.lineNumber, 1216, `highlighted DOM row must be source line 1216: ${JSON.stringify({ lineNumber: ping.lineNumber, text: ping.text })}`)

ws.close()
console.log('e2e-check: OK (bold + inline-code references became clickable mentions, line ping works)')
process.exit(0)
