/**
 * Reference collector for the dsh-coderef Host.
 *
 * Folds committed session events into a per-session reference ledger:
 *
 *   - assistant messages: markdown links, bare URLs, path-like tokens, and
 *     shell commands the assistant recommends to the user (inline code or
 *     shell-tagged fences);
 *   - grep results: matched files, line ranges, declarations;
 *   - read results: the read file, line ranges, declarations;
 *   - edit/write results: modified files;
 *   - glob/ls results: listed source files;
 *   - web_fetch/web_search: target URLs, cited URLs, page titles.
 *
 * Commands executed by the assistant through tool calls are deliberately NOT
 * collected: the command feature is for commands the assistant hands to the
 * user, not commands it ran itself.
 *
 * The ledger keeps every observable reference. The highlighter later projects
 * only references that appear in assistant prose ("visible" references).
 *
 * In-memory only; callers pass their own parser functions to avoid an import
 * cycle with the main Host module.
 *
 * @module dsh-coderef/references
 */

import { isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const MAX_REFERENCES = 5000
const MAX_OCCURRENCES = 20
const MAX_RANGES = 80
const MAX_SYMBOLS = 500
const MAX_COMMANDS = 500
const MAX_SNIPPETS = 4000

const GREP_TOOL = new Set(['grep', 'search', 'rg', 'ripgrep'])
const READ_TOOL = new Set(['read', 'view', 'cat', 'open', 'read_file'])
const EDIT_TOOL = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch', 'str_replace', 'write_file'])
const GLOB_TOOL = new Set(['glob', 'list', 'ls', 'find'])
const WEB_TOOL = new Set(['web_fetch', 'web_search', 'fetch', 'search_web'])
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'console', 'terminal'])
const COMMAND_NAMES = new Set([
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'bunx', 'deno', 'corepack',
  'python', 'python3', 'pip', 'pip3', 'poetry', 'uv', 'pytest', 'conda',
  'cargo', 'rustc', 'rustup', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle', 'gradlew', 'mvnw',
  'git', 'gh', 'docker', 'kubectl', 'helm', 'terraform', 'ansible',
  'make', 'cmake', 'gcc', 'g++', 'clang', 'clang++', 'tsc', 'tsx', 'esbuild', 'vite', 'webpack', 'rollup',
  'npx.cmd', 'npm.cmd', 'pnpm.cmd', 'node.exe', 'python.exe', 'pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd',
  'curl', 'wget', 'jq', 'rg', 'grep', 'find', 'sed', 'awk', 'cat', 'less', 'more', 'head', 'tail', 'sort', 'uniq', 'wc',
  'cd', 'pwd', 'ls', 'dir', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'del', 'echo', 'export', 'source', 'touch', 'chmod', 'chown',
  'pytest', 'vitest', 'jest', 'playwright', 'cypress', 'eslint', 'prettier', 'biome',
  'ssh', 'scp', 'rsync', 'tar', 'unzip', 'zip', 'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongosh',
  'code', 'code-insiders', 'cursor', 'windsurf', 'notepad', 'explorer',
])
const BARE_COMMANDS = new Set(['pwd', 'ls', 'dir', 'clear', 'cls', 'whoami', 'date', 'uname', 'env', 'history', 'exit'])
const PS_CMDLET_RE = /^(?:Add|Clear|Close|Connect|Convert|Copy|Disable|Disconnect|Enable|Enter|Exit|Export|Find|ForEach|Format|Get|Group|Hide|Import|Initialize|Install|Invoke|Join|Measure|Mount|Move|New|Open|Out|Pop|Publish|Push|Read|Receive|Register|Remove|Rename|Repair|Reset|Resolve|Restart|Resume|Save|Search|Select|Send|Set|Show|Sort|Split|Start|Stop|Submit|Suspend|Test|Uninstall|Unregister|Update|Use|Wait|Where|Write)-[A-Za-z][\w-]*$/

