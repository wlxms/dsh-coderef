// The reference table must describe the visible answer body only. Files and
// commands mentioned in a collapsed reasoning block are still folded as
// evidence, but they must stay out of the user-facing reference list.
import { strict as assert } from 'node:assert'
import { createReferenceLedger, foldReferenceEvents, summarizeReferences } from '../lib/references.js'
import { parseGrepResult, parseReadResult, flattenToolResult } from '../lib/index.js'

const parsers = { parseGrepResult, parseReadResult, flattenToolResult }
const ledger = createReferenceLedger('D:\\repo', 'reasoning-visibility-session')

foldReferenceEvents(ledger, [{
  seq: 1,
  type: 'assistant/message',
  data: {
    message: {
      content: [
        { type: 'reasoning', text: 'Use `npm run secret` and read `D:\\repo\\secret.ts`.' },
        { type: 'text', text: 'Use `npm run visible` and read `D:\\repo\\visible.ts`.' },
      ],
    },
  },
}], parsers)

const summary = summarizeReferences(ledger)
const commands = summary.refs.commands
const files = summary.refs.files

assert.ok(!commands.some(ref => ref.command === 'npm run secret'), 'reasoning command must not be collected')
assert.ok(commands.some(ref => ref.command === 'npm run visible'), 'body command must be collected')
assert.equal(commands.find(ref => ref.command === 'npm run secret')?.visible ?? false, false, 'reasoning command must not be visible')
assert.equal(commands.find(ref => ref.command === 'npm run visible')?.visible ?? false, true, 'body command must be visible')

assert.ok(!files.some(ref => ref.path === 'D:\\repo\\secret.ts'), 'reasoning file must not be collected')
assert.ok(files.some(ref => ref.path === 'D:\\repo\\visible.ts'), 'body file must be collected')
assert.equal(files.find(ref => ref.path === 'D:\\repo\\secret.ts')?.visible ?? false, false, 'reasoning file must not be visible')
assert.equal(files.find(ref => ref.path === 'D:\\repo\\visible.ts')?.visible ?? false, true, 'body file must be visible')

console.log('reasoning-visibility-smoke: OK (reasoning files/commands stay out of the reference table)')

