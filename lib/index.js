/**
 * dsh-coderef — Host half (prototype)
 *
 * Routes (same-origin, served by ctx.webServer under /coderef):
 *   GET  /coderef/health                     index + runtime diagnostics
 *   POST /coderef/resolve { cwd, texts[] }    name -> { file, line, kind, score, ambiguous? }
 *   POST /coderef/open    { file, line, column? }  launch the IDE (fallback signal for client)
 *
 * The symbol index is a deliberately small, dependency-free prototype:
 *   - scans the session cwd for source files (depth/file/size capped)
 *   - extracts top-level declarations with one regex family per language family
 *   - resolves a text token only by exact name; multi-candidate names still
 *     return the best-ranked entry but carry `ambiguous`, because the prototype
 *     demo prefers a visible link over strict silence. Production should gate
 *     on the score rules documented in CODEREF-FEASIBILITY.md.
 *
 * No session log is read or written; this half is stateless except for the
 * per-cwd in-memory index cache.
 *
 * @module dsh-coderef
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import {
  createReferenceLedger, foldReferenceEvents, summarizeReferences, REFERENCES_INSTRUCTION,
} from './references.js'

export const name = 'dsh-coderef'
export const VERSION = '0.0.10'
export const inject = ['webServer']

const ROUTE_PREFIX = '/coderef'
const MAX_BODY_BYTES = 128 * 1024
const MAX_FILES = 20000
const MAX_FILE_BYTES = 512 * 1024
const MAX_DEPTH = 10
/** How long one resolve may wait for the workspace index before answering without it. */
const INDEX_WAIT_MS = 1200
/** Session evidence is re-read at most this often per session (ms). */
const EVIDENCE_TTL_MS = 1500

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.dsh-home', 'dist', 'out', 'build', 'coverage',
  '__pycache__', '.next', '.nuxt', '.cache', '.turbo', 'target', 'vendor',
])
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.scala', '.lua',
])
const TYPE_KINDS = new Set(['class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl', 'record'])

/** One declaration site. */
const declarationPattern = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|static\s+|final\s+|open\s+|partial\s+)*(class|interface|type|enum|struct|trait|impl|record|function|def|func|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/g

/** Single-line declaration recognizer used on tool-result match lines. */
const DECL_LINE = /(?:^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|static\s+|final\s+|open\s+|partial\s+|readonly\s+|async\s+|override\s+)*(class|interface|type|enum|struct|trait|record|function|def|func|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/

const SITE_KEYWORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'switch', 'case', 'return', 'new', 'var', 'let', 'const',
  'this', 'base', 'true', 'false', 'null', 'undefined', 'using', 'namespace', 'public', 'private',
  'protected', 'internal', 'static', 'readonly', 'class', 'interface', 'enum', 'struct', 'void',
])
const METHOD_SITE = /(?:^|[\s;{}])(?:(?:public|private|protected|internal|static|virtual|override|sealed|abstract|async|unsafe|extern|new|partial)\s+)*(?:void|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|string|object|char|[A-Z][\w$<>\[\],.?]*)\s+([A-Za-z_$][\w$]*)\s*\(/g
const PROPERTY_SITE = /(?:^|[\s;{}])(?:(?:public|private|protected|internal|static|virtual|override|sealed|abstract|new|partial)\s+)+(?:[A-Za-z_$][\w$<>\[\],.?]*)\s+([A-Za-z_$][\w$]*)\s*\{\s*(?:get|set|=>)/g
const TYPED_FIELD_SITE = /(?:^|[\s;{}])(?:(?:public|private|protected|internal|static|readonly|const|volatile|transient|declare|override|SerializeField)\s+)*(?:bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|string|object|char|[A-Z][\w$<>\[\],.?]*)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/g
const MODIFIED_FIELD_SITE = /(?:^|[\s;{}])(?:public|private|protected|readonly|static|declare|override)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?\s*=/g
const SOURCE_SITE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|scala|lua)$/i

function isSourceSiteFile(file) {
  return typeof file === 'string' && SOURCE_SITE_EXT.test(file)
}

/**
 * Extract declaration, method, property, and field-assignment sites from one
 * evidence line. Field assignments matter for C#/Unity fields such as
 * `bIsTickable = false`, which the declaration regex alone never sees.
 * @param {string} content
 * @param {string} file
 * @param {number} line
 * @param {string} source
 * @returns {Array<{name: string, file: string, line: number, kind: string, source: string, lineText: string}>}
 */
function extractLineSites(content, file, line, source) {
  const sites = []
  const push = (name, kind) => {
    if (typeof name !== 'string' || name.length < 2 || SITE_KEYWORDS.has(name)) return
    if (sites.some(site => site.name === name)) return
    if (sites.length >= 8) return
    sites.push({ name, file, line, kind, source, lineText: content })
  }
  const declaration = DECL_LINE.exec(content)
  if (declaration !== null) push(declaration[2], declaration[1])
  if (!isSourceSiteFile(file) || /^\s*(?:\/\/|\/\*|\*|#)/.test(content)) return sites
  METHOD_SITE.lastIndex = 0
  let method
  while ((method = METHOD_SITE.exec(content)) !== null) push(method[1], 'method')
  PROPERTY_SITE.lastIndex = 0
  let property
  while ((property = PROPERTY_SITE.exec(content)) !== null) push(property[1], 'property')
  TYPED_FIELD_SITE.lastIndex = 0
  let typedField
  while ((typedField = TYPED_FIELD_SITE.exec(content)) !== null) push(typedField[1], 'field')
  MODIFIED_FIELD_SITE.lastIndex = 0
  let modifiedField
  while ((modifiedField = MODIFIED_FIELD_SITE.exec(content)) !== null) push(modifiedField[1], 'field')
  return sites
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function isSkippableName(name) {
  if (SKIP_DIRS.has(name)) return true
  return name.startsWith('.') && name !== '.' && name !== '..'
}

/**
 * Walk one directory tree and return candidate source files, capped.
 * @param {string} root absolute directory
 * @returns {Promise<string[]>} absolute file paths
 */
async function walk(root) {
  const files = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && files.length < MAX_FILES) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || isSkippableName(entry.name)) continue
        queue.push({ dir: path, depth: depth + 1 })
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.')
        if (dot < 0) continue
        if (SOURCE_EXT.has(entry.name.slice(dot).toLowerCase())) files.push(path)
      }
    }
  }
  return files
}

function kindRank(kind) {
  if (TYPE_KINDS.has(kind)) return 0
  if (kind === 'function' || kind === 'def' || kind === 'func' || kind === 'fn') return 1
  return 2
}

function addDeclarations(symbols, file, text) {
  declarationPattern.lastIndex = 0
  let match
  while ((match = declarationPattern.exec(text)) !== null) {
    const kind = match[1]
    const symbolName = match[2]
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const line = text.slice(0, start).split('\n').length
    const list = symbols.get(symbolName)
    const entry = { file, line, kind }
    if (list === undefined) symbols.set(symbolName, [entry])
    else list.push(entry)
  }
}

/**
 * Add one hinted file (a file the agent touched, possibly outside the session
 * cwd) to an existing index. Idempotent per file path.
 * @param {Awaited<ReturnType<typeof buildIndex>>} index
 * @param {string} file absolute path
 * @returns {Promise<boolean>} whether a new file was parsed
 */
export async function indexHintFile(index, file) {
  if (index.hinted.has(file)) return false
  if (!isAbsolute(file)) return false
  let info
  try {
    info = await stat(file)
  } catch {
    return false
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return false
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return false
  }
  index.hinted.add(file)
  index.files += 1
  addDeclarations(index.symbols, file, text)
  return true
}

/**
 * Build one cwd's symbol index.
 * @param {string} cwd absolute directory
 * @returns {Promise<{ cwd: string, builtAt: number, files: number, symbols: Map<string, Array<{file:string,line:number,kind:string}>>, lines: Map<string,string[]>, hinted: Set<string> }>}
 */
function addIndexSites(symbols, file, lines) {
  for (let index = 0; index < lines.length; index += 1) {
    for (const site of extractLineSites(lines[index], file, index + 1, 'index')) {
      let list = symbols.get(site.name)
      if (list === undefined) {
        list = []
        symbols.set(site.name, list)
      }
      if (!list.some(entry => entry.file === file && entry.line === site.line)) {
        list.push({ file, line: site.line, kind: site.kind })
      }
    }
  }
}

