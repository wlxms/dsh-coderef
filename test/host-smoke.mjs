// Host-half smoke test: index one real source tree, resolve symbols, dry-run the IDE launcher.
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { __test, apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const uiChatSrc = 'D:/dsh-mydsh/deepseek-harness/packages/client/ui-chat/src/client'

assert.ok(existsSync(uiChatSrc), `fixture directory missing: ${uiChatSrc}`)

const index = await __test.buildIndex(uiChatSrc)
assert.ok(index.files > 5, `expected to scan several files, got ${index.files}`)
assert.ok(index.symbols.size > 5, `expected symbols, got ${index.symbols.size}`)

const resolved = await __test.resolveText(index, 'AssistantNodeView')
assert.ok(resolved.hit !== null, 'AssistantNodeView must resolve')
assert.match(resolved.hit.file.replace(/\\/g, '/'), /chat\/AssistantNodeView\.tsx$/)
assert.equal(resolved.hit.line, 6, `AssistantNodeView declaration line, got ${resolved.hit.line}`)

const markdownText = await __test.resolveText(index, 'MarkdownText')
assert.equal(markdownText.hit, null, 'MarkdownText is imported, not declared here -> no hit')

const member = await __test.resolveText(index, 'OpenFileOptions.line')
assert.ok(member.hit === null || typeof member.hit.line === 'number', 'member lookup returns a hit object or null')

// History-first hints: a file outside the scanned cwd still contributes symbols.
const emptyRoot = mkdtempSync(join(tmpdir(), 'coderef-empty-')) // guaranteed source-free fixture
const emptyIndex = await __test.buildIndex(emptyRoot)
assert.equal(emptyIndex.files, 0, 'fixture directory must contain no source files')
const hintFile = join(uiChatSrc, 'chat/AssistantNodeView.tsx')
const indexed = await __test.indexHintFile(emptyIndex, hintFile)
assert.equal(indexed, true, 'hint file must be parsed')
assert.equal(await __test.indexHintFile(emptyIndex, hintFile), false, 'hint indexing must be idempotent')
const hinted = await __test.resolveText(emptyIndex, 'AssistantNodeView')
assert.ok(hinted.hit !== null && hinted.hit.line === 6, `hint file symbols must resolve, got ${JSON.stringify(hinted.hit)}`)

// History-first: session tool calls contribute absolute paths; prose-relative
// paths are mapped onto them by suffix.
assert.deepEqual(
  __test.mapRelativeHints(
    ['packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
    ['D:/repo/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
  ),
  ['D:/repo/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
  'relative prose path maps by suffix',
)
assert.deepEqual(__test.mapRelativeHints(['no/such/file.ts'], ['D:/repo/other.ts']), [], 'unmatched relative path is dropped')

const sessionQueryCtx = {
  get(name) {
    if (name !== 'sessionQuery') return undefined
    return {
      async readSession() {
        return {
          events: [
            { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ path: 'D:/repo/src/assistant.ts' }) } },
            { type: 'tool/call', data: { name: 'grep', arguments: JSON.stringify({ paths: ['D:/repo/src/contract/slots.ts', 'D:/repo/README.md'] }) } },
            { type: 'assistant/message', data: {} },
          ],
        }
      },
    }
  },
}
const sessionHints = await __test.sessionFileHints(sessionQueryCtx, 'session-x')
assert.equal(sessionHints.available, true, 'sessionQuery availability is reported')
assert.ok(sessionHints.hints.includes('D:/repo/src/assistant.ts'), 'tool-call path becomes a session hint')
assert.ok(!sessionHints.hints.some(hint => hint.endsWith('README.md')), 'non-source files are filtered')
const noQuery = await __test.sessionFileHints({ get: () => undefined }, 'session-y')
assert.equal(noQuery.available, false, 'missing sessionQuery degrades gracefully')

// Prototype sibling-repo fallback: prose-relative paths resolve next to the cwd.
const siblingResolved = __test.resolveRelativeHints(
  ['packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
  'D:/dsh-mydsh/dsh-coderef',
)
assert.equal(siblingResolved.length, 1, `sibling repo resolution failed: ${JSON.stringify(siblingResolved)}`)
assert.match(siblingResolved[0].replace(/\\/g, '/'), /deepseek-harness\/packages\/client\/ui-chat\/src\/client\/chat\/AssistantNodeView\.tsx$/)
assert.deepEqual(__test.resolveRelativeHints(['no/such/symbol.ts'], 'D:/dsh-mydsh/dsh-coderef'), [], 'missing relative path stays unresolved')

// ── tool/result evidence (P0): grep + read shapes become declaration sites ──
const grepText = [
  'Found 3 matches',
  '',
  'D:\\repo\\packages\\client\\ui-chat\\src\\client\\chat\\AssistantNodeView.tsx',
  'Line 6: export const AssistantNodeView = memo(function AssistantNodeView({',
  'Line 34: import { AssistantNodeView } from \'../src/client/chat/AssistantNodeView.tsx\'',
  '',
  'D:\\repo\\packages\\client\\ui-chat\\src\\client\\contract\\slots.ts',
  'Line 34: export interface OpenFileOptions {',
].join('\n')
const grepParsed = __test.parseGrepResult(grepText, 'D:/repo')
assert.ok(grepParsed.sites.some(site => site.name === 'AssistantNodeView' && site.line === 6 && site.kind === 'const'), `grep declaration site missing: ${JSON.stringify(grepParsed.sites)}`)
assert.ok(grepParsed.sites.some(site => site.name === 'OpenFileOptions' && site.line === 34 && site.kind === 'interface'), 'grep interface site missing')
assert.equal(grepParsed.hits.length >= 3, true, 'grep match lines are kept even when not declarations')
assert.ok(grepParsed.files.has('D:\\repo\\packages\\client\\ui-chat\\src\\client\\contract\\slots.ts'), 'grep file path parsed')

const readText = [
  '<path>D:\\repo\\src\\owner.ts</path>',
  '<type>file</type>',
  '<content>',
  '1: export class Owner {',
  '2:   value: number = 1',
  '3:   run() {}',
  '4: }',
  '</content>',
].join('\n')
const readParsed = __test.parseReadResult(readText)
assert.equal(readParsed.file, 'D:\\repo\\src\\owner.ts', 'read path parsed')
assert.ok(readParsed.sites.some(site => site.name === 'Owner' && site.line === 1 && site.kind === 'class'), 'read declaration parsed')

const evidence = __test.createEvidence('D:/repo')
const evidenceEvents = [
  { seq: 1, type: 'tool/call', data: { callId: 'call-1', name: 'grep', arguments: JSON.stringify({ pattern: 'AssistantNodeView|OpenFileOptions', path: 'D:/repo/packages' }) } },
  { seq: 2, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: grepText }] }] } } },
]
assert.equal(__test.foldSessionEvents(evidence, evidenceEvents), 2, 'both events are folded')
assert.equal(__test.foldSessionEvents(evidence, evidenceEvents), 0, 'refolding the same events is a no-op')
assert.ok(evidence.symbols.get('AssistantNodeView').some(site => site.line === 6), 'evidence symbol site recorded')
assert.ok(evidence.files.size >= 2, 'evidence files recorded')

