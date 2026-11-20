// Inspect one stored session log: the file is a concatenation of zstd frames,
// one JSON line per frame, so decode each frame individually.
import { readFileSync, globSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = globSync('D:/dsh-mydsh/dsh-coderef/.dsh-home/sessions/**/session.v3.jsonl.zstd')[0]
const data = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= data.length; i++) {
  if (data[i] === magic[0] && data[i + 1] === magic[1] && data[i + 2] === magic[2] && data[i + 3] === magic[3]) starts.push(i)
}
starts.push(data.length)
const lines = []
for (let i = 0; i + 1 < starts.length; i++) {
  try {
    lines.push(zstdDecompressSync(data.subarray(starts[i], starts[i + 1])).toString('utf8').replace(/\n$/, ''))
  } catch (error) {
    console.log('frame', i, 'decode error', error.message)
  }
}
const events = lines.filter(Boolean).map(line => JSON.parse(line))
console.log('frames:', starts.length - 1, 'events:', events.length)
const counts = {}
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
console.log('event types:', counts)

const toolPaths = new Set()
for (const event of events) {
  if (event.type !== 'tool/call') continue
  const args = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments)
  for (const match of args.matchAll(/[A-Za-z]:[\\/][^"'`,\s]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs)/g)) toolPaths.add(match[0])
}
console.log('absolute source paths in tool/call args:', toolPaths.size)
for (const path of [...toolPaths].slice(0, 20)) console.log(' ', path)

for (const event of events.filter(item => item.type === 'tool/call').slice(0, 6)) {
  console.log('tool/call', event.data.name, String(event.data.arguments).slice(0, 220))
}
const assistant = events.filter(event => event.type === 'assistant/message').at(-1)
if (assistant) {
  console.log('assistant content blocks:', (assistant.data.message.content ?? []).map(block => block.type).join(','))
  const text = (assistant.data.message.content ?? []).find(block => block.type === 'text')
  console.log('assistant text head:', (text?.text ?? '').slice(0, 500))
}