export async function buildIndex(cwd) {
  const enumeration = await listSourceFiles(cwd)
  const files = enumeration.files
  /** @type {Map<string, Array<{file:string,line:number,kind:string}>>} */
  const symbols = new Map()
  /** @type {Set<string>} */
  const hinted = new Set()
  let scanned = 0
  for (const file of files) {
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (info.size > MAX_FILE_BYTES) continue
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    scanned += 1
    addDeclarations(symbols, file, text)
    if (isSourceSiteFile(file)) addIndexSites(symbols, file, text.split(/\r?\n/))
  }
  return { cwd, builtAt: Date.now(), files: scanned, enumeratedFiles: files.length, enumeratedBy: enumeration.enumeratedBy, fileList: files, symbols, lines: new Map(), hinted }
}

/**
 * Rank duplicate declarations: type-like before value-like, then shallower
 * paths, then lexical order. The head may still be ambiguous.
 * @param {Array<{file:string,line:number,kind:string}>} entries
 * @returns {{ head: {file:string,line:number,kind:string}|undefined, count: number }}
 */
export function rankCandidates(entries) {
  if (entries === undefined || entries.length === 0) return { head: undefined, count: 0 }
  const seen = new Set()
  const unique = []
  for (const entry of entries) {
    const key = `${entry.file}:${entry.line}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  unique.sort((left, right) => (kindRank(left.kind) - kindRank(right.kind))
    || (left.file.split(sep).length - right.file.split(sep).length)
    || left.file.localeCompare(right.file)
    || (left.line - right.line))
  return { head: unique[0], count: unique.length }
}

/**
 * Resolve one authored token against one index.
 * @param {Awaited<ReturnType<typeof buildIndex>>} index
 * @param {string} text authored bold text, e.g. "ChunkBuilder" or "Foo.bar"
 * @returns {Promise<{ text:string, hit: null | { file:string, line:number, column?:number, kind:string, score:number, ambiguous?:number } }>}
 */
export async function resolveText(index, text) {
  const dot = text.lastIndexOf('.')
  if (dot > 0) {
    const ownerName = text.slice(0, dot)
    const memberName = text.slice(dot + 1)
    const owner = rankCandidates(index.symbols.get(ownerName))
    if (owner.head === undefined) return { text, hit: null }
    const lines = await fileLines(index, owner.head.file)
    const pattern = new RegExp(`(?:^|[^\\w$])${escapeRegExp(memberName)}\\s*(?:[:(=<>?]|\\bas\\b)`, 'm')
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) {
        return {
          text,
          hit: { file: owner.head.file, line: i + 1, column: lines[i].indexOf(memberName) + 1, kind: 'member', score: 0.7, ...(owner.count > 1 ? { ambiguous: owner.count } : {}) },
        }
      }
    }
    return { text, hit: null }
  }
  const ranked = rankCandidates(index.symbols.get(text))
  if (ranked.head === undefined) return { text, hit: null }
  const typeLike = TYPE_KINDS.has(ranked.head.kind)
  const score = ranked.count === 1 ? 0.95 : (typeLike && /^[A-Z]/.test(text) ? 0.6 : 0.45)
  return {
    text,
    hit: {
      file: ranked.head.file,
      line: ranked.head.line,
      column: 1,
      kind: ranked.head.kind,
      score,
      ...(ranked.count > 1 ? { ambiguous: ranked.count } : {}),
    },
  }
}

async function fileLines(index, file) {
  const cached = index.lines.get(file)
  if (cached !== undefined) return cached
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split('\n')
  index.lines.set(file, lines)
  return lines
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** IDE catalog exposed to the reference context menu (client right-click). */
const IDE_CATALOG = [
  { id: 'code', label: 'VS Code', command: 'code' },
  { id: 'code-insiders', label: 'VS Code Insiders', command: 'code-insiders' },
  { id: 'cursor', label: 'Cursor', command: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', command: 'windsurf' },
]
const ideCatalogCache = new Map()

/** List IDE launchers available on this machine (cached for 60s). */
export async function listIdes() {
  const cached = ideCatalogCache.get('catalog')
  if (cached !== undefined && Date.now() - cached.at < 60000) return cached.list
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const list = []
  for (const entry of IDE_CATALOG) {
    const exe = await resolveExecutable(entry.command + ext) ?? await resolveExecutable(entry.command)
    if (exe !== null) list.push({ id: entry.id, label: entry.label, exe })
  }
  const custom = process.env.DSH_CODEREF_IDE
  if (typeof custom === 'string' && custom.length > 0) {
    const exe = (isAbsolute(custom) && existsSync(custom)) ? custom : await resolveExecutable(custom)
    if (exe !== null && !list.some(entry => entry.exe === exe)) {
      list.push({ id: 'custom', label: 'DSH_CODEREF_IDE', exe })
    }
  }
  ideCatalogCache.set('catalog', { list, at: Date.now() })
  return list
}

/**
 * Open one file at a line in an IDE CLI.
 * `preferredIde` comes from the client context menu; omitted = first resolvable.
 * @param {string} file
 * @param {number} line
 * @param {number} column
 * @param {string} [preferredIde]
 * @returns {Promise<{ ok: boolean, ide?: string, exe?: string, command?: string, dryRun?: true, error?: string }>}
 */
export async function openInIde(file, line, column, preferredIde) {
  if (!isAbsolute(file)) return { ok: false, error: 'file-not-absolute' }
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const candidates = typeof preferredIde === 'string' && preferredIde.length > 0
    ? [preferredIde]
    : [process.env.DSH_CODEREF_IDE, 'code', 'code-insiders', 'cursor', 'windsurf']
      .filter(value => typeof value === 'string' && value.length > 0)
  const target = `${file}:${line}:${column > 0 ? column : 1}`
  for (const candidate of candidates) {
    const exe = (isAbsolute(candidate) && existsSync(candidate))
      ? candidate
      : await resolveExecutable(candidate + ext) ?? await resolveExecutable(candidate)
    if (exe === null) continue
    const command = `${JSON.stringify(exe)} --goto ${JSON.stringify(target)}`
    if (process.env.DSH_CODEREF_DRY_OPEN === '1') {
      return { ok: true, ide: candidate, exe, command, dryRun: true }
    }
    try {
      const child = spawn(`${JSON.stringify(exe)} --goto ${JSON.stringify(target)}`, [], {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: resolvePath(file, '..'),
      })
      child.unref()
      return { ok: true, ide: candidate, exe, command }
    } catch (error) {
      // Try the next candidate.
      void error
    }
  }
  return { ok: false, error: 'no-ide' }
}

/**
 * Reveal one file in the OS file manager (Explorer/Finder/xdg-open).
 * @param {string} file
 * @returns {Promise<{ ok: boolean, command?: string, dryRun?: true, error?: string }>}
 */
export async function revealInFileManager(file) {
  if (!isAbsolute(file)) return { ok: false, error: 'file-not-absolute' }
  const dir = resolvePath(file, '..')
  const command = process.platform === 'win32'
    ? `explorer.exe /select,${JSON.stringify(file)}`
    : process.platform === 'darwin'
      ? `open -R ${JSON.stringify(file)}`
      : `xdg-open ${JSON.stringify(dir)}`
  if (process.env.DSH_CODEREF_DRY_OPEN === '1') return { ok: true, command, dryRun: true }
  try {
    const child = spawn(command, [], { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { ok: true, command }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

async function resolveExecutable(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return await new Promise(resolve => {
    let output = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(probe, [command], { windowsHide: true })
      child.stdout?.on('data', chunk => { output += chunk })
      child.on('error', () => finish(null))
      child.on('close', code => {
        const first = output.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
        finish(code === 0 && first !== undefined ? first : null)
      })
    } catch {
      finish(null)
    }
  })
}

/** Absolute source-path extractor used on tool-call argument trees. */
const SOURCE_PATH_RE = /[A-Za-z]:[\\/][^"'`<>|,\s]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift)/g

/**
 * Walk a JSON-ish value and collect absolute source-file paths.
 * @param {unknown} value
 * @param {Set<string>} out
 */
function collectAbsolutePaths(value, out) {
  if (typeof value === 'string') {
    if (value.length >= 5 && value.length <= 1000) {
      for (const match of value.matchAll(SOURCE_PATH_RE)) out.add(match[0])
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePaths(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectAbsolutePaths(item, out)
  }
}

/**
 * History-first evidence: the files this session's tool calls touched. Uses the
 * host `sessionQuery` seam when the deployment provides it; absence degrades to
 * "no session hints" without failing resolution.
 * @param {any} ctx host context
 * @param {string} sessionId
 * @returns {Promise<{ available: boolean, hints: string[] }>}
 */
async function sessionFileHints(ctx, sessionId) {
  const query = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query === undefined || query === null || typeof query.readSession !== 'function') {
    return { available: false, hints: [], error: 'sessionQuery-unavailable', eventCount: 0 }
  }
  let events = []
  let error
  try {
    const snapshot = await query.readSession(sessionId)
    if (Array.isArray(snapshot?.events)) events = snapshot.events
    else if (Array.isArray(snapshot?.session?.events)) events = snapshot.session.events
    else if (Array.isArray(snapshot?.snapshotEvents)) events = snapshot.snapshotEvents
    else error = `unexpected-snapshot:${Object.keys(snapshot ?? {}).join(',')}`
  } catch (caught) {
    error = String(caught && caught.message ? caught.message : caught)
    try {
      if (typeof query.listEvents === 'function') {
        const records = await query.listEvents(sessionId)
        if (Array.isArray(records)) events = records
      }
    } catch (fallbackError) {
      error += ` | listEvents: ${String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError)}`
    }
  }
  const out = new Set()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'tool/call') continue
    const args = event.data !== null && typeof event.data === 'object' ? event.data.arguments : undefined
    if (typeof args === 'string') {
      try {
        collectAbsolutePaths(JSON.parse(args), out)
      } catch {
        collectAbsolutePaths(args, out)
      }
    } else {
      collectAbsolutePaths(args, out)
    }
  }
  return { available: true, hints: [...out].slice(0, 40), error, eventCount: events.length }
}

