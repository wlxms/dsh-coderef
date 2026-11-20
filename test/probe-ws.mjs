const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(target => target.type === 'page')
console.log('target', page?.id, page?.webSocketDebuggerUrl)
const url = page.webSocketDebuggerUrl
const ws = new WebSocket(url)
const timer = setTimeout(() => {
  console.log('WS TIMEOUT state=', ws.readyState)
  process.exit(2)
}, 8000)
ws.addEventListener('open', () => {
  console.log('WS OPEN')
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }))
})
ws.addEventListener('message', event => {
  console.log('WS MESSAGE', String(event.data).slice(0, 300))
  clearTimeout(timer)
  process.exit(0)
})
ws.addEventListener('error', event => {
  console.log('WS ERROR', event?.message ?? event?.error?.message ?? 'unknown')
  clearTimeout(timer)
  process.exit(1)
})
ws.addEventListener('close', event => {
  console.log('WS CLOSE', event.code, event.reason)
  clearTimeout(timer)
  process.exit(3)
})
