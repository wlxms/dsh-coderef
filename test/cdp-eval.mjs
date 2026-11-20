// One-off CDP evaluator: connects to the first page target and prints one expression result.
// usage: node test/cdp-eval.mjs "<js expression>"
const expression = process.argv[2]
if (typeof expression !== 'string' || expression.length === 0) throw new Error('usage: node test/cdp-eval.mjs "<expression>"')

const cdpBase = process.env.CDP_BASE ?? 'http://127.0.0.1:9222'
const targets = await (await fetch(`${cdpBase}/json/list`)).json()
const page = targets.find(target => target.type === 'page')
if (page === undefined) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const handler = pending.get(message.id)
  if (handler === undefined) return
  pending.delete(message.id)
  message.error !== undefined ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Runtime.enable')
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(result.result?.value ?? result, null, 2))
ws.close()
process.exit(0)