/**
 * Map prose-relative paths (e.g. `packages/client/ui-chat/src/client/...`) onto
 * the absolute files discovered from tool calls by suffix match.
 * @param {string[]} relative
 * @param {string[]} absolute
 * @returns {string[]} matched absolute file paths
 */
function mapRelativeHints(relative, absolute) {
  const matched = []
  for (const raw of relative) {
    const needle = raw.replace(/\\/g, '/').toLowerCase()
    if (needle.length < 8) continue
    const hit = absolute.find(candidate => {
      const normalized = candidate.replace(/\\/g, '/').toLowerCase()
      return normalized === needle || normalized.endsWith('/' + needle)
    })
    if (hit !== undefined) matched.push(hit)
  }
  return matched
}

/**
 * Resolve prose-relative source paths against the session cwd and its sibling
 * directories (prototype shortcut for "the repo the agent was talking about is
 * a sibling checkout"). Production should rely on tool-call evidence instead.
 * @param {string[]} relative normalized relative paths
 * @param {string} cwd absolute session working directory
 * @returns {string[]} existing absolute files
 */
export function resolveRelativeHints(relative, cwd) {
  if (!isAbsolute(cwd) || relative.length === 0) return []
  const bases = [cwd]
  try {
    const parent = dirname(cwd)
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && bases.length < 40) bases.push(join(parent, entry.name))
    }
  } catch {
    // cwd without a readable parent: cwd-relative resolution only.
  }
  const found = []
  for (const raw of relative) {
    const rel = String(raw).replace(/\//g, sep)
    for (const base of bases) {
      const candidate = join(base, rel)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          found.push(candidate)
          break
        }
      } catch {
        // try the next base
      }
    }
  }
  return found
}

// ───────────────────────── session evidence (P0/P1) ─────────────────────────
//
// The model's own tool traffic is the highest-confidence source for "what does
// this bold token refer to": grep results carry `path` + `Line N: text`, read
// results carry `<path>` + line-numbered content. Fold those into a per-session
// ledger of symbol declaration sites and file lines, then resolve tokens
// evidence-first and fall back to the workspace index only when evidence misses.

const EVIDENCE_SCORE = {
  'grep-decl': 0.98,
  'read-decl': 0.94,
  'edit-decl': 0.9,
  'hint-decl': 0.9,
  'grep-hit': 0.32,
  'read-line': 0.28,
  'index-unique': 0.62,
  'index-ambiguous': 0.44,
}

const GREP_TOOL = new Set(['grep', 'search', 'rg', 'ripgrep'])
const READ_TOOL = new Set(['read', 'view', 'cat', 'open', 'read_file'])
const EDIT_TOOL = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch', 'str_replace', 'write_file'])
const GLOB_TOOL = new Set(['glob', 'list', 'ls', 'find'])

/** Bounded line cache for files touched while resolving. */
const fileLinesCache = new Map()

/** Read one file's lines with a small LRU bound. */
async function getFileLines(file) {
  const cached = fileLinesCache.get(file)
  if (cached !== undefined) return cached
  let lines = []
  try {
    const info = await stat(file)
    if (info.size <= MAX_FILE_BYTES) {
      const text = await readFile(file, 'utf8')
      lines = text.split('\n')
    }
  } catch {
    lines = []
  }
  if (fileLinesCache.size > 200) fileLinesCache.delete(fileLinesCache.keys().next().value)
  fileLinesCache.set(file, lines)
  return lines
}

/** Lower-cased slash-normalized path for comparisons and dedupe. */
function canonicalPathKey(file) {
  return String(file).replace(/\\/g, '/').toLowerCase()
}

/** Penalty for paths that rarely hold the canonical declaration. */
function pathPenalty(file) {
  const normalized = canonicalPathKey(file)
  if (/(?:^|\/)(?:tests?|__tests__|spec|docs?|examples?|benchmarks?|fixtures?|generated?|vendor)(?:\/|$)/.test(normalized)) return 0.12
  if (/\.(?:spec|test)\.[a-z0-9]+$/.test(normalized) || /(?:^|\/)readme(?:\.|$)/.test(normalized)) return 0.12
  return 0
}

/** Flatten one tool/result event into plain text. */
export function flattenToolResult(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const part of block.content) if (typeof part?.text === 'string') parts.push(part.text)
    } else if (typeof block?.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function safeJson(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Parse one grep tool result into declaration sites and file lines.
 * Shape: `Found N matches` / blank / `<path>` / `Line N: text` / ...
 */
export function parseGrepResult(text, baseDir) {
  const sites = []
  const hits = []
  const files = new Set()
  let currentFile
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^(?:Found \d+ matches?|No matches|Searching|\.\.\.)/i.test(line)) continue
    const lineMatch = /^Line (\d+):\s?(.*)$/.exec(line)
    if (lineMatch !== undefined && lineMatch !== null) {
      if (currentFile === undefined) continue
      const lineNumber = Number(lineMatch[1])
      const content = lineMatch[2]
      files.add(currentFile)
      hits.push({ file: currentFile, line: lineNumber, text: content })
      for (const site of extractLineSites(content, currentFile, lineNumber, 'grep-decl')) sites.push(site)
      continue
    }
    // A path header line: absolute path or a repo/cwd-relative path ending in a source extension.
    if (!line.includes(': ') && /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|scala|lua)$/i.test(line)) {
      currentFile = isAbsolute(line) ? line : join(baseDir ?? '', line)
    }
  }
  return { sites, hits, files }
}

/**
 * Parse one read tool result into declaration sites and file lines.
 * Shape: `<path>…</path>` … `<content>` / `N: text` / `</content>`.
 */
export function parseReadResult(text) {
  const pathMatch = /<path>([^<]+)<\/path>/.exec(String(text))
  if (pathMatch === null) return { sites: [], lines: [], file: null }
  const file = pathMatch[1].trim()
  const sites = []
  const lines = []
  let inContent = false
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (rawLine.startsWith('<content>')) { inContent = true; continue }
    if (rawLine.startsWith('</content>')) { inContent = false; continue }
    if (!inContent) continue
    const lineMatch = /^(\d+):\s?(.*)$/.exec(rawLine)
    if (lineMatch === null) continue
    const lineNumber = Number(lineMatch[1])
    const content = lineMatch[2]
    lines.push({ line: lineNumber, text: content })
    for (const site of extractLineSites(content, file, lineNumber, 'read-decl')) sites.push(site)
  }
  return { sites, file, lines }
}