// Decision layer: evidence declaration wins; near-ties from the index are ambiguous.
const linkedDecision = __test.decideCandidates([
  { file: 'D:/repo/a.ts', line: 6, kind: 'const', score: 0.98, evidence: 'grep' },
  { file: 'D:/repo/b.ts', line: 1, kind: 'const', score: 0.44, evidence: 'index' },
])
assert.equal(linkedDecision.status, 'linked')
assert.equal(linkedDecision.chosen.file, 'D:/repo/a.ts')
const ambiguousDecision = __test.decideCandidates([
  { file: 'D:/repo/a.ts', line: 1, kind: 'const', score: 0.62, evidence: 'index' },
  { file: 'D:/repo/b.ts', line: 2, kind: 'const', score: 0.61, evidence: 'index' },
])
assert.equal(ambiguousDecision.status, 'ambiguous', 'close index candidates are not auto-linked')
assert.equal(__test.decideCandidates([]).status, 'unresolved')

// Member scope: only declarations inside the owner body count.
const memberLines = ['export class Owner {', '  value: number = 1', '  run() {}', '}', 'const unrelated = 1']
const memberSite = __test.findMemberInLines(memberLines, 1, 'value')
assert.ok(memberSite !== null && memberSite.line === 2, `member scope failed: ${JSON.stringify(memberSite)}`)
assert.equal(__test.findMemberInLines(memberLines, 1, 'missing'), null, 'unknown member is not invented')

