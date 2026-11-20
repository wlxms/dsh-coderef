import { readFileSync, globSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'

const file = globSync('D:/dsh-mydsh/dsh-coderef/.dsh-home/sessions/**/session.v3.jsonl.zstd')[0]
const chunks = []
const stream = createZstdDecompress()
stream.on('data', chunk => chunks.push(chunk))
const done = new Promise((resolve, reject) => {
  stream.on('end', resolve)
  stream.on('error', reject)
})
stream.end(readFileSync(file))
await done
const text = Buffer.concat(chunks).toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log('bytes:', text.length, 'lines:', lines.length)
let parsed = 0
const types = {}
for (const line of lines) {
  try {
    const event = JSON.parse(line)
    parsed += 1
    types[event.type] = (types[event.type] ?? 0) + 1
  } catch {
    // fall through
  }
}
console.log('parsed:', parsed, 'types:', types)
