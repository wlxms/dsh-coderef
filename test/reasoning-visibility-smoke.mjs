// The reference table must describe the visible answer body only. Files and
// commands mentioned in a collapsed reasoning block are not collected at all,
// and only existing files may become visible.
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReferenceLedger, foldReferenceEvents, summarizeReferences } from '../lib/references.js'
import { parseGrepResult, parseReadResult, flattenToolResult } from '../lib/index.js'

const parsers = { parseGrepResult, parseReadResult, flattenToolResult }
const root = mkdtempSync(join(tmpdir(), 'coderef-reasoning-'))
try {
  const secretFile = join(root, 'secret.ts')
  const visibleFile = join(root, 'visible.ts')
  const ghostFile = join(root, 'Ghost.cs')
  writeFileSync(secretFile, 'export const secret = 1\n')
  writeFileSync(visibleFile, 'export const visible = 1\n')

  const ledger = createReferenceLedger(root, 'reasoning-visibility-session')
  foldReferenceEvents(ledger, [{
    seq: 1,
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: `Use \`npm run secret\` and read \`${secretFile}\`.` },
          { type: 'text', text: `Use \`npm run visible\`, read \`${visibleFile}\`, and note \`${ghostFile}\`.` },
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

  assert.ok(!files.some(ref => ref.path === secretFile), 'reasoning file must not be collected')
  assert.ok(files.some(ref => ref.path === visibleFile), 'body file must be collected')
  assert.equal(files.find(ref => ref.path === secretFile)?.visible ?? false, false, 'reasoning file must not be visible')
  assert.equal(files.find(ref => ref.path === visibleFile)?.visible ?? false, true, 'existing body file must be visible')
  const ghost = files.find(ref => ref.path === ghostFile)
  assert.ok(ghost !== undefined, 'body path is still captured as evidence')
  assert.equal(ghost.absPath, ghostFile, 'body path keeps its absolute location')
  assert.equal(ghost.exists, false, 'missing file is marked as missing')
  assert.equal(ghost.visible, false, 'missing file must not appear in the reference table')

  console.log('reasoning-visibility-smoke: OK (reasoning files/commands stay out of the reference table)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