// Re-export chain: `export { X } from './x'` resolves to the defining file.
const reexportRoot = mkdtempSync(join(tmpdir(), 'coderef-reexport-'))
writeFileSync(join(reexportRoot, 'def.ts'), 'export interface OpenFileOptions {\n  line: number\n}\n', 'utf8')
writeFileSync(join(reexportRoot, 'barrel.ts'), "export type { OpenFileOptions } from './def.ts'\n", 'utf8')
const chained = await __test.followReExport(join(reexportRoot, 'barrel.ts'), 1, 'OpenFileOptions')
assert.ok(chained !== null && chained.file.endsWith('def.ts') && chained.line === 1, `re-export chain failed: ${JSON.stringify(chained)}`)
assert.equal(__test.resolveImport(join(reexportRoot, 'barrel.ts'), './def.ts'), join(reexportRoot, 'def.ts'), 'relative import resolves to a file')

// Workspace enumeration prefers git ls-files when available.
const enumeration = await __test.listSourceFiles(uiChatSrc)
assert.ok(enumeration.files.length > 5, `enumeration returned too few files: ${enumeration.files.length}`)
assert.ok(enumeration.enumeratedBy === 'git' || enumeration.enumeratedBy === 'walk', 'enumeration reports its strategy')

// ── inline-code resolution: `path:line`, basename from evidence, symbols ──
assert.deepEqual(__test.splitTokenLine('lib/index.js:1216-1220'), { text: 'lib/index.js', line: 1216, endLine: 1220 })
assert.deepEqual(__test.splitTokenLine('C:/repo/a.ts:12'), { text: 'C:/repo/a.ts', line: 12 })
assert.deepEqual(__test.splitTokenLine('C:/repo/a.ts'), { text: 'C:/repo/a.ts', line: undefined })