/** One session's evidence ledger. */
export function createEvidence(cwd) {
  return {
    cwd: cwd ?? '',
    lastSeq: -1,
    eventCount: 0,
    symbols: new Map(),
    files: new Map(),
    calls: new Map(),
  }
}

function addSite(evidence, site, seq) {
  const list = evidence.symbols.get(site.name)
  const entry = { ...site, seq }
  if (list === undefined) evidence.symbols.set(site.name, [entry])
  else if (!list.some(existing => existing.file === entry.file && existing.line === entry.line)) list.push(entry)
}

function addFileLine(evidence, file, line, text, seq) {
  let record = evidence.files.get(file)
  if (record === undefined) {
    record = { lines: new Map(), lastSeq: seq }
    evidence.files.set(file, record)
  }
  record.lastSeq = Math.max(record.lastSeq, seq)
  if (record.lines.size < 4000) record.lines.set(line, text)
}

/**
 * Fold committed session events into the evidence ledger (incremental by seq).
 * @returns {number} the number of events folded this call
 */
export function foldSessionEvents(evidence, events) {
  let folded = 0
  for (const event of events) {
    const seq = Number(event?.seq ?? 0)
    if (!(seq > evidence.lastSeq)) continue
    const type = event?.type
    if (type === 'tool/call' && event.data !== null && typeof event.data === 'object') {
      evidence.calls.set(event.data.callId, { name: event.data.name, args: event.data.arguments, seq })
      folded += 1
    } else if (type === 'tool/result' && event.data !== null && typeof event.data === 'object') {
      const callId = event.data?.message?.source?.callId
      const call = evidence.calls.get(callId)
      const toolName = typeof call?.name === 'string' ? call.name : ''
      const args = safeJson(call?.args)
      const text = flattenToolResult(event)
      if (GREP_TOOL.has(toolName)) {
        const baseDir = typeof args?.path === 'string' ? args.path
          : typeof args?.cwd === 'string' ? args.cwd
            : typeof args?.file_path === 'string' ? dirname(args.file_path)
              : evidence.cwd
        const parsed = parseGrepResult(text, baseDir)
        for (const site of parsed.sites) addSite(evidence, { ...site, source: 'grep-decl' }, seq)
        for (const hit of parsed.hits) addFileLine(evidence, hit.file, hit.line, hit.text, seq)
      } else if (READ_TOOL.has(toolName)) {
        const parsed = parseReadResult(text)
        for (const site of parsed.sites) addSite(evidence, { ...site, source: 'read-decl' }, seq)
        if (parsed.file !== null) {
          for (const line of parsed.lines) addFileLine(evidence, parsed.file, line.line, line.text, seq)
        }
      } else if (EDIT_TOOL.has(toolName)) {
        const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
        if (file !== undefined) addFileLine(evidence, file, 0, '', seq)
        for (const site of parseReadResult(text).sites) addSite(evidence, site, seq)
      } else if (GLOB_TOOL.has(toolName)) {
        for (const path of text.split(/\r?\n/)) {
          const candidate = path.trim()
          if (candidate.length > 0 && /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs)$/i.test(candidate)) {
            addFileLine(evidence, isAbsolute(candidate) ? candidate : join(evidence.cwd, candidate), 0, '', seq)
          }
        }
      }
      folded += 1
    }
    evidence.lastSeq = seq
    evidence.eventCount += 1
  }
  return folded
}

/** Find a member declaration inside one class/interface body range. */
export function findMemberInLines(lines, ownerLine, memberName) {
  const start = Math.max(0, ownerLine - 1)
  let braceLine = -1
  let braceColumn = -1
  for (let index = start; index < Math.min(lines.length, start + 6); index++) {
    const column = lines[index].indexOf('{')
    if (column >= 0) { braceLine = index; braceColumn = column; break }
  }
  let end = lines.length - 1
  if (braceLine >= 0) {
    let depth = 0
    let done = false
    for (let index = braceLine; index < lines.length && !done; index++) {
      const text = lines[index]
      for (let column = index === braceLine ? braceColumn : 0; column < text.length; column++) {
        const character = text[column]
        if (character === '{') depth += 1
        else if (character === '}') {
          depth -= 1
          if (depth === 0) { end = index; done = true; break }
        }
      }
    }
  }
  const escaped = escapeRegExp(memberName)
  const pattern = new RegExp(`(?:^|[^\\w$])${escaped}\\s*(?:[:(=<]|\\bas\\b|\\?:)`)
  for (let index = start; index <= end && index < lines.length; index++) {
    if (!pattern.test(lines[index])) continue
    if (index === start && lines[index].includes('{') === false) continue
    return { line: index + 1, column: lines[index].indexOf(memberName) + 1 }
  }
  return null
}

/** Resolve a relative import specifier to an existing source file. */
export function resolveImport(fromFile, specifier) {
  const base = isAbsolute(specifier) ? specifier : resolvePath(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      // keep trying
    }
  }
  return null
}

/** Follow `export { X } from './x'` / `export * from './x'` chains to the declaration. */
export async function followReExport(file, line, name, depth = 0) {
  if (depth > 3) return null
  const lines = await getFileLines(file)
  const text = lines[line - 1] ?? ''
  const named = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/.exec(text)
  if (named !== null) {
    const exported = named[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim())
    if (exported.includes(name)) {
      const target = resolveImport(file, named[2])
      if (target === null) return null
      const declaration = await findDeclarationInFile(target, name)
      if (declaration !== null) return declaration
      return await followReExport(target, 1, name, depth + 1)
    }
  }
  const star = /export\s+\*\s+from\s+['"]([^'"]+)['"]/.exec(text)
  if (star !== null) {
    const target = resolveImport(file, star[1])
    if (target === null) return null
    const declaration = await findDeclarationInFile(target, name)
    if (declaration !== null) return declaration
    return await followReExport(target, 1, name, depth + 1)
  }
  return null
}

/** Find one declaration by name inside one file. */
async function findDeclarationInFile(file, name) {
  const lines = await getFileLines(file)
  for (let index = 0; index < lines.length; index++) {
    const declaration = DECL_LINE.exec(lines[index])
    if (declaration !== null && declaration[2] === name) {
      return { file, line: index + 1, column: lines[index].indexOf(name) + 1, kind: declaration[1] }
    }
  }
  return null
}

