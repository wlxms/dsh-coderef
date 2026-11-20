// Collector smoke: synthetic session events -> reference ledger.
import { strict as assert } from 'node:assert'
import {
  createReferenceLedger, foldReferenceEvents, summarizeReferences, fileAliases, REFERENCES_INSTRUCTION,
} from '../lib/references.js'
import { parseGrepResult, parseReadResult, flattenToolResult } from '../lib/index.js'

const parsers = { parseGrepResult, parseReadResult, flattenToolResult }
const cwd = 'C:\\repo'
const ledger = createReferenceLedger(cwd, 'session-test')

const events = [
  {
    seq: 1,
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'text', text: 'See [the docs](https://Example.com/docs/) and `src/foo.ts:12`; MyCar is not Car.' },
        ],
      },
    },
  },
  {
    seq: 2,
    type: 'tool/call',
    data: { callId: 'call-1', name: 'grep', arguments: JSON.stringify({ pattern: 'Car', path: 'src' }) },
  },
  {
    seq: 3,
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'call-1' },
        content: [{
          type: 'tool-result',
          content: [{
            type: 'text',
            text: [
              'Found 2 matches',
              '',
              'C:\\repo\\src\\foo.ts',
              'Line 12: class Car {}',
              'Line 20: const x = 1',
            ].join('\n'),
          }],
        }],
      },
    },
  },
  {
    seq: 4,
    type: 'tool/call',
    data: { callId: 'call-2', name: 'read', arguments: JSON.stringify({ file_path: 'C:\\repo\\src\\foo.ts' }) },
  },
  {
    seq: 5,
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'call-2' },
        content: [{
          type: 'tool-result',
          content: [{
            type: 'text',
            text: '<path>C:\\repo\\src\\foo.ts</path>\n<content>\n6: interface Foo {}\n12: class Car {}\n</content>',
          }],
        }],
      },
    },
  },
  {
    seq: 6,
    type: 'tool/call',
    data: { callId: 'call-3', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://Example.com/docs/' }) },
  },
  {
    seq: 7,
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'call-3' },
        content: [{
          type: 'tool-result',
          content: [{
            type: 'text',
            text: '<title>Example docs</title>\n# Example docs\n\nSee [API](https://example.com/api) for details.',
          }],
        }],
      },
    },
  },
  {
    seq: 8,
    type: 'tool/call',
    data: { callId: 'call-4', name: 'bash', arguments: JSON.stringify({ command: 'node --version' }) },
  },
  {
    seq: 9,
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'call-4' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'v26.0.0' }] }],
      },
    },
  },
  {
    seq: 10,
    type: 'assistant/message',
    data: {
      message: {
        content: [{ type: 'text', text: 'Check `node --version`, [node --version](coderef:cmd:node%20--version), and [foo.ts](coderef:src/foo.ts#L12).' }],
      },
    },
  },
]

const folded = foldReferenceEvents(ledger, events, parsers)
assert.equal(folded, 10)

const summary = summarizeReferences(ledger)
assert.equal(summary.stats.files >= 1, true)
assert.equal(summary.stats.urls >= 2, true)
assert.equal(summary.stats.symbols >= 1, true)

const foo = summary.refs.files.find(ref => ref.path.replace(/\\/g, '/').endsWith('src/foo.ts'))
assert.ok(foo !== undefined, `foo.ts missing: ${JSON.stringify(summary.refs.files.map(f => f.path))}`)
assert.deepEqual(fileAliases(foo).includes('foo.ts'), true)
assert.equal(foo.lines.some(range => range.start === 12 && range.end === 12), true)
assert.equal(foo.symbols.includes('Car'), true)
assert.equal(foo.occurrences.some(occ => occ.source === 'grep'), true)
assert.equal(foo.occurrences.some(occ => occ.source === 'read'), true)

const car = summary.refs.symbols.find(ref => ref.name === 'Car')
assert.ok(car !== undefined, 'Car symbol missing')
assert.equal(car.file.replace(/\\/g, '/').endsWith('src/foo.ts'), true)
assert.equal(car.line, 12)

const docs = summary.refs.urls.find(ref => ref.canonical === 'https://example.com/docs')
assert.ok(docs !== undefined, `canonical URL missing: ${JSON.stringify(summary.refs.urls.map(u => u.canonical))}`)
assert.equal(docs.title, 'Example docs')
assert.ok(summary.refs.urls.some(ref => ref.canonical === 'https://example.com/api'), 'in-page link missing')

const command = summary.refs.commands.find(ref => ref.command === 'node --version')
assert.ok(command !== undefined, `command missing: ${JSON.stringify(summary.refs.commands.map(c => c.command))}`)
assert.equal(command.visible, true)
assert.equal(command.occurrences.some(occ => occ.source === 'command'), false, 'tool-used commands must not be captured')
assert.equal(command.occurrences.every(occ => occ.source === 'conversation'), true)
assert.equal(summary.visibleStats.commands >= 1, true)

const snippets = summary.refs.snippets ?? []
assert.ok(snippets.some(ref => ref.snippet === 'x = 1'), `assignment snippet missing: ${JSON.stringify(snippets.slice(0, 8))}`)
const snippet = snippets.find(ref => ref.snippet === 'x = 1')
assert.equal(snippet.file.replace(/\\/g, '/').endsWith('src/foo.ts'), true)
assert.equal(snippet.line, 20)
assert.ok(REFERENCES_INSTRUCTION.includes('Code references (required)'), 'instruction must require citations')
assert.ok(REFERENCES_INSTRUCTION.includes('coderef:lib/index.js#L1216'), 'instruction must show file+line format')
assert.ok(REFERENCES_INSTRUCTION.includes('coderef:sym:'), 'instruction must show symbol format')
assert.ok(REFERENCES_INSTRUCTION.includes('coderef:cmd:node%20test%2Fsmoke.mjs'), 'instruction must show command reference format')

// Incremental fold must not duplicate records.
foldReferenceEvents(ledger, events, parsers)
const second = summarizeReferences(ledger)
assert.equal(second.stats.files, summary.stats.files)
assert.equal(second.stats.urls, summary.stats.urls)
assert.equal(second.stats.symbols, summary.stats.symbols)

console.log('references-smoke: OK (conversation/grep/read/web/command fold, canonical URLs, incremental idempotence)')