const SOURCE_SCORE = {
  grep: 0.95,
  read: 0.92,
  edit: 0.95,
  glob: 0.4,
  web: 0.85,
  conversation: 0.35,
  command: 0.9,
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi
const CODEREF_MD_LINK_RE = /\[([^\]\n]{1,200})\]\((coderef:[^)\s]+)\)/gi
const SOURCE_PATH_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.$@-]+[\\/])*[\w.$@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|rb|php|swift|scala|lua|ya?ml|toml)(?::\d+(?:-\d+)?)?/g
const PATH_LINE_RE = /(?:^|[\s(（"'`])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s"'`<>|,;，。；）)]+?)(?::(\d+)(?:-(\d+))?)(?=$|[\s)）"'`，。；,;])/g
const PROSE_INLINE_CODE_RE = /`([^`\n]{1,300})`/g
const FENCED_SHELL_RE = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g
const PS_PROMPT_RE = /^(?:PS(?: [^>]*)?>|\$|>)\s+/

/** Strip a shell prompt prefix and surrounding whitespace from a suggested command. */
function normalizeCommand(raw) {
  return String(raw).trim().replace(PS_PROMPT_RE, '').trim()
}

/** Command-like heuristics for commands the assistant recommends to the user. */
export function looksLikeCommand(raw) {
  const command = normalizeCommand(raw)
  if (command === '' || command.length > 300 || command.includes('\n')) return false
  if (/^export\s+(?:const|let|var|function|class|default|type|interface|enum|\{|\*)/.test(command)) return false
  const first = command.split(/\s+/)[0] ?? ''
  const rest = command.slice(first.length).trim()
  const base = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (COMMAND_NAMES.has(base)) return rest !== '' || BARE_COMMANDS.has(base)
  if (PS_CMDLET_RE.test(first)) return true
  if (/^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(first)
    && /\.(?:exe|cmd|bat|ps1|sh|mjs|js|ts|py)$/i.test(first)) return true
  return false
}

/** Collect commands that appear as inline code or in shell-tagged fences. */
function collectSuggestedCommands(ledger, text, occurrence) {
  PROSE_INLINE_CODE_RE.lastIndex = 0
  let match
  while ((match = PROSE_INLINE_CODE_RE.exec(text)) !== null) {
    const command = normalizeCommand(match[1])
    if (looksLikeCommand(command)) upsertCommand(ledger, command, occurrence)
  }
  FENCED_SHELL_RE.lastIndex = 0
  while ((match = FENCED_SHELL_RE.exec(text)) !== null) {
    const language = String(match[1]).toLowerCase()
    if (!SHELL_LANGS.has(language)) continue
    for (const rawLine of match[2].split(/\r?\n/)) {
      const line = normalizeCommand(rawLine)
      if (line === '' || line.startsWith('#') || line.startsWith('//')) continue
      if (looksLikeCommand(line)) upsertCommand(ledger, line, occurrence)
    }
  }
}

function slash(value) {
  return String(value).replace(/\\/g, '/')
}

function canonicalFile(file, cwd, ledger) {
  const raw = String(file).trim()
  if (raw === '') return { absPath: raw, key: '' }
  if (isAbsolute(raw)) {
    const abs = repairExistingPath(raw)
    return { absPath: abs, key: slash(abs).toLowerCase() }
  }

  // Relative prose paths have no reliable base when the answer was read from
  // an external workspace. Before inventing "<session cwd>/<relative>", try to
  // anchor the suffix onto a file this session actually touched (read/grep/
  // edit evidence already recorded in the ledger). This keeps external
  // references pointing at their real absolute path.
  const needle = slash(raw).replace(/^\.\/+/, '').toLowerCase()
  let knownMatch
  if (ledger !== undefined && ledger.files !== undefined) {
    for (const record of ledger.files.values()) {
      const candidate = slash(record.absPath ?? record.path)
      const normalized = candidate.toLowerCase()
      if (normalized !== needle && !normalized.endsWith(`/${needle}`)) continue
      if (!existsSync(candidate)) continue
      if (knownMatch === undefined || candidate.length < knownMatch.length) knownMatch = candidate
    }
  }
  if (knownMatch !== undefined) {
    return { absPath: knownMatch, key: slash(knownMatch).toLowerCase() }
  }

  const abs = repairExistingPath(resolve(cwd ?? '', raw))
  return { absPath: abs, key: slash(abs).toLowerCase() }
}

/**
 * Tool-call arguments sometimes already contain a path prefix that was also
 * prepended by the session cwd (e.g. `...\Script\Script\GamePlay` or
 * `Script\GamePlay\Script\GamePlay\...`). Prefer the path that exists on disk;
 * collapse adjacent repeated segment blocks only when the raw path does not.
 */
function repairExistingPath(abs) {
  if (typeof abs !== 'string' || abs === '' || existsSync(abs)) return abs
  const parsed = parsePath(abs)
  const rest = abs.slice(parsed.root.length)
  const segments = rest.split(/[\\/]+/).filter(segment => segment !== '')
  const seen = new Set()
  const add = (parts) => {
    if (parts.length === 0) return undefined
    const candidate = `${parsed.root}${parts.join('\\')}`
    const normalized = candidate.replace(/[\\/]+/g, '\\')
    if (seen.has(normalized)) return undefined
    seen.add(normalized)
    return existsSync(normalized) ? normalized : undefined
  }
  // Remove the second copy of an adjacent repeated block (1..4 segments).
  for (let length = 1; length <= 4; length += 1) {
    for (let index = 0; index + length * 2 <= segments.length; index += 1) {
      const first = segments.slice(index, index + length).join('\u0000')
      const second = segments.slice(index + length, index + length * 2).join('\u0000')
      if (first !== second) continue
      const candidate = add([...segments.slice(0, index + length), ...segments.slice(index + length * 2)])
      if (candidate !== undefined) return candidate
    }
  }
  return abs
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw
  }
}

function trimUrlPunctuation(value) {
  return String(value).replace(/[.,;:!?，。；：！？)）"'`\]]+$/g, '')
}

function baseConfidence(kind, occurrences) {
  const base = SOURCE_SCORE[kind] ?? 0.3
  return Math.min(0.99, base + Math.min(0.12, Math.max(0, occurrences - 1) * 0.03))
}

function addOccurrence(record, occurrence) {
  if (record.occurrences.length >= MAX_OCCURRENCES) return
  const duplicate = record.occurrences.some(existing => existing.source === occurrence.source
    && existing.seq === occurrence.seq
    && existing.callId === occurrence.callId)
  if (!duplicate) record.occurrences.push(occurrence)
}

function addRange(record, start, end) {
  if (!Number.isFinite(start) || start <= 0) return
  const normalizedEnd = Number.isFinite(end) && end >= start ? end : start
  if (record.lines.length >= MAX_RANGES) return
  if (record.lines.some(range => range.start === start && range.end === normalizedEnd)) return
  record.lines.push({ start, end: normalizedEnd })
}

/** Create one session's reference ledger. */
export function createReferenceLedger(cwd, sessionId) {
  return {
    cwd: cwd ?? '',
    sessionId: sessionId ?? '',
    lastSeq: -1,
    eventCount: 0,
    files: new Map(),
    urls: new Map(),
    symbols: new Map(),
    commands: new Map(),
    snippets: new Map(),
    calls: new Map(),
    texts: [],
    lastFolded: 0,
  }
}

function reconcileRelativeFiles(ledger, absPath) {
  if (!isAbsolute(absPath)) return
  const normalizedAbs = slash(absPath).toLowerCase()
  const updates = []
  for (const [key, record] of ledger.files) {
    if (typeof record.path !== 'string' || isAbsolute(record.path)) continue
    // Keep a cwd-relative record when that file really exists; only repair a
    // fabricated path that points at nothing.
    if (existsSync(record.absPath)) continue
    const normalizedRel = slash(record.path).replace(/^\.\/+/, '').toLowerCase()
    if (normalizedRel === '' || (!normalizedAbs.endsWith(`/${normalizedRel}`) && normalizedAbs !== normalizedRel)) continue
    updates.push({ key, record })
  }
  for (const { key, record } of updates) {
    const nextKey = slash(absPath).toLowerCase()
    if (key === nextKey || ledger.files.has(nextKey)) continue
    ledger.files.delete(key)
    record.absPath = absPath
    ledger.files.set(nextKey, record)
  }
}

function upsertFile(ledger, file, occurrence, lines = [], symbols = []) {
  if (typeof file !== 'string' || file.trim() === '') return undefined
  const { absPath, key } = canonicalFile(file.trim(), ledger.cwd, ledger)
  if (isAbsolute(file.trim())) reconcileRelativeFiles(ledger, absPath)
  let record = ledger.files.get(key)
  if (record === undefined) {
    record = {
      kind: 'file',
      path: file.trim(),
      absPath,
      lines: [],
      symbols: [],
      occurrences: [],
      confidence: 0,
    }
    if (ledger.files.size >= MAX_REFERENCES) return undefined
    ledger.files.set(key, record)
  }
  addOccurrence(record, occurrence)
  for (const range of lines) addRange(record, range.start, range.end)
  for (const symbol of symbols) {
    if (record.symbols.length < MAX_SYMBOLS && !record.symbols.includes(symbol)) record.symbols.push(symbol)
  }
  record.confidence = baseConfidence(occurrence.source, record.occurrences.length)
  return record
}

function upsertSymbol(ledger, site, occurrence) {
  if (typeof site?.name !== 'string' || typeof site?.file !== 'string') return
  const { key } = canonicalFile(site.file, ledger.cwd, ledger)
  const symbolKey = `${key}|${site.name}|${site.line ?? 0}`
  let record = ledger.symbols.get(symbolKey)
  if (record === undefined) {
    if (ledger.symbols.size >= MAX_REFERENCES) return
    record = {
      kind: 'symbol',
      name: site.name,
      file: site.file,
      absPath: site.line === undefined ? site.file : canonicalFile(site.file, ledger.cwd, ledger).absPath,
      line: Number.isFinite(site.line) ? site.line : undefined,
      endLine: Number.isFinite(site.endLine) ? site.endLine : undefined,
      symbolKind: site.kind,
      occurrences: [],
      confidence: 0,
    }
    ledger.symbols.set(symbolKey, record)
  }
  addOccurrence(record, occurrence)
  record.confidence = baseConfidence(occurrence.source, record.occurrences.length)
  // Keep a back-reference on the file record too.
  const fileRecord = ledger.files.get(key)
  if (fileRecord !== undefined && fileRecord.symbols.length < MAX_SYMBOLS && !fileRecord.symbols.includes(site.name)) {
    fileRecord.symbols.push(site.name)
  }
}

function upsertCommand(ledger, command, occurrence) {
  if (typeof command !== 'string') return
  const normalized = command.replace(/\r\n?/g, '\n').trim()
  if (normalized.length < 2 || normalized.length > 500) return
  const key = normalized
  let record = ledger.commands.get(key)
  if (record === undefined) {
    if (ledger.commands.size >= MAX_COMMANDS) return
    record = {
      kind: 'command',
      command: normalized,
      occurrences: [],
      confidence: 0,
    }
    ledger.commands.set(key, record)
  }
  addOccurrence(record, occurrence)
  record.confidence = baseConfidence(occurrence.source, record.occurrences.length)
}

function normalizedSnippet(value) {
  return String(value)
    .replace(/\r/g, '')
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[;,]\s*$/, '')
    .trim()
}

function addSnippet(ledger, raw, file, line, occurrence) {
  const snippet = normalizedSnippet(raw)
  if (snippet.length < 3 || snippet.length > 240) return
  const { absPath, key } = canonicalFile(file, ledger.cwd, ledger)
  const snippetKey = `${key}|${line}|${snippet}`
  let record = ledger.snippets.get(snippetKey)
  if (record === undefined) {
    if (ledger.snippets.size >= MAX_SNIPPETS) return
    record = {
      kind: 'snippet',
      snippet,
      file,
      absPath,
      line,
      occurrences: [],
      confidence: 0,
    }
    ledger.snippets.set(snippetKey, record)
  }
  addOccurrence(record, occurrence)
  record.confidence = baseConfidence(occurrence.source, record.occurrences.length)
}

/** Index exact code segments from a read/grep line for inline-code matching. */
function collectLineSnippets(ledger, file, line, text, occurrence) {
  if (typeof text !== 'string' || text.trim() === '') return
  if (!/\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|scala|lua)$/i.test(file)) return
  if (/^\s*(?:\/\/|\/\*|\*|#)/.test(text)) return
  addSnippet(ledger, text, file, line, occurrence)
  const assignment = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=(?!=|>)\s*([^;{}]+?)(?=;|$)/g
  let match
  while ((match = assignment.exec(text)) !== null) {
    addSnippet(ledger, `${match[1]} = ${match[2]}`, file, line, occurrence)
  }
  const call = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()]*\))/g
  while ((match = call.exec(text)) !== null) {
    addSnippet(ledger, match[1], file, line, occurrence)
  }
  const comparison = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:==|!=|>=|<=|>|<|\bis\b|\bas\b)\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g
  while ((match = comparison.exec(text)) !== null) {
    addSnippet(ledger, match[1], file, line, occurrence)
  }
}

function upsertUrl(ledger, rawUrl, occurrence, title) {
  if (typeof rawUrl !== 'string') return
  const url = trimUrlPunctuation(rawUrl.trim())
  if (!/^https?:\/\//i.test(url)) return
  const canonical = canonicalUrl(url)
  let record = ledger.urls.get(canonical)
  if (record === undefined) {
    if (ledger.urls.size >= MAX_REFERENCES) return
    record = {
      kind: 'url',
      url,
      canonical,
      title: typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 240) : undefined,
      occurrences: [],
      confidence: 0,
    }
    ledger.urls.set(canonical, record)
  }
  if (typeof title === 'string' && title.trim() !== '') {
    const normalized = title.trim().slice(0, 240)
    // A web-tool page title is stronger than a prose link label.
    if (record.title === undefined || occurrence.source === 'web') record.title = normalized
  }
  addOccurrence(record, occurrence)
  record.confidence = baseConfidence(occurrence.source, record.occurrences.length)
}

function addPathLines(ledger, token, occurrence) {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(token)
  if (match === null) return
  const [, file, start, end] = match
  const lines = start === undefined ? [] : [{ start: Number(start), end: end === undefined ? Number(start) : Number(end) }]
  upsertFile(ledger, file, occurrence, lines)
}

/** Conversation prose: markdown links, bare URLs, path-like tokens. */
function collectConversation(ledger, text, seq) {
  if (ledger.texts.length < 200) ledger.texts.push({ text: String(text).slice(0, 20000), seq })
  const occurrence = { source: 'conversation', seq }
  MD_LINK_RE.lastIndex = 0
  const linked = new Set()
  let match
  while ((match = MD_LINK_RE.exec(text)) !== null) {
    linked.add(match[2])
    upsertUrl(ledger, match[2], occurrence, match[1])
  }
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(text)) !== null) {
    if (!linked.has(match[0])) upsertUrl(ledger, match[0], occurrence)
  }
  SOURCE_PATH_RE.lastIndex = 0
  while ((match = SOURCE_PATH_RE.exec(text)) !== null) {
    addPathLines(ledger, match[0], occurrence)
  }
  PATH_LINE_RE.lastIndex = 0
  while ((match = PATH_LINE_RE.exec(text)) !== null) {
    const token = `${match[1]}:${match[2]}` + (match[3] === undefined ? '' : `-${match[3]}`)
    if (SOURCE_PATH_RE.test(match[1])) addPathLines(ledger, token, occurrence)
  }
  CODEREF_MD_LINK_RE.lastIndex = 0
  while ((match = CODEREF_MD_LINK_RE.exec(text)) !== null) {
    const destination = match[2]
    if (/^coderef:cmd:/i.test(destination)) {
      try {
        const command = decodeURIComponent(destination.slice('coderef:cmd:'.length))
        if (command.trim() !== '') upsertCommand(ledger, command, occurrence)
      } catch { /* malformed encoding is ignored */ }
      continue
    }
    if (/^coderef:sym:/i.test(destination)) continue
    const raw = destination.slice('coderef:'.length).replace(/^\/\//, '')
    const hashAt = raw.indexOf('#')
    const path = hashAt >= 0 ? raw.slice(0, hashAt) : raw
    const hash = hashAt >= 0 ? raw.slice(hashAt + 1) : ''
    const lineMatch = /^L?(\d+)(?:-L?(\d+))?$/i.exec(hash)
    if (path === '') continue
    try {
      const decoded = decodeURIComponent(path)
      upsertFile(ledger, decoded, occurrence, lineMatch === null
        ? []
        : [{ start: Number(lineMatch[1]), end: Number(lineMatch[2] ?? lineMatch[1]) }])
    } catch { /* malformed encoding is ignored */ }
  }
  collectSuggestedCommands(ledger, text, occurrence)
}

/** One tool/result event, parsed with the main Host parsers. */
function collectToolResult(ledger, event, calls, parsers) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return
  const callId = data?.message?.source?.callId
  const call = calls.get(callId)
  const toolName = typeof call?.name === 'string' ? call.name : ''
  const args = call?.args ?? {}
  const seq = Number(event?.seq ?? 0)
  const occurrence = { source: 'conversation', seq, callId }
  const text = parsers.flattenToolResult(event)
  const baseDir = typeof args?.path === 'string'
    ? (isAbsolute(args.path) ? args.path : join(ledger.cwd, args.path))
    : typeof args?.cwd === 'string'
      ? args.cwd
      : typeof args?.file_path === 'string'
        ? join(ledger.cwd, args.file_path)
        : ledger.cwd

  if (GREP_TOOL.has(toolName)) {
    const parsed = parsers.parseGrepResult(text, baseDir)
    const grepOccurrence = { ...occurrence, source: 'grep', label: typeof args?.pattern === 'string' ? args.pattern : undefined }
    for (const hit of parsed.hits) {
      upsertFile(ledger, hit.file, grepOccurrence, [{ start: hit.line, end: hit.line }])
      collectLineSnippets(ledger, hit.file, hit.line, hit.text, grepOccurrence)
    }
    for (const site of parsed.sites) upsertSymbol(ledger, site, grepOccurrence)
    if (parsed.files.size === 0 && typeof args?.path === 'string') upsertFile(ledger, args.path, grepOccurrence)
    return
  }
  if (READ_TOOL.has(toolName)) {
    const parsed = parsers.parseReadResult(text)
    const readOccurrence = { ...occurrence, source: 'read', label: typeof args?.file_path === 'string' ? args.file_path : undefined }
    if (parsed.file !== null) {
      const lineRanges = parsed.lines.length === 0
        ? []
        : [{ start: parsed.lines[0].line, end: parsed.lines[parsed.lines.length - 1].line }]
      upsertFile(ledger, parsed.file, readOccurrence, lineRanges, parsed.sites.map(site => site.name))
      for (const site of parsed.sites) upsertSymbol(ledger, site, readOccurrence)
      for (const line of parsed.lines) collectLineSnippets(ledger, parsed.file, line.line, line.text, readOccurrence)
    } else if (typeof args?.file_path === 'string') {
      upsertFile(ledger, args.file_path, readOccurrence)
    }
    return
  }
  if (EDIT_TOOL.has(toolName)) {
    const editOccurrence = { ...occurrence, source: 'edit', label: typeof args?.file_path === 'string' ? args.file_path : undefined }
    const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
    if (file !== undefined) upsertFile(ledger, file, editOccurrence)
    for (const site of parsers.parseReadResult(text).sites) upsertSymbol(ledger, site, editOccurrence)
    return
  }
  if (GLOB_TOOL.has(toolName)) {
    const globOccurrence = { ...occurrence, source: 'glob', label: typeof args?.pattern === 'string' ? args.pattern : undefined }
    for (const raw of text.split(/\r?\n/)) {
      const file = raw.trim()
      if (file !== '' && /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs)$/i.test(file)) upsertFile(ledger, file, globOccurrence)
    }
    return
  }
  if (WEB_TOOL.has(toolName)) {
    const webOccurrence = { ...occurrence, source: 'web', label: toolName }
    const titleMatch = /<title>([^<]{1,240})<\/title>/i.exec(text)
    const headingMatch = /^#{1,3}\s+(.{1,240})$/m.exec(text)
    const title = titleMatch?.[1] ?? headingMatch?.[1]
    if (typeof args?.url === 'string') upsertUrl(ledger, args.url, webOccurrence, title)
    const seen = new Set()
    MD_LINK_RE.lastIndex = 0
    let match
    while ((match = MD_LINK_RE.exec(text)) !== null) {
      const url = match[2]
      if (seen.has(url) || (typeof args?.url === 'string' && canonicalUrl(url) === canonicalUrl(args.url))) continue
      seen.add(url)
      upsertUrl(ledger, url, webOccurrence, match[1])
    }
    URL_RE.lastIndex = 0
    while ((match = URL_RE.exec(text)) !== null) {
      const url = trimUrlPunctuation(match[0])
      if (seen.has(url) || (typeof args?.url === 'string' && canonicalUrl(url) === canonicalUrl(args.url))) continue
      seen.add(url)
      upsertUrl(ledger, url, webOccurrence)
    }
  }
}

