// Regression: a relative path mentioned in prose must not invent a session-cwd
// absolute path when the same file was read from outside the workspace. Once
// tool evidence reveals the real absolute path, the earlier relative record is
// repaired in place.
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReferenceLedger, foldReferenceEvents, summarizeReferences } from '../lib/references.js'
import { parseGrepResult, parseReadResult, flattenToolResult } from '../lib/index.js'

const parsers = { parseGrepResult, parseReadResult, flattenToolResult }
const root = mkdtempSync(join(tmpdir(), 'coderef-external-'))

try {
  const cwd = join(root, 'repo')
  const external = join(root, 'external', 'Runtime', 'Broadcast')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(external, { recursive: true })
  const file = join(external, 'UWYRuleNetworkComponent.cs')
  writeFileSync(file, 'namespace X { class UWYRuleNetworkComponent {} }\n')
  const relative = 'Broadcast/UWYRuleNetworkComponent.cs'

  const ledger = createReferenceLedger(cwd, 'external-path-session')
  const events = [
    {
      seq: 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `见 \`${relative}\`。` }] } },
    },
    {
      seq: 2,
      type: 'tool/call',
      data: { callId: 'call-1', name: 'read', arguments: JSON.stringify({ file_path: file }) },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        message: {
          source: { callId: 'call-1' },
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text: `<path>${file}</path>\n<content>\n1: namespace X { class UWYRuleNetworkComponent {} }\n</content>` }],
          }],
        },
      },
    },
  ]

  foldReferenceEvents(ledger, events, parsers)
  const files = summarizeReferences(ledger).refs.files
  const record = files.find((entry) => entry.path === relative)
  assert.ok(record !== undefined, 'prose relative path must be captured')
  assert.equal(record.absPath, file, `relative prose path must be repaired to the external file, got ${record.absPath}`)
  assert.notEqual(record.absPath, join(cwd, relative), 'must not fabricate a cwd-relative path')
  console.log('external-path-smoke: OK (external relative path repaired from tool evidence)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
