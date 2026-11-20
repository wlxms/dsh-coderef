// Browser smoke test over the Chrome DevTools Protocol:
// boots the local DSH GUI, waits for the client module table, and reports
// whether the dsh-coderef client half loaded without console errors.
// Usage: node test/browser-smoke.mjs <token> [waitMs]
import { strict as assert } from 'node:assert'

const token = process.argv[2]
const waitMs = Number(process.argv[3] ?? 20000)
assert.ok(typeof token === 'string' && token.length > 10, 'usage: node test/browser-smoke.mjs <token> [waitMs]')

async function pollJson(url, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // Chrome is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`timeout waiting for ${url}`)
}

const cdpBase = process.env.CDP_BASE ?? 'http://127.0.0.1:9222'
const targets = await pollJson(`${cdpBase}/json/list`, 20000)
const page = targets.find(target => target.type === 'page')
assert.ok(page !== undefined, 'no page target in headless Chrome')
assert.ok(typeof page.webSocketDebuggerUrl === 'string')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const consoleLines = []
const errors = []
const networkFailures = []
const events = []

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const handler = pending.get(message.id)
    if (handler !== undefined) {
      pending.delete(message.id)
      if (message.error !== undefined) handler.reject(new Error(JSON.stringify(message.error)))
      else handler.resolve(message.result)
    }
    return
  }
  events.push(message.method)
  if (message.method === 'Runtime.consoleAPICalled') {
    const parts = (message.params.args ?? []).map(arg => arg.value ?? arg.description ?? arg.type)
    consoleLines.push({ type: message.params.type, text: parts.join(' ') })
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception')
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    errors.push(message.params.entry.text)
  } else if (message.method === 'Network.loadingFailed') {
    networkFailures.push(message.params.errorText)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Network.enable')
await send('Page.navigate', { url: `http://127.0.0.1:3080/?token=${encodeURIComponent(token)}` })

// Give the shell time to boot the client module graph and run plugin apply().
await new Promise(resolve => setTimeout(resolve, waitMs))

const evaluated = await send('Runtime.evaluate', {
  expression: `(() => ({
    href: location.href,
    title: document.title,
    boot: typeof window.__DSH_BOOT__,
    coderef: window.__dshCoderef === undefined ? null : {
      version: window.__dshCoderef.version,
      stock: window.__dshCoderef.stock,
      resolves: window.__dshCoderef.resolves,
      lastError: window.__dshCoderef.lastError,
      requireProbe: window.__dshCoderef.requireProbe,
    },
    markdownNodes: document.querySelectorAll('.markdown').length,
    flowItems: document.querySelectorAll('[data-chat-flow-kind]').length,
  }))()`,
  returnByValue: true,
})

const value = evaluated.result?.value ?? {}
const coderefConsoleLines = consoleLines.filter(line => line.text.includes('dsh-coderef'))
const summary = {
  url: value.href,
  title: value.title,
  bootManifest: value.boot,
  coderefDebug: value.coderef,
  coderefConsole: coderefConsoleLines,
  markdownNodes: value.markdownNodes,
  flowItems: value.flowItems,
  consoleErrors: errors,
  networkFailures: [...new Set(networkFailures)].slice(0, 8),
  totalConsoleLines: consoleLines.length,
}
console.log(JSON.stringify(summary, null, 2))

assert.equal(value.boot, 'object', 'boot manifest must be present')
assert.ok(coderefConsoleLines.length > 0, 'dsh-coderef client half must log its load')
assert.ok(errors.filter(text => !/favicon/i.test(text)).length === 0, `console errors: ${JSON.stringify(errors)}`)
assert.equal(value.coderef?.version, '0.0.1')
assert.ok(
  ['unknown', 'ok', 'missing'].includes(value.coderef?.stock),
  `unexpected stock state: ${JSON.stringify(value.coderef)}`,
)

ws.close()
console.log('browser-smoke: OK (client half loaded in a real browser, zero console errors)')
process.exit(0)