/**
 * Fold session events into the reference ledger (incremental by seq).
 * @returns {number} events folded this call
 */
export function foldReferenceEvents(ledger, events, parsers) {
  let folded = 0
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event?.seq ?? 0)
    if (!(seq > ledger.lastSeq)) continue
    const type = event?.type
    if (type === 'tool/call' && event.data !== null && typeof event.data === 'object') {
      const argsText = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments ?? {})
      let args = {}
      try { args = JSON.parse(argsText) } catch { args = {} }
      ledger.calls.set(event.data.callId, { name: event.data.name, args, seq })
    } else if (type === 'tool/result') {
      collectToolResult(ledger, event, ledger.calls, parsers)
    } else if (type === 'assistant/message') {
      const content = event.data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          // The reference table is a view of the answer body, not of hidden
          // reasoning. `reasoning` blocks are rendered in a collapsed Think row
          // and must never contribute files, URLs, symbols, or commands.
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            collectConversation(ledger, block.text, seq)
          }
        }
      }
    }
    ledger.lastSeq = seq
    ledger.eventCount += 1
    folded += 1
  }
  ledger.lastFolded = folded
  return folded
}

/** Compute aliases for one file reference (used by the highlighter index). */
export function fileAliases(ref) {
  const abs = slash(ref.absPath)
  const rel = slash(ref.path)
  const parts = abs.split('/')
  const aliases = new Set([abs, rel, parts[parts.length - 1]])
  for (let count = 2; count <= Math.min(4, parts.length - 1); count++) {
    aliases.add(parts.slice(parts.length - count).join('/'))
  }
  return [...aliases].filter(alias => alias.length >= 3)
}