/** Evidence candidates for one token (with member and re-export handling). */
async function candidatesFromEvidence(evidence, text) {
  const dot = text.lastIndexOf('.')
  if (dot > 0) {
    const ownerName = text.slice(0, dot)
    const memberName = text.slice(dot + 1)
    const owners = (evidence.symbols.get(ownerName) ?? []).slice(-8).reverse()
    const out = []
    for (const owner of owners) {
      let lines = evidence.files.get(owner.file)?.lines
      let lineList
      if (lines !== undefined) {
        lineList = []
        const maxLine = Math.max(...[...lines.keys()], owner.line)
        for (let line = 1; line <= maxLine; line++) lineList.push(lines.get(line) ?? '')
      } else {
        lineList = await getFileLines(owner.file)
      }
      const member = findMemberInLines(lineList, owner.line, memberName)
      if (member !== null) {
        out.push({ file: owner.file, line: member.line, column: member.column, kind: 'member', score: Math.max(0.5, EVIDENCE_SCORE['grep-decl'] - 0.08 - pathPenalty(owner.file)), evidence: 'evidence' })
      }
    }
    return out
  }
  const sites = (evidence.symbols.get(text) ?? []).slice()
  const out = []
  for (const site of sites) {
    let resolved = site
    const fileLines = await getFileLines(site.file)
    const lineText = fileLines[site.line - 1] ?? site.lineText ?? ''
    if (/export\s+(?:type\s+)?\{|export\s+\*\s+from/.test(lineText)) {
      const chained = await followReExport(site.file, site.line, text)
      if (chained !== null) resolved = { ...chained, source: site.source }
    }
    const base = EVIDENCE_SCORE[site.source] ?? EVIDENCE_SCORE['grep-hit']
    out.push({
      file: resolved.file,
      line: resolved.line,
      column: 1,
      kind: resolved.kind ?? site.kind,
      score: Math.max(0.5, base - pathPenalty(resolved.file)),
      evidence: site.source === 'read-decl' ? 'read' : 'grep',
    })
  }
  return out
}

/** Candidates parsed directly from files the prose/tool args pointed at. */
async function candidatesFromFiles(files, text) {
  const out = []
  const dot = text.lastIndexOf('.')
  for (const file of files.slice(0, 20)) {
    const lines = await getFileLines(file)
    if (lines.length === 0) continue
    if (dot > 0) {
      const ownerName = text.slice(0, dot)
      const memberName = text.slice(dot + 1)
      for (let index = 0; index < lines.length; index++) {
        const declaration = DECL_LINE.exec(lines[index])
        if (declaration === null || declaration[2] !== ownerName) continue
        const member = findMemberInLines(lines, index + 1, memberName)
        if (member !== null) out.push({ file, line: member.line, column: member.column, kind: 'member', score: EVIDENCE_SCORE['hint-decl'] - pathPenalty(file), evidence: 'hint' })
      }
    } else {
      for (let index = 0; index < lines.length; index++) {
        const declaration = DECL_LINE.exec(lines[index])
        if (declaration === null || declaration[2] !== text) continue
        out.push({ file, line: index + 1, column: 1, kind: declaration[1], score: EVIDENCE_SCORE['hint-decl'] - pathPenalty(file), evidence: 'hint' })
      }
    }
  }
  return out
}

/** Candidates from the workspace symbol index (lowest confidence source). */
async function candidatesFromIndex(index, text) {
  const dot = text.lastIndexOf('.')
  if (dot > 0) {
    const ownerName = text.slice(0, dot)
    const memberName = text.slice(dot + 1)
    const ranked = rankCandidates(index.symbols.get(ownerName))
    if (ranked.head === undefined) return []
    const lines = await getFileLines(ranked.head.file)
    const member = findMemberInLines(lines, ranked.head.line, memberName)
    if (member === null) return []
    return [{ file: ranked.head.file, line: member.line, column: member.column, kind: 'member', score: EVIDENCE_SCORE['index-unique'] - pathPenalty(ranked.head.file), evidence: 'index' }]
  }
  const ranked = rankCandidates(index.symbols.get(text))
  if (ranked.head === undefined) return []
  let resolved = ranked.head
  const lines = await getFileLines(ranked.head.file)
  if (/export\s+(?:type\s+)?\{|export\s+\*\s+from/.test(lines[ranked.head.line - 1] ?? '')) {
    const chained = await followReExport(ranked.head.file, ranked.head.line, text)
    if (chained !== null) resolved = { ...chained, kind: ranked.head.kind }
  }
  const base = ranked.count === 1 ? EVIDENCE_SCORE['index-unique'] : EVIDENCE_SCORE['index-ambiguous']
  return [{ file: resolved.file, line: resolved.line, column: 1, kind: resolved.kind ?? ranked.head.kind, score: base - pathPenalty(resolved.file), evidence: 'index' }]
}

/** Dedupe candidates by canonical file:line, keeping the best score. */
export function dedupeCandidates(candidates) {
  const byKey = new Map()
  for (const candidate of candidates) {
    const key = `${canonicalPathKey(candidate.file)}:${candidate.line}`
    const existing = byKey.get(key)
    if (existing === undefined || candidate.score > existing.score) byKey.set(key, candidate)
  }
  return [...byKey.values()].sort((left, right) => (right.score - left.score)
    || pathPenalty(left.file) - pathPenalty(right.file)
    || left.file.localeCompare(right.file)
    || (left.line - right.line))
}

/** Decide linked / ambiguous / unresolved from ranked candidates. */
export function decideCandidates(candidates) {
  const list = dedupeCandidates(candidates)
  if (list.length === 0) return { status: 'unresolved', chosen: null, candidates: [] }
  const top = list[0]
  const closeRivals = list.slice(1).filter(candidate => top.score - candidate.score < 0.12)
  if (top.score < 0.5) return { status: 'unresolved', chosen: top, candidates: list.slice(0, 5) }
  if (closeRivals.length > 0 && top.score < 0.9) return { status: 'ambiguous', chosen: top, candidates: list.slice(0, 5) }
  return { status: 'linked', chosen: top, candidates: list.slice(0, 5) }
}

// ───────────────────────── workspace index enumeration ─────────────────────────

/** Capture a child process stdout ('' on failure/timeout). */
function runCapture(command, args, cwd, timeoutMs = 5000) {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    let child
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      child = spawn(command, args, { cwd, windowsHide: true })
    } catch {
      finish('')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish('')
    }, timeoutMs)
    child.stdout?.on('data', chunk => { output += chunk })
    child.on('error', () => { clearTimeout(timer); finish('') })
    child.on('close', () => { clearTimeout(timer); finish(output) })
  })
}

/**
 * Enumerate source files under one root. `git ls-files` is dramatically faster
 * than a recursive walk and respects ignore rules; the walk is the fallback.
 * @returns {Promise<{ files: string[], enumeratedBy: 'git'|'walk' }>}
 */
export async function listSourceFiles(root) {
  const gitOutput = await runCapture('git', ['ls-files', '-z'], root)
  if (gitOutput.length > 0) {
    const files = []
    for (const entry of gitOutput.split('\0')) {
      if (entry.length === 0) continue
      const dot = entry.lastIndexOf('.')
      if (dot < 0 || !SOURCE_EXT.has(entry.slice(dot).toLowerCase())) continue
      if (entry.split('/').some(part => SKIP_DIRS.has(part))) continue
      files.push(join(root, entry))
      if (files.length >= MAX_FILES) break
    }
    if (files.length > 0) return { files, enumeratedBy: 'git' }
  }
  return { files: await walk(root), enumeratedBy: 'walk' }
}

/**
 * Split a trailing `:line` / `:line-end` suffix from one inline-code token.
 * Windows drive letters are safe because only a trailing digit group is peeled.
 * @param {string} text
 * @returns {{ text: string, line: number|undefined, endLine?: number }}
 */
export function splitTokenLine(text) {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)$/.exec(String(text))
  if (match === null) return { text: String(text), line: undefined }
  const result = { text: match[1], line: Number(match[2]) }
  if (match[3] !== undefined) result.endLine = Number(match[3])
  return result
}

function slashPath(file) {
  return String(file).replace(/\\/g, '/')
}