const pluginRoot = 'D:/dsh-mydsh/dsh-coderef/dsh-coderef'
const inlineCtx = {
  cwd: pluginRoot,
  evidence: __test.createEvidence(pluginRoot),
  index: undefined,
  hintFiles: [],
  universe: [join(pluginRoot, 'lib/index.js')],
}
const inlinePath = await __test.candidatesFromInline('lib/index.js:1216', inlineCtx)
assert.ok(inlinePath.length >= 1, `inline path did not resolve: ${JSON.stringify(inlinePath)}`)
assert.ok(inlinePath[0].file.replace(/\\/g, '/').endsWith('lib/index.js') && inlinePath[0].line === 1216, 'inline path keeps its line')
assert.equal(__test.decideCandidates(inlinePath).status, 'linked', 'inline path becomes linked')
const inlineBasename = await __test.candidatesFromInline('AssistantNodeView.tsx:14-18', {
  ...inlineCtx,
  universe: ['D:/dsh-mydsh/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
})
assert.ok(inlineBasename.some(candidate => candidate.file.endsWith('AssistantNodeView.tsx') && candidate.line === 14), `inline basename did not resolve: ${JSON.stringify(inlineBasename)}`)
assert.deepEqual(await __test.candidatesFromInline('**X**', inlineCtx), [], 'markdown fragments are not inline candidates')
assert.deepEqual(await __test.candidatesFromInline('https://example.com/a.ts', inlineCtx), [], 'URLs are not resolved')

// Expressions: pull the resolvable sub-reference out of a larger code string.
const extracted = __test.extractInlineRefs("require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView")
assert.ok(extracted.some(ref => ref.kind === 'symbol' && ref.value === 'AssistantNodeView'), `expression extraction failed: ${JSON.stringify(extracted)}`)
assert.ok(
  __test.extractInlineRefs('findMemberInLines:713').some(ref => ref.kind === 'symbol' && ref.value === 'findMemberInLines' && ref.line === 713),
  'symbol:line extraction failed',
)
const expressionCtx = {
  cwd: pluginRoot,
  evidence: __test.createEvidence(pluginRoot),
  index: undefined,
  hintFiles: [join(pluginRoot, 'lib/client.js')],
  universe: [join(pluginRoot, 'lib/client.js')],
}
const expressionCandidates = await __test.candidatesFromInline('composeMentions()', expressionCtx)
assert.ok(expressionCandidates.some(candidate => candidate.file.replace(/\\/g, '/').endsWith('lib/client.js')), `call expression did not resolve: ${JSON.stringify(expressionCandidates)}`)

// C# fields/methods are evidence sites too, not only class/interface declarations.
const csharpRead = __test.parseReadResult([
  '<path>D:/repo/Player.cs</path>',
  '<content>',
  '12: private bool bIsTickable = false;',
  '13: public bool IsTickable() { return bIsTickable; }',
  '</content>',
].join('\n'))
assert.equal(csharpRead.sites.some(site => site.name === 'bIsTickable' && site.kind === 'field'), true, `C# field site missing: ${JSON.stringify(csharpRead.sites)}`)
assert.equal(csharpRead.sites.some(site => site.name === 'IsTickable' && site.kind === 'method'), true, `C# method site missing: ${JSON.stringify(csharpRead.sites)}`)
const requireExpression = await __test.candidatesFromInline("require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView", {
  ...expressionCtx,
  hintFiles: ['D:/dsh-mydsh/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
  universe: ['D:/dsh-mydsh/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx'],
})
assert.ok(requireExpression.some(candidate => candidate.file.replace(/\\/g, '/').endsWith('chat/AssistantNodeView.tsx')), `expression symbol did not resolve: ${JSON.stringify(requireExpression)}`)
const lineCandidates = await __test.candidatesFromInline('findMemberInLines:713', { ...expressionCtx, hintFiles: [join(pluginRoot, 'lib/index.js')], universe: [join(pluginRoot, 'lib/index.js')] })
assert.ok(lineCandidates.some(candidate => candidate.line === 713), `symbol:line did not keep the line: ${JSON.stringify(lineCandidates)}`)

// Paraphrased snippet: match distinctive terms against the lines the session
// actually read (source may differ: `tail?.closing?...` vs the quote).
const snippetRoot = mkdtempSync(join(tmpdir(), 'coderef-snippet-'))
writeFileSync(join(snippetRoot, 'view.tsx'), [
  "import { useMemo } from 'react'",
  "const tail = useTurnData('turn-tail')",
  "const owner = useMemo(() => {",
  "  if (closeCheck(tail) && tail.closing.finalNode.seq !== data.finalNode.seq) return undefined",
  '})',
].join('\n') + '\n', 'utf8')
const snippetContext = {
  cwd: snippetRoot,
  evidence: __test.createEvidence(snippetRoot),
  index: undefined,
  hintFiles: [join(snippetRoot, 'view.tsx')],
  universe: [join(snippetRoot, 'view.tsx')],
}
const quotedSnippet = "useTurnData('turn-tail').closing.finalNode.seq === data.finalNode.seq"
const snippetCandidates = await __test.candidatesFromInline(quotedSnippet, snippetContext)
assert.ok(snippetCandidates.some(candidate => candidate.kind === 'snippet' && candidate.line === 4), `paraphrased snippet did not match read lines: ${JSON.stringify(snippetCandidates)}`)
assert.ok(__test.snippetTerms(quotedSnippet).includes('finalNode'), 'snippet terms keep distinctive identifiers')

process.env.DSH_CODEREF_DRY_OPEN = '1'
// Use the running Node executable as a guaranteed-resolvable launcher (dry-run never spawns).
process.env.DSH_CODEREF_IDE = process.execPath
const dry = await __test.openInIde(join(uiChatSrc, 'chat/AssistantNodeView.tsx'), 6, 1)
assert.equal(dry.dryRun, true, 'dry-run must not spawn an IDE')
assert.equal(dry.exe, process.execPath, 'absolute IDE path is accepted directly')
assert.ok(typeof dry.command === 'string' && dry.command.includes('--goto'), 'dry-run reports the argv')

// Cordis surface: apply() registers one prefix route and registers the citation section.
const routes = []
let citationSection
let injectedDeps
const fakeCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
  inject(deps, callback) {
    injectedDeps = deps
    callback({
      systemPrompt: {
        section(definition) {
          citationSection = definition
          return () => {}
        },
        getSectionOrder(name) {
          return name === 'FILE_REFERENCE' ? 900 : 0
        },
      },
    })
  },
}
apply(fakeCtx)
assert.equal(routes.length, 1)
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/coderef')
assert.equal(typeof routes[0].handler, 'function')
assert.deepEqual(injectedDeps, ['systemPrompt'])
assert.equal(citationSection.name, 'coderef:citations')
assert.equal(citationSection.order, 901)
assert.ok(citationSection.text.includes('Code references (required)'))
assert.ok(citationSection.text.includes('coderef:lib/index.js#L1216'))

rmSync(emptyRoot, { recursive: true, force: true })
rmSync(reexportRoot, { recursive: true, force: true })
rmSync(snippetRoot, { recursive: true, force: true })

console.log(`host-smoke: OK (files=${index.files}, symbols=${index.symbols.size}, route=${routes[0].path}, evidence=${evidence.symbols.size} symbols/${evidence.files.size} files)`)
