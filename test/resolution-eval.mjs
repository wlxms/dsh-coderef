// Offline resolution evaluation (P1 baseline): decode local session logs, build
// the same evidence ledger the Host serves from, and score every bold token of
// each session's final assistant message against evidence → hints → index.
//
// Usage: node test/resolution-eval.mjs [sessions-root]
//   sessions-root defaults to <repo>/.dsh-home/sessions
import { globSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const sessionsRoot = process.argv[2] ?? join(here, '..', '..', '.dsh-home', 'sessions')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split concatenated zstd frames (RFC 8878 header/block walk). */
function splitFrames(buffer) {
  const frames = []
  let pos = 0
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0x28 || buffer[pos + 1] !== 0xb5 || buffer[pos + 2] !== 0x2f || buffer[pos + 3] !== 0xfd) {
      const next = buffer.indexOf(MAGIC, pos)
      if (next < 0) break
      pos = next
      continue
    }
    let index = pos + 4
    const descriptor = buffer[index]
    index += 1
    const fcsFlag = descriptor >>> 6
    const singleSegment = (descriptor >>> 5) & 1
    const checksum = (descriptor >>> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) index += 1
    index += [0, 1, 2, 4][dictFlag]
    index += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    let last = false
    while (!last) {
      if (index + 3 > buffer.length) throw new Error('truncated block header')
      const header = buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16)
      index += 3
      last = (header & 1) === 1
      const type = (header >>> 1) & 3
      const size = header >>> 3
      if (type === 0) index += size
      else if (type === 1) index += 1
      else if (type === 2) index += size
      else throw new Error('reserved block type')
    }
    if (checksum) index += 4
    frames.push(buffer.subarray(pos, index))
    pos = index
  }
  return frames
}

function readSessionEvents(file) {
  const events = []
  for (const frame of splitFrames(readFileSync(file))) {
    const text = zstdDecompressSync(frame).toString('utf8')
    for (const line of text.split('\n')) if (line.trim().length > 0) events.push(JSON.parse(line))
  }
  return events
}

function textOfMessage(event) {
  const content = event?.data?.message?.content ?? []
  const parts = []
  for (const block of content) if (typeof block?.text === 'string') parts.push(block.text)
  return parts.join('\n')
}

function cwdOf(events) {
  for (const event of events) {
    if (event.type !== 'session' && event.type !== 'request/header') continue
    const data = event.data ?? {}
    const candidates = [data.cwd, data.header?.cwd, data.session?.cwd, data.workspace?.cwd, data.path]
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return ''
}

const boldPattern = /\*\*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\*\*/g
const files = globSync(join(sessionsRoot, '**', 'session.v3.jsonl.zstd'))
const rows = []
const started = Date.now()

for (const file of files) {
  const events = readSessionEvents(file)
  const assistantEvents = events.filter(event => event.type === 'assistant/message')
  const finalMessage = assistantEvents.filter(event => textOfMessage(event).trim().length > 0).at(-1)
  if (finalMessage === undefined) continue
  const text = textOfMessage(finalMessage)
  const tokens = [...new Set([...text.matchAll(boldPattern)].map(match => match[1]))]
  if (tokens.length === 0) continue
  const cwd = cwdOf(events)
  const evidence = __test.createEvidence(cwd)
  __test.foldSessionEvents(evidence, events)
  const relative = [...text.matchAll(/`([^`\n]{8,300})`/g)]
    .map(match => match[1].replace(/:\d+(?::\d+)?$/, '').trim())
    .filter(value => value.includes('/') && !/^[A-Za-z]:/.test(value))
  const hintFiles = cwd === '' ? [] : __test.resolveRelativeHints(relative, cwd)
  let index
  const sessionLabel = file.split(/[\\/]sessions[\\/]/).at(-1)
  for (const token of tokens) {
    const candidates = []
    let source = 'evidence'
    candidates.push(...await __test.candidatesFromEvidence(evidence, token))
    if (candidates.length === 0) {
      source = 'hint'
      candidates.push(...await __test.candidatesFromFiles(hintFiles, token))
    }
    if (candidates.length === 0 && cwd !== '') {
      source = 'index'
      index ??= await __test.buildIndex(cwd)
      candidates.push(...await __test.candidatesFromIndex(index, token))
    }
    if (candidates.length === 0) source = 'none'
    const decision = __test.decideCandidates(candidates)
    rows.push({
      session: sessionLabel,
      token,
      source,
      status: decision.status,
      chosen: decision.chosen === null ? null : `${decision.chosen.file}:${decision.chosen.line}`,
      candidates: decision.candidates.length,
    })
  }
}

const counts = { linked: 0, ambiguous: 0, unresolved: 0 }
const sources = {}
for (const row of rows) {
  counts[row.status] += 1
  sources[row.source] = (sources[row.source] ?? 0) + 1
}
const table = rows.map(row => `${row.status.padEnd(10)} ${row.source.padEnd(8)} ${row.token.padEnd(28)} ${row.chosen ?? '(none)'}`)
console.log(table.join('\n'))
console.log('\nsummary:', JSON.stringify({
  sessions: new Set(rows.map(row => row.session)).size,
  tokens: rows.length,
  status: counts,
  source: sources,
  ms: Date.now() - started,
}, null, 2))