function baseName(file) {
  const normalized = slashPath(file)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Every file the resolver knows about (session evidence + workspace index). */
function knownFiles(evidence, index) {
  const set = new Set()
  for (const file of evidence?.files?.keys?.() ?? []) set.add(file)
  for (const file of index?.fileList ?? []) set.add(file)
  return [...set]
}

/** Symbols that appear in code expressions but are not workspace references. */
const INLINE_SYMBOL_IGNORE = new Set([
  'require', 'createElement', 'console', 'module', 'exports', 'process', 'window', 'document',
  'props', 'ctx', 'this', 'get', 'set', 'map', 'filter', 'find', 'then', 'catch', 'value', 'item',
  'items', 'node', 'data', 'blocks', 'class', 'function', 'return', 'const', 'let', 'var', 'import',
  'export', 'default', 'string', 'number', 'boolean', 'object', 'array', 'promise', 'json', 'math',
  'date', 'error', 'line', 'file', 'path', 'owner', 'sessionId', 'status', 'kind', 'label', 'title',
  'open', 'hit', 'hits', 'result', 'results', 'cache', 'index', 'options', 'config', 'true', 'false',
  'null', 'undefined', 'async', 'await', 'type', 'interface', 'enum', 'extends', 'implements',
])

/**
 * Extract resolvable sub-references from one inline-code expression, e.g.
 * `require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView`,
 * `findMemberInLines:713`, `composeMentions()`, `props.openFile(...)`.
 * @param {string} text
 * @returns {Array<{ kind: 'path'|'symbol', value: string, line?: number }>}
 */
export function extractInlineRefs(text) {
  const raw = String(text)
  const refs = []
  const seen = new Set()
  const push = (kind, value, line) => {
    const trimmed = String(value).trim()
    if (trimmed.length < 3 || trimmed.length > 200) return
    const key = `${kind}|${trimmed}|${line ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ kind, value: trimmed, ...(line === undefined ? {} : { line }) })
  }
  const pathPattern = /(?:[A-Za-z]:)?(?:[\w.$@-]+[\\/])*[\w.$@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|rb|php|swift|scala|lua|ya?ml|toml)(?::\d+(?:-\d+)?)?/g
  for (const match of raw.matchAll(pathPattern)) push('path', match[0])
  const symbolLinePattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*:\s*(\d+)/g
  for (const match of raw.matchAll(symbolLinePattern)) {
    const name = match[1]
    if (!INLINE_SYMBOL_IGNORE.has(name.toLowerCase())) push('symbol', name, Number(match[2]))
  }
  const dottedPattern = /\b([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g
  for (const match of raw.matchAll(dottedPattern)) {
    if (!INLINE_SYMBOL_IGNORE.has(match[1].split('.')[0].toLowerCase())) push('symbol', match[1])
  }
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g
  for (const match of raw.matchAll(callPattern)) {
    if (!INLINE_SYMBOL_IGNORE.has(match[1].toLowerCase())) push('symbol', match[1])
  }
  const pascalPattern = /\b([A-Z][A-Za-z0-9_$]{3,})\b/g
  for (const match of raw.matchAll(pascalPattern)) {
    if (!INLINE_SYMBOL_IGNORE.has(match[1].toLowerCase())) push('symbol', match[1])
  }
  return refs.slice(0, 8)
}

/** Resolve one file path (with optional line/range) against the context's file universe. */
async function candidatesFromPath(path, line, endLine, context) {
  const target = slashPath(path).replace(/^\.\//, '')
  const needle = target.toLowerCase()
  const candidates = []
  const range = endLine === undefined ? {} : { endLine }
  const direct = isAbsolute(path) ? path : join(context.cwd, path)
  try {
    if (existsSync(direct) && statSync(direct).isFile()) {
      candidates.push({ file: direct, line: line ?? 1, column: 1, kind: 'file', score: 0.9 - pathPenalty(direct), evidence: 'path', ...range })
    }
  } catch {
    // ignore unreadable path
  }
  for (const file of context.universe) {
    const normalized = slashPath(file).toLowerCase()
    const matches = needle.includes('/')
      ? (normalized === needle || normalized.endsWith('/' + needle) || normalized.endsWith(needle))
      : baseName(file).toLowerCase() === needle
    if (!matches) continue
    const inEvidence = context.evidence?.files?.has?.(file) === true
    candidates.push({
      file,
      line: line ?? 1,
      column: 1,
      kind: 'file',
      score: (inEvidence ? 0.95 : 0.62) - pathPenalty(file),
      evidence: inEvidence ? 'evidence' : 'index',
      ...range,
    })
  }
  return candidates
}

/** Resolve one symbol (optionally overriding its line) through the 3 layers. */
async function candidatesFromSymbol(name, line, context) {
  const candidates = []
  candidates.push(...await candidatesFromEvidence(context.evidence, name))
  if (candidates.length === 0 && context.hintFiles.length > 0) candidates.push(...await candidatesFromFiles(context.hintFiles, name))
  if (candidates.length === 0 && context.index !== undefined) candidates.push(...await candidatesFromIndex(context.index, name))
  if (line !== undefined) {
    for (const candidate of candidates) {
      candidate.line = Math.max(1, line)
      candidate.kind = candidate.kind ?? 'symbol'
    }
  }
  return candidates
}

/** Terms ignored when fuzzy-matching a code snippet against read lines. */
const SNIPPET_STOP = new Set([
  'const', 'let', 'var', 'return', 'function', 'this', 'true', 'false', 'null', 'undefined',
  'string', 'number', 'boolean', 'interface', 'type', 'async', 'await', 'import', 'export',
  'props', 'ctx', 'get', 'set', 'map', 'filter', 'then', 'catch', 'line', 'file', 'path',
])

function normalizeSnippetText(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** Distinctive terms (identifiers + quoted strings) from one inline code snippet. */
export function snippetTerms(raw) {
  const terms = new Set()
  for (const match of String(raw).matchAll(/[A-Za-z_$][\w$]*/g)) {
    const term = match[0]
    if (term.length < 3) continue
    if (SNIPPET_STOP.has(term.toLowerCase())) continue
    terms.add(term)
  }
  for (const match of String(raw).matchAll(/(['"])([^'"\n]{2,40})\1/g)) terms.add(match[2])
  return [...terms]
}

/**
 * Fuzzy-match one code snippet against the lines this session actually read.
 * The assistant often paraphrases code (`useTurnData('turn-tail').closing...`
 * vs the source's `tail?.closing?...`), so this matches distinctive terms over
 * 1–4 consecutive read lines instead of requiring an exact substring.
 */
async function candidatesFromSnippet(raw, context) {
  const normalized = normalizeSnippetText(raw)
  if (normalized.length < 20) return []
  const terms = snippetTerms(raw)
  if (terms.length < 3) return []
  const strongTerms = terms.filter(term => term.length >= 5)

  const evaluate = entries => {
    let best = null
    const consider = (line, text) => {
      const normalizedText = normalizeSnippetText(text)
      let matched = 0
      let strongMatched = 0
      for (const term of terms) {
        if (!normalizedText.includes(term)) continue
        matched += 1
        if (term.length >= 5) strongMatched += 1
      }
      const ratio = matched / terms.length
      if (matched < 3 || ratio < 0.6 || strongMatched < 2) return
      const exact = normalizedText.includes(normalized)
      const score = exact ? 1 : ratio
      if (best === null || score > best.score) best = { line, score, ratio, matched }
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      consider(entry.line, entry.text)
      let text = String(entry.text)
      const windowEntries = [entry]
      for (let next = index + 1; next < entries.length && next < index + 4; next++) {
        if (entries[next].line !== entries[next - 1].line + 1) break
        windowEntries.push(entries[next])
        text += ' ' + String(entries[next].text)
        // Attribute the window to its most term-dense line.
        let dense = windowEntries[0]
        let denseCount = 0
        for (const candidateLine of windowEntries) {
          let count = 0
          for (const term of terms) if (String(candidateLine.text).includes(term)) count += 1
          if (count > denseCount) { dense = candidateLine; denseCount = count }
        }
        consider(dense.line, text)
      }
    }
    return best
  }

  const results = []
  for (const [file, record] of context.evidence.files) {
    const entries = [...record.lines.entries()].sort((left, right) => left[0] - right[0]).map(([line, text]) => ({ line, text: String(text) }))
    if (entries.length === 0) continue
    const best = evaluate(entries)
    if (best !== null) results.push({ file, line: best.line, column: 1, kind: 'snippet', score: 0.9 + Math.min(0.05, best.ratio * 0.05), evidence: 'snippet' })
  }
  for (const file of context.hintFiles.slice(0, 20)) {
    try {
      const lines = await getFileLines(file)
      if (lines.length === 0) continue
      const entries = lines.map((text, index) => ({ line: index + 1, text }))
      const best = evaluate(entries)
      if (best !== null) results.push({ file, line: best.line, column: 1, kind: 'snippet', score: 0.8 + Math.min(0.05, best.ratio * 0.05), evidence: 'snippet' })
    } catch {
      // unreadable hint file
    }
  }
  return dedupeCandidates(results)
}

/**
 * A whole-token path (possibly with `:line`), as opposed to a larger code
 * expression that merely contains a path (`require('pkg').Symbol`).
 */
const CLEAN_PATH_TOKEN = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.$@-]+[\\/])*[\w.$@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|rb|php|swift|scala|lua|ya?ml|toml)(?::\d+(?:-\d+)?)?$/

/**
 * Resolve one inline-code token: a file path (optionally `:line`), a symbol
 * name / dotted member / `name:line`, or a larger expression containing one of
 * those (e.g. `require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView`).
 * @param {string} text inline-code token
 * @param {{ cwd: string, evidence: any, index?: any, hintFiles: string[], universe: string[] }} context
 * @returns {Promise<Array<{file:string,line:number,column:number,kind:string,score:number,evidence:string}>>}
 */
export async function candidatesFromInline(text, context) {
  const raw = String(text).trim()
  if (raw.length < 3 || raw.length > 300 || raw.includes('**') || raw.includes('`')) return []
  if (/^(?:https?:|mailto:|data:)/i.test(raw)) return []
  const split = splitTokenLine(raw)
  if (CLEAN_PATH_TOKEN.test(raw)) {
    return await candidatesFromPath(split.text.trim(), split.line, split.endLine, context)
  }
  const simpleName = raw.replace(/\(\)$/, '')
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(simpleName)) {
    return await candidatesFromSymbol(simpleName, split.line, context)
  }
  const refs = extractInlineRefs(raw)
  const candidates = []
  if (refs.length > 0) {
    const pathRefs = refs.filter(ref => ref.kind === 'path')
    const selected = pathRefs.length > 0 ? pathRefs.slice(0, 2) : refs.slice(0, 4)
    for (const ref of selected) {
      if (ref.kind === 'path') {
        const pathSplit = splitTokenLine(ref.value)
        candidates.push(...await candidatesFromPath(pathSplit.text, pathSplit.line ?? ref.line, pathSplit.endLine, context))
      } else {
        candidates.push(...await candidatesFromSymbol(ref.value, ref.line, context))
      }
    }
  }
  if (candidates.length > 0) return candidates
  // Last resort: fuzzy-match the snippet against code this session actually read.
  return await candidatesFromSnippet(raw, context)
}

/**
 * @param {any} ctx host context (only used for the optional sessionQuery seam)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler(ctx) {
  /** @type {Map<string, { index?: Awaited<ReturnType<typeof buildIndex>>, building?: Promise<any> }>} */
  const indexSlots = new Map()
  /** @type {Map<string, { evidence: ReturnType<typeof createEvidence>, at: number, eventCount: number }>} */
  const evidenceSlots = new Map()
  /** @type {Map<string, { ledger: ReturnType<typeof createReferenceLedger>, at: number, eventCount: number }>} */
  const referenceSlots = new Map()

  function indexSlot(cwd) {
    const root = resolvePath(cwd)
    let slot = indexSlots.get(root)
    if (slot === undefined) {
      slot = {}
      indexSlots.set(root, slot)
      if (indexSlots.size > 4) {
        const oldest = indexSlots.keys().next().value
        if (oldest !== root) indexSlots.delete(oldest)
      }
    }
    if (slot.index === undefined && slot.building === undefined) {
      slot.building = buildIndex(root).then(index => {
        slot.index = index
        return index
      }).catch(() => undefined)
    }
    return slot
  }

  /** Wait for the workspace index at most waitMs (0 = only if already built). */
  async function ensureIndex(cwd, waitMs = 0) {
    const slot = indexSlot(cwd)
    if (slot.index !== undefined) return slot.index
    if (waitMs > 0) await Promise.race([slot.building, new Promise(resolve => setTimeout(resolve, waitMs))])
    return slot.index
  }

  /**
   * Read (and incrementally fold) one session's tool evidence.
   * The log is cold-read through the host sessionQuery seam; the ledger itself
   * is cached per session and only folds events past its watermark.
   */
  async function ensureEvidence(sessionId, cwd) {
    const cached = evidenceSlots.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < EVIDENCE_TTL_MS) return cached.evidence
    const query = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (query === undefined || query === null || typeof query.readSession !== 'function') {
      return cached?.evidence ?? createEvidence(cwd)
    }
    let snapshot
    try {
      snapshot = await query.readSession(sessionId)
    } catch {
      return cached?.evidence ?? createEvidence(cwd)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    let evidence = cached?.evidence ?? createEvidence(cwd)
    if (cached !== undefined && events.length < cached.eventCount) evidence = createEvidence(cwd)
    evidence.cwd = cwd
    const folded = foldSessionEvents(evidence, events)
    evidenceSlots.set(sessionId, { evidence, at: Date.now(), eventCount: events.length })
    evidence.lastFolded = folded
    return evidence
  }

  /**
   * Read (and incrementally fold) one session's reference ledger.
   * Same session log seam as the evidence ledger, but the fold keeps every
   * observed file/URL/symbol plus provenance instead of resolver candidates.
   */
  async function ensureReferences(sessionId, cwd) {
    const cached = referenceSlots.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < EVIDENCE_TTL_MS) return cached.ledger
    const query = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (query === undefined || query === null || typeof query.readSession !== 'function') {
      return cached?.ledger ?? createReferenceLedger(cwd, sessionId)
    }
    let snapshot
    try {
      snapshot = await query.readSession(sessionId)
    } catch {
      return cached?.ledger ?? createReferenceLedger(cwd, sessionId)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    let ledger = cached?.ledger ?? createReferenceLedger(cwd, sessionId)
    if (cached !== undefined && events.length < cached.eventCount) ledger = createReferenceLedger(cwd, sessionId)
    ledger.cwd = cwd
    foldReferenceEvents(ledger, events, { parseGrepResult, parseReadResult, flattenToolResult })
    referenceSlots.set(sessionId, { ledger, at: Date.now(), eventCount: events.length })
    return ledger
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === `${ROUTE_PREFIX}/health`) {
        const cwd = url.searchParams.get('cwd')
        let indexInfo = null
        if (typeof cwd === 'string' && isAbsolute(cwd)) {
          const index = await ensureIndex(cwd, 5000)
          indexInfo = index === undefined
            ? { cwd, building: true }
            : { cwd: index.cwd, files: index.files, enumeratedFiles: index.enumeratedFiles, enumeratedBy: index.enumeratedBy, symbols: index.symbols.size, builtAt: index.builtAt }
        }
        sendJson(res, 200, { ok: true, plugin: { name, version: VERSION }, index: indexInfo })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/instruction`) {
        sendJson(res, 200, {
          ok: true,
          registered: citationInfo.registered,
          order: citationInfo.order,
          registeredAt: citationInfo.at,
          name: 'coderef:citations',
          text: REFERENCES_INSTRUCTION,
        })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/debug/evidence`) {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const cwd = url.searchParams.get('cwd') ?? ''
        const evidence = await ensureEvidence(sessionId, cwd)
        const sample = [...evidence.symbols.entries()].slice(0, 12).map(([symbol, sites]) => ({
          symbol,
          sites: sites.slice(-2).map(site => ({ file: site.file, line: site.line, kind: site.kind, source: site.source })),
        }))
        sendJson(res, 200, {
          ok: true,
          sessionId,
          cwd: evidence.cwd,
          events: evidence.eventCount,
          lastSeq: evidence.lastSeq,
          symbols: evidence.symbols.size,
          files: evidence.files.size,
          calls: evidence.calls.size,
          lastFolded: evidence.lastFolded ?? 0,
          sample,
        })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/debug/session`) {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const query = ctx !== null && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
        if (query === undefined || query === null || typeof query.readSession !== 'function') {
          sendJson(res, 501, { ok: false, error: 'sessionQuery-unavailable' })
          return
        }
        try {
          const snapshot = await query.readSession(sessionId)
          const events = Array.isArray(snapshot?.events) ? snapshot.events : []
          const types = {}
          for (const event of events) types[event?.type ?? '?'] = (types[event?.type ?? '?'] ?? 0) + 1
          const toolEvents = events.filter(event => String(event?.type ?? '').includes('tool')).slice(0, 3).map(event => ({
            type: event.type,
            keys: event.data !== null && typeof event.data === 'object' ? Object.keys(event.data) : [],
            preview: JSON.stringify(event.data).slice(0, 600),
          }))
          sendJson(res, 200, { ok: true, snapshotKeys: Object.keys(snapshot ?? {}), events: events.length, types, toolEvents })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        }
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/refs`) {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const cwd = url.searchParams.get('cwd') ?? ''
        if (sessionId === '' || !isAbsolute(cwd)) {
          sendJson(res, 400, { ok: false, error: 'expected ?sessionId=<id>&cwd=<absolute path>' })
          return
        }
        const ledger = await ensureReferences(sessionId, cwd)
        const sinceParam = url.searchParams.get('since')
        if (sinceParam !== null && Number.isFinite(Number(sinceParam)) && Number(sinceParam) === ledger.eventCount) {
          sendJson(res, 200, { ok: true, unchanged: true, version: ledger.eventCount })
          return
        }
        sendJson(res, 200, { ok: true, ...summarizeReferences(ledger) })
        return
      }

      if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/resolve`) {
        const body = await readJsonBody(req)
        const cwd = body !== undefined && typeof body.cwd === 'string' ? body.cwd : undefined
        const sessionId = body !== undefined && typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 120
          ? body.sessionId
          : undefined
        const texts = body !== undefined && Array.isArray(body.texts)
          ? body.texts.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 120).slice(0, 200)
          : []
        const hints = body !== undefined && Array.isArray(body.hints)
          ? body.hints.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 320 && isAbsolute(value)).slice(0, 40)
          : []
        const relativeHints = body !== undefined && Array.isArray(body.relativeHints)
          ? body.relativeHints.filter(value => typeof value === 'string' && value.length >= 8 && value.length <= 320).slice(0, 40)
          : []
        const inlineTexts = body !== undefined && Array.isArray(body.inlineTexts)
          ? body.inlineTexts.filter(value => typeof value === 'string' && value.length >= 3 && value.length <= 300).slice(0, 80)
          : []
        if (cwd === undefined || !isAbsolute(cwd)) {
          sendJson(res, 400, { ok: false, error: 'expected { cwd: absolute string, texts: string[], inlineTexts?: string[], hints?: string[], relativeHints?: string[], sessionId?: string }' })
          return
        }

        // Layer 1: session evidence (tool/call + tool/result). Layer 2: files the
        // prose itself names (absolute hints and cwd/sibling-relative paths).
        // Layer 3: the workspace symbol index, started in the background and
        // awaited only when the first two layers produced nothing.
        const evidence = sessionId === undefined ? createEvidence(cwd) : await ensureEvidence(sessionId, cwd)
        const resolvedRelative = resolveRelativeHints(relativeHints, cwd)
        const hintFiles = [...new Set([
          ...hints,
          ...resolvedRelative,
          ...mapRelativeHints(relativeHints, [...hints, ...resolvedRelative]),
        ])]
        const slot = indexSlot(cwd)
        let indexUsed = false
        let indexWaited = false
        const items = []
        for (const text of texts) {
          const candidates = []
          candidates.push(...await candidatesFromEvidence(evidence, text))
          if (candidates.length === 0) candidates.push(...await candidatesFromFiles(hintFiles, text))
          if (candidates.length === 0) {
            const index = await ensureIndex(cwd, INDEX_WAIT_MS)
            indexWaited = true
            if (index !== undefined) {
              indexUsed = true
              candidates.push(...await candidatesFromIndex(index, text))
            }
          } else if (slot.index !== undefined) {
            indexUsed = true
            candidates.push(...await candidatesFromIndex(slot.index, text))
          }
          const decision = decideCandidates(candidates)
          items.push({ text, kind: 'bold', status: decision.status, chosen: decision.chosen, candidates: decision.candidates })
        }

        // Inline-code tokens: the host renderer calls fileMentions.resolve(value)
        // for every inline code span, so a resolved path/symbol here becomes a
        // clickable chip without any markdown rewrite.
        const inlineUniverse = knownFiles(evidence, slot.index)
        let inlineLinked = 0
        for (const text of inlineTexts) {
          const candidates = await candidatesFromInline(text, {
            cwd,
            evidence,
            index: slot.index,
            hintFiles,
            universe: inlineUniverse,
          })
          const decision = decideCandidates(candidates)
          if (decision.status === 'linked') inlineLinked += 1
          items.push({ text, kind: 'inline', status: decision.status, chosen: decision.chosen, candidates: decision.candidates })
        }

        const statusCounts = { linked: 0, ambiguous: 0, unresolved: 0 }
        const boldStatusCounts = { linked: 0, ambiguous: 0, unresolved: 0 }
        for (const item of items) {
          statusCounts[item.status] += 1
          if (item.kind === 'bold') boldStatusCounts[item.status] += 1
        }
        sendJson(res, 200, {
          ok: true,
          cwd,
          sessionId: sessionId ?? null,
          evidence: { events: evidence.eventCount, symbols: evidence.symbols.size, files: evidence.files.size, folded: evidence.lastFolded ?? 0 },
          hints: hintFiles.length,
          relativeResolved: resolvedRelative.length,
          index: {
            building: slot.index === undefined,
            used: indexUsed,
            waited: indexWaited,
            files: slot.index?.files ?? null,
            enumeratedFiles: slot.index?.enumeratedFiles ?? null,
            enumeratedBy: slot.index?.enumeratedBy ?? null,
          },
          statusCounts,
          boldStatusCounts,
          inline: { requested: inlineTexts.length, linked: inlineLinked },
          items,
        })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/ides`) {
        const ides = await listIdes()
        sendJson(res, 200, { ok: true, ides })
        return
      }

      if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/reveal`) {
        const body = await readJsonBody(req)
        const file = body !== undefined && typeof body.file === 'string' ? body.file : undefined
        if (file === undefined) {
          sendJson(res, 400, { ok: false, error: 'expected { file: absolute string }' })
          return
        }
        const result = await revealInFileManager(file)
        sendJson(res, result.ok ? 200 : 501, result)
        return
      }

      if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/open`) {
        const body = await readJsonBody(req)
        const file = body !== undefined && typeof body.file === 'string' ? body.file : undefined
        const line = body !== undefined && Number.isFinite(body.line) ? Math.max(1, Math.floor(body.line)) : 1
        const column = body !== undefined && Number.isFinite(body.column) ? Math.max(1, Math.floor(body.column)) : 1
        const ide = body !== undefined && typeof body.ide === 'string' && body.ide.length > 0 ? body.ide : undefined
        if (file === undefined) {
          sendJson(res, 400, { ok: false, error: 'expected { file: absolute string, line?: number, ide?: string }' })
          return
        }
        const result = await openInIde(file, line, column, ide)
        sendJson(res, result.ok ? 200 : 501, result)
        return
      }

      sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}

