// Inspect one stored session log (zstd JSONL) for tool paths and assistant block shapes.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { globSync } from 'node:fs'

const file = globSync('D:/dsh-mydsh/dsh-coderef/.dsh-home/sessions/**/session.v3.jsonl.zstd')[0]
console.log('session file:', file)
const compressed = readFileSync(file); console.log('compressed bytes:', compressed.length); let raw = ''; try { raw = zstdDecompressSync(compressed).toString('utf8') } catch (error) { console.log('zstd err', error.message) }; console.log('raw bytes:', raw.length); console.log('raw head:', JSON.stringify(raw.slice(0, 300))); console.log('raw tail:', JSON.stringify(raw.slice(-300)))
const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
console.log('events:', events.length, 'types:', [...new Set(events.map(e => e.type))].join(','))

const toolPaths = new Set()
for (const event of events) {
  if (event.type === 'tool/call') {
    const data = event.data
    const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments)
    for (const match of args.matchAll(/[A-Za-z]:[\\/][^"'`,\s]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs)/g)) toolPaths.add(match[0])
    if (data.name === 'read' || data.name === 'grep' || data.name === 'glob') console.log('tool/call', data.name, args.slice(0, 200))
  }
  if (event.type === 'tool/result') {
    const data = event.data
    const text = JSON.stringify(data).slice(0, 0)
    void text
  }
}
console.log('absolute source paths in tool args:', toolPaths.size)
for (const path of [...toolPaths].slice(0, 20)) console.log(' ', path)

const assistant = events.filter(event => event.type === 'assistant/message').at(-1)
if (assistant) {
  console.log('assistant blocks:', JSON.stringify(assistant.data.message.content, (key, value) => key === 'arguments' ? String(value).slice(0, 160) : value, 1).slice(0, 3000))
}
console.log('first 5 events:', events.slice(0, 5).map(e => e.type).join(', '))