const INLINE_CODE_RE = /`([^`\n]{1,300})`/g
const BOLD_TOKEN_RE = /\*\*([^*\n]{1,200})\*\*/g
const PROSE_SYMBOL_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g

function normalizeVisiblePath(value) {
  return slash(String(value)).replace(/^\.\//, '')
}

/**
 * Mark ledger records that actually appear in assistant prose. The ledger keeps
 * tool-only references for lookup, but only `visible` records feed the fold UI.
 */
export function computeVisibility(ledger) {
  const fileByAlias = new Map()
  const symbolByName = new Map()
  const urlByCanonical = new Map()
  const addAlias = (alias, ref) => {
    if (typeof alias !== 'string' || alias.length < 3) return
    const key = normalizeVisiblePath(alias)
    const list = fileByAlias.get(key)
    if (list === undefined) fileByAlias.set(key, [ref])
    else list.push(ref)
  }
  for (const ref of ledger.files.values()) {
    addAlias(ref.path, ref)
    addAlias(ref.absPath, ref)
    for (const alias of fileAliases(ref)) addAlias(alias, ref)
  }
  for (const ref of ledger.symbols.values()) {
    const list = symbolByName.get(ref.name)
    if (list === undefined) symbolByName.set(ref.name, [ref])
    else list.push(ref)
  }
  for (const ref of ledger.urls.values()) urlByCanonical.set(ref.canonical, ref)

  const mark = (ref, seq) => {
    if (ref === undefined) return
    if (ref.visible !== true) {
      ref.visible = true
      ref.visibleSeqs = []
    }
    if (ref.visibleSeqs.length < 50 && !ref.visibleSeqs.includes(seq)) ref.visibleSeqs.push(seq)
  }
  const markFile = (rawPath, seq) => {
    const normalized = normalizeVisiblePath(rawPath)
    const parsed = /^(.*?)(?::\d+(?:-\d+)?)?$/.exec(normalized)
    const file = parsed?.[1]
    if (file === undefined) return
    const list = fileByAlias.get(file)
    if (list === undefined) return
    mark(list.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0], seq)
  }
  const markSymbol = (name, seq) => {
    const list = symbolByName.get(name)
    if (list === undefined) return
    const symbol = list.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    mark(symbol, seq)
    // The fold lists files; a visible symbol also makes its containing file visible.
    const file = [...ledger.files.values()].find(candidate => slash(candidate.absPath ?? '') === slash(symbol.absPath ?? symbol.file))
    if (file !== undefined) mark(file, seq)
  }
  const markToken = (rawToken, seq) => {
    const token = String(rawToken).trim()
    if (token === '') return
    markFile(token, seq)
    markSymbol(token, seq)
    markCommand(token, seq)
    const canonical = canonicalUrl(token)
    const url = urlByCanonical.get(canonical)
    if (url !== undefined) mark(url, seq)
  }
  const markCommand = (rawCommand, seq) => {
    const command = String(rawCommand).trim()
    if (command.length < 4) return
    const ref = ledger.commands.get(command)
    if (ref !== undefined) mark(ref, seq)
  }

  for (const { text, seq } of ledger.texts) {
    URL_RE.lastIndex = 0
    let match
    while ((match = URL_RE.exec(text)) !== null) {
      const canonical = canonicalUrl(trimUrlPunctuation(match[0]))
      const url = urlByCanonical.get(canonical)
      if (url !== undefined) mark(url, seq)
    }
    SOURCE_PATH_RE.lastIndex = 0
    while ((match = SOURCE_PATH_RE.exec(text)) !== null) markFile(match[0], seq)
    PATH_LINE_RE.lastIndex = 0
    while ((match = PATH_LINE_RE.exec(text)) !== null) markFile(`${match[1]}:${match[2]}`, seq)
    INLINE_CODE_RE.lastIndex = 0
    while ((match = INLINE_CODE_RE.exec(text)) !== null) markToken(match[1], seq)
    BOLD_TOKEN_RE.lastIndex = 0
    while ((match = BOLD_TOKEN_RE.exec(text)) !== null) markToken(match[1], seq)
    PROSE_SYMBOL_RE.lastIndex = 0
    while ((match = PROSE_SYMBOL_RE.exec(text)) !== null) markSymbol(match[0], seq)
    for (const [command, ref] of ledger.commands) {
      if (command.length >= 4 && text.includes(command)) mark(ref, seq)
    }
  }

  const visibleFiles = [...ledger.files.values()].filter(ref => ref.visible === true)
  const visibleUrls = [...ledger.urls.values()].filter(ref => ref.visible === true)
  const visibleSymbols = [...ledger.symbols.values()].filter(ref => ref.visible === true)
  const visibleCommands = [...ledger.commands.values()].filter(ref => ref.visible === true)
  ledger.visibleStats = {
    files: visibleFiles.length,
    urls: visibleUrls.length,
    symbols: visibleSymbols.length,
    commands: visibleCommands.length,
    refs: visibleFiles.length + visibleUrls.length + visibleSymbols.length + visibleCommands.length,
  }
  return ledger.visibleStats
}

/** JSON-serializable ledger summary for the debug route and the client. */
export function summarizeReferences(ledger) {
  const visibleStats = computeVisibility(ledger)
  const files = [...ledger.files.values()]
  const urls = [...ledger.urls.values()]
  const symbols = [...ledger.symbols.values()]
  const commands = [...ledger.commands.values()]
  const snippets = [...ledger.snippets.values()]
  return {
    cwd: ledger.cwd,
    sessionId: ledger.sessionId,
    version: ledger.eventCount,
    lastSeq: ledger.lastSeq,
    events: ledger.eventCount,
    lastFolded: ledger.lastFolded,
    stats: {
      files: files.length,
      urls: urls.length,
      symbols: symbols.length,
      commands: commands.length,
      snippets: snippets.length,
      refs: files.length + urls.length + symbols.length + commands.length + snippets.length,
      texts: ledger.texts.length,
    },
    visibleStats,
    refs: {
      files: files.slice(0, 2000).map(ref => ({
        kind: 'file',
        path: ref.path,
        absPath: ref.absPath,
        aliases: fileAliases(ref),
        lines: ref.lines,
        symbols: ref.symbols,
        confidence: ref.confidence,
        visible: ref.visible === true,
        visibleSeqs: ref.visibleSeqs ?? [],
        occurrences: ref.occurrences,
      })),
      urls: urls.slice(0, 2000).map(ref => ({
        kind: 'url',
        url: ref.url,
        canonical: ref.canonical,
        title: ref.title,
        confidence: ref.confidence,
        visible: ref.visible === true,
        visibleSeqs: ref.visibleSeqs ?? [],
        occurrences: ref.occurrences,
      })),
      symbols: symbols.slice(0, 2000).map(ref => ({
        kind: 'symbol',
        name: ref.name,
        file: ref.file,
        absPath: ref.absPath,
        line: ref.line,
        endLine: ref.endLine,
        symbolKind: ref.symbolKind,
        confidence: ref.confidence,
        visible: ref.visible === true,
        visibleSeqs: ref.visibleSeqs ?? [],
        occurrences: ref.occurrences,
      })),
      commands: commands.slice(0, 1000).map(ref => ({
        kind: 'command',
        command: ref.command,
        confidence: ref.confidence,
        visible: ref.visible === true,
        visibleSeqs: ref.visibleSeqs ?? [],
        occurrences: ref.occurrences,
      })),
      snippets: snippets.slice(0, 3000).map(ref => ({
        kind: 'snippet',
        snippet: ref.snippet,
        file: ref.file,
        absPath: ref.absPath,
        line: ref.line,
        confidence: ref.confidence,
        occurrences: ref.occurrences,
      })),
    },
  }
}

/** Model-facing citation instruction (registered as a system-prompt section). */
export const REFERENCES_INSTRUCTION = `## Code references (required)
This DSH session has the coderef plugin loaded. Whenever you mention a source file, line, symbol, URL, or a command the user should run, proactively output one of the exact reference-Markdown forms below. Inline code alone is not a citation and may not become clickable.