/** Test surface (not used by the runtime routes). */
export const __test = {
  buildIndex, rankCandidates, resolveText, openInIde, walk, indexHintFile,
  mapRelativeHints, sessionFileHints, resolveRelativeHints, listSourceFiles,
  parseGrepResult, parseReadResult, createEvidence, foldSessionEvents, listIdes, revealInFileManager,
  findMemberInLines, resolveImport, followReExport, dedupeCandidates, decideCandidates,
  candidatesFromEvidence, candidatesFromFiles, candidatesFromIndex,
  splitTokenLine, candidatesFromInline, knownFiles, extractInlineRefs,
  snippetTerms, candidatesFromSnippet,
}

/** Prompt-section registration state, exposed by the debug route. */
const citationInfo = { registered: false, order: null, at: null }

/**
 * Register the coderef citation section once systemPrompt is available.
 * `ctx.inject` is the safe path: plugin apply may run before the prompt service
 * is mounted, and the section must still land on the very next request.
 * @param {any} ctx
 */
function installCitationInstruction(ctx) {
  const register = (scope) => {
    const systemPrompt = scope?.systemPrompt
    if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') return
    const order = typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('FILE_REFERENCE') + 1
      : 901
    systemPrompt.section({
      name: 'coderef:citations',
      order,
      text: REFERENCES_INSTRUCTION,
    })
    citationInfo.registered = true
    citationInfo.order = order
    citationInfo.at = Date.now()
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], register)
      return
    }
    register(ctx)
  } catch {
    // A host without a prompt service is still a valid coderef host.
  }
}

/**
 * Cordis plugin body.
 * @param {any} ctx
 */
export function apply(ctx) {
  const handler = createHandler(ctx)
  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  ctx.effect(() => () => {
    try {
      dispose()
    } catch {
      // ignore dispose races during shutdown
    }
  })

  installCitationInstruction(ctx)
}

export { createReferenceLedger, foldReferenceEvents, summarizeReferences, REFERENCES_INSTRUCTION } from './references.js'