- **File + line (preferred)**: \`[lib/index.js:1216](coderef:lib/index.js#L1216)\`
  Line range: \`[lib/index.js:14-18](coderef:lib/index.js#L14-L18)\`
  The path is relative to the session cwd, case-sensitive, and keeps its extension. Never put backticks around the whole Markdown link.
- **File without a known line**: \`[lib/index.js](coderef:lib/index.js)\`.
- **Symbol / member**: \`[AssistantNodeView](coderef:sym:AssistantNodeView)\`; qualified names such as \`[owner.member](coderef:sym:owner.member)\` are fine when known. Use the exact case-sensitive declaration name.
- **Command for the user to run**: \`[node test/smoke.mjs](coderef:cmd:node%20test%2Fsmoke.mjs)\`. The label is the exact command; the destination is the same command with spaces/slashes percent-encoded. Do not include a \`$\` prompt.
- **Web page**: a normal Markdown link such as \`[title](https://example.com/page)\`.

Rules:
1. Every file, symbol, and command citation MUST use the corresponding \`coderef:\` Markdown link; do not rely on plain paths, backticked paths, bold symbols, or inline-code commands as the citation format.
2. Every answer that discusses code should cite each referenced file with a coderef link. After read/grep/edit/glob/web results, cite the files/URLs you relied on in that answer.
3. Prefer exact paths and line numbers copied from tool output. Never invent line numbers; if unsure, use the path-only coderef form.
4. One reference per Markdown link; do not nest links in code spans or wrap a Markdown link in backticks.
5. Never use raw HTML tags for references.`

