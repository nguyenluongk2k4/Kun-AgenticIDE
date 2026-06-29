import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ExternalSyncDetectResult,
  ExternalSyncDetectedSource,
  ExternalSyncImportSummary,
  ExternalSyncSourceKind,
  ExternalSyncSourceSummary
} from '../../shared/kun-gui-api'
import { createThreadRecord } from '../../../kun/src/domain/thread.js'
import type { TurnItem } from '../../../kun/src/contracts/items.js'
import type { Turn } from '../../../kun/src/contracts/turns.js'
import type { AgentSession } from '../../../kun/src/domain/session.js'
import { FileThreadStore } from '../../../kun/src/adapters/file/file-thread-store.js'
import { FileSessionStore } from '../../../kun/src/adapters/file/file-session-store.js'
import { HybridSessionStore } from '../../../kun/src/adapters/hybrid/hybrid-session-store.js'
import { HybridThreadStore } from '../../../kun/src/adapters/hybrid/hybrid-thread-store.js'
import { MemoryRecord } from '../../../kun/src/contracts/memory.js'
import { expandHomePath } from '../../../kun/src/config/kun-config.js'
import type { ThreadStore } from '../../../kun/src/ports/thread-store.js'
import type { SessionStore } from '../../../kun/src/ports/session-store.js'
import type { KunStorageSettingsV1 } from '../../shared/app-settings-types.js'

type ExternalSyncLogger = (message: string, detail?: unknown) => void

type ExternalConversation = {
  id: string
  sourcePath: string
  sourceKind: ExternalSyncSourceKind
  title: string
  workspace: string
  createdAt: string
  updatedAt: string
  turnPrompt: string
  items: TurnItem[]
}

type ExternalMemoryChunk = {
  id: string
  sourceKind: ExternalSyncSourceKind
  sourcePath: string
  content: string
  scope: 'user' | 'workspace' | 'project'
  workspace?: string
  project?: string
  tags: string[]
}

type ExternalSyncSourceData = {
  source: ExternalSyncDetectedSource
  conversations: ExternalConversation[]
  memories: ExternalMemoryChunk[]
}

const IMPORT_THREAD_PREFIX = 'thr_import'
const IMPORT_TURN_PREFIX = 'turn_import'
const MAX_MEMORY_CHUNK_CHARS = 1_200

export async function detectExternalSyncSources(input: {
  destDataDir: string
  homeDir?: string
  defaultWorkspace: string
  storage?: KunStorageSettingsV1
}): Promise<ExternalSyncDetectResult> {
  const homeDir = input.homeDir ?? homedir()
  const data = await collectExternalSyncSources({
    homeDir,
    defaultWorkspace: input.defaultWorkspace
  })
  const destThreadsDir = join(resolve(input.destDataDir), 'threads')
  const destMemoryDir = join(resolve(input.destDataDir), 'memory')
  const stores = await createSyncStores(resolve(input.destDataDir), input.storage)
  try {
    return {
    destThreadsDir,
    destMemoryDir,
    sources: await Promise.all(
      data.map(async (entry) => ({
        ...entry.source,
        newConversationCount: await countPendingConversationImports(stores.threadStore, entry.conversations),
        newMemoryCount: await countPendingMemoryImports(destMemoryDir, entry.memories)
      }))
    ),
    unsupported: [
      {
        kind: 'antigravity',
        note: 'No stable local conversation or memory store was detected for Antigravity yet.'
      }
    ]
  }
  } finally {
    await stores.shutdown?.()
  }
}

export async function importExternalSyncSources(input: {
  destDataDir: string
  defaultWorkspace: string
  defaultModel: string
  homeDir?: string
  sourceIds?: string[]
  includeConversations?: boolean
  includeMemories?: boolean
  storage?: KunStorageSettingsV1
  log?: ExternalSyncLogger
}): Promise<ExternalSyncImportSummary> {
  const homeDir = input.homeDir ?? homedir()
  const data = await collectExternalSyncSources({
    homeDir,
    defaultWorkspace: input.defaultWorkspace
  })
  const selectedSourceIds = new Set((input.sourceIds ?? []).map((id) => id.trim()).filter(Boolean))
  const includeConversations = input.includeConversations !== false
  const includeMemories = input.includeMemories !== false
  const destDataDir = resolve(input.destDataDir)
  const stores = await createSyncStores(destDataDir, input.storage)
  const threadStore = stores.threadStore
  const sessionStore = stores.sessionStore
  await mkdir(join(destDataDir, 'threads'), { recursive: true })
  await mkdir(join(destDataDir, 'memory'), { recursive: true })

  const summary: ExternalSyncImportSummary = {
    destThreadsDir: join(destDataDir, 'threads'),
    destMemoryDir: join(destDataDir, 'memory'),
    conversationsTotal: 0,
    conversationsImported: 0,
    conversationsSkipped: 0,
    memoriesTotal: 0,
    memoriesImported: 0,
    memoriesSkipped: 0,
    workspaceRoots: [],
    sources: [],
    warnings: []
  }
  const importedWorkspaceRoots = new Set<string>()

  for (const entry of data) {
    if (selectedSourceIds.size > 0 && !selectedSourceIds.has(entry.source.id)) continue
    const sourceSummary: ExternalSyncSourceSummary = {
      kind: entry.source.kind,
      path: entry.source.path,
      conversationsTotal: includeConversations ? entry.conversations.length : 0,
      conversationsImported: 0,
      conversationsSkipped: 0,
      memoriesTotal: includeMemories ? entry.memories.length : 0,
      memoriesImported: 0,
      memoriesSkipped: 0
    }

    if (includeConversations) {
      for (const conversation of entry.conversations) {
        summary.conversationsTotal += 1
        const existing = await threadStore.get(conversation.id)
        if (!(await shouldImportConversation(existing, conversation))) {
          summary.conversationsSkipped += 1
          sourceSummary.conversationsSkipped += 1
          continue
        }
        try {
          const turnId = `${IMPORT_TURN_PREFIX}_${shortHash(`${conversation.id}:turn`)}`
          const turn: Turn = {
            id: turnId,
            threadId: conversation.id,
            status: 'completed',
            prompt: conversation.turnPrompt,
            model: input.defaultModel,
            steering: [],
            createdAt: conversation.createdAt,
            startedAt: conversation.createdAt,
            finishedAt: conversation.updatedAt,
            items: conversation.items,
            attachmentIds: [],
            activeSkillIds: [],
            injectedMemoryIds: []
          }
          const thread = createThreadRecord({
            id: conversation.id,
            title: conversation.title,
            workspace: conversation.workspace,
            model: input.defaultModel,
            createdAt: conversation.createdAt
          })
          thread.updatedAt = conversation.updatedAt
          thread.turns = [turn]

          const session: AgentSession = {
            threadId: conversation.id,
            turnId,
            startedAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            items: conversation.items,
            events: [],
            closed: true
          }

          await threadStore.upsert(thread)
          await sessionStore.rewriteItems(conversation.id, conversation.items)
          await sessionStore.upsertSession(session)
          if (conversation.workspace.trim()) importedWorkspaceRoots.add(conversation.workspace.trim())
          summary.conversationsImported += 1
          sourceSummary.conversationsImported += 1
        } catch (error) {
          summary.conversationsSkipped += 1
          sourceSummary.conversationsSkipped += 1
          const message = error instanceof Error ? error.message : String(error)
          input.log?.('external-sync: failed to import conversation', {
            kind: entry.source.kind,
            sourcePath: conversation.sourcePath,
            message
          })
          summary.warnings.push(`Skipped ${entry.source.kind} conversation ${basename(conversation.sourcePath)}: ${message}`)
        }
      }
    }

    if (includeMemories) {
      for (const memory of entry.memories) {
        summary.memoriesTotal += 1
        const filePath = join(destDataDir, 'memory', `${memory.id}.json`)
        const existingRecord = await readMemoryRecord(filePath)
        if (!(await shouldImportMemory(existingRecord, memory))) {
          summary.memoriesSkipped += 1
          sourceSummary.memoriesSkipped += 1
          continue
        }
        try {
          const now = new Date().toISOString()
          const record = MemoryRecord.parse({
            id: memory.id,
            content: memory.content,
            scope: memory.scope,
            workspace: memory.workspace,
            project: memory.project,
            tags: memory.tags,
            confidence: 0.9,
            createdAt: now,
            updatedAt: now
          })
          await writeJsonFile(filePath, record)
          if (memory.project?.trim()) {
            importedWorkspaceRoots.add(memory.project.trim())
          } else if (memory.workspace?.trim()) {
            importedWorkspaceRoots.add(memory.workspace.trim())
          }
          summary.memoriesImported += 1
          sourceSummary.memoriesImported += 1
        } catch (error) {
          summary.memoriesSkipped += 1
          sourceSummary.memoriesSkipped += 1
          const message = error instanceof Error ? error.message : String(error)
          input.log?.('external-sync: failed to import memory', {
            kind: entry.source.kind,
            sourcePath: memory.sourcePath,
            message
          })
          summary.warnings.push(`Skipped ${entry.source.kind} memory ${basename(memory.sourcePath)}: ${message}`)
        }
      }
    }

    summary.sources.push(sourceSummary)
  }

  summary.workspaceRoots = [...importedWorkspaceRoots]
  await stores.shutdown?.()
  return summary
}

async function collectExternalSyncSources(input: {
  homeDir: string
  defaultWorkspace: string
}): Promise<ExternalSyncSourceData[]> {
  const [codex, claude] = await Promise.all([
    collectCodexSource(input),
    collectClaudeSource(input)
  ])
  return [codex, claude].filter((value): value is ExternalSyncSourceData => Boolean(value))
}

async function collectCodexSource(input: {
  homeDir: string
  defaultWorkspace: string
}): Promise<ExternalSyncSourceData | null> {
  const root = join(input.homeDir, '.codex')
  if (!(await pathExists(root))) return null
  const sessionFiles = await listFilesRecursive(join(root, 'sessions'), (path) => path.endsWith('.jsonl'))
  const memoryFiles = await listFilesRecursive(join(root, 'memories'), (path) => path.endsWith('.md'))
  const conversations = (
    await Promise.all(sessionFiles.map((filePath) => parseCodexConversation(filePath, input.defaultWorkspace)))
  ).filter((value): value is ExternalConversation => Boolean(value))
  const memories = (await Promise.all(memoryFiles.map((filePath) => parseCodexMemory(filePath)))).flat()
  if (conversations.length === 0 && memories.length === 0) return null
  return {
    source: {
      id: 'external-codex',
      kind: 'codex',
      path: root,
      conversationCount: conversations.length,
      newConversationCount: conversations.length,
      memoryCount: memories.length,
      newMemoryCount: memories.length,
      note: 'Imports Codex local sessions and markdown memory snapshots.'
    },
    conversations,
    memories
  }
}

async function collectClaudeSource(input: {
  homeDir: string
  defaultWorkspace: string
}): Promise<ExternalSyncSourceData | null> {
  const root = join(input.homeDir, '.claude')
  if (!(await pathExists(root))) return null
  const projectRoot = join(root, 'projects')
  const projectDirs = await listDirectories(projectRoot)
  const conversations: ExternalConversation[] = []
  const memories: ExternalMemoryChunk[] = []

  for (const projectDir of projectDirs) {
    const files = await listFilesRecursive(projectDir, (path) => path.endsWith('.jsonl'))
    for (const filePath of files) {
      const parsed = await parseClaudeConversation(filePath, input.defaultWorkspace)
      if (parsed) conversations.push(parsed)
    }
    const memoryDir = join(projectDir, 'memory')
    const memoryFiles = await listFilesRecursive(memoryDir, (path) => path.endsWith('.md'))
    for (const filePath of memoryFiles) {
      const chunks = await parseClaudeMemory(filePath, projectDir, input.defaultWorkspace)
      memories.push(...chunks)
    }
  }

  if (conversations.length === 0 && memories.length === 0) return null
  return {
    source: {
      id: 'external-claude',
      kind: 'claude',
      path: root,
      conversationCount: conversations.length,
      newConversationCount: conversations.length,
      memoryCount: memories.length,
      newMemoryCount: memories.length,
      note: 'Imports Claude project chats and project memory markdown files.'
    },
    conversations,
    memories
  }
}

async function parseCodexConversation(
  filePath: string,
  defaultWorkspace: string
): Promise<ExternalConversation | null> {
  const text = await safeReadUtf8(filePath)
  if (!text) return null
  const lines = parseJsonLines(text)
  const sessionMeta = lines.find((line) => fieldString(line, 'type') === 'session_meta')
  const workspace = fieldString(recordValue(sessionMeta, 'payload'), 'cwd') ?? defaultWorkspace
  const sourceTitle = extractImportedConversationTitle(lines, sessionMeta)
  const messages: Array<{ role: 'user' | 'assistant'; text: string; at: string }> = []
  for (const line of lines) {
    const payload = recordValue(line, 'payload')
    if (fieldString(payload, 'type') !== 'message') continue
    const role = fieldString(payload, 'role')
    if (role !== 'user' && role !== 'assistant') continue
    const parts = fieldValue(payload, 'content')
    const extracted = extractMessageText(parts)
    if (!extracted) continue
    messages.push({
      role,
      text: extracted,
      at: fieldString(line, 'timestamp') ?? new Date().toISOString()
    })
  }
  return buildImportedConversation({
    sourceKind: 'codex',
    sourcePath: filePath,
    workspace,
    sourceTitle,
    messages
  })
}

async function parseClaudeConversation(
  filePath: string,
  defaultWorkspace: string
): Promise<ExternalConversation | null> {
  const text = await safeReadUtf8(filePath)
  if (!text) return null
  const lines = parseJsonLines(text)
  const sourceTitle = extractImportedConversationTitle(lines)
  const messages: Array<{ role: 'user' | 'assistant'; text: string; at: string }> = []
  for (const line of lines) {
    const message = recordValue(line, 'message')
    const role = fieldString(message, 'role') ?? fieldString(line, 'type')
    if (role !== 'user' && role !== 'assistant') continue
    const content = fieldValue(message, 'content') ?? fieldValue(line, 'content')
    const extracted = extractMessageText(content)
    if (!extracted) continue
    messages.push({
      role,
      text: extracted,
      at: fieldString(message, 'created_at')
        ?? fieldString(line, 'timestamp')
        ?? new Date().toISOString()
    })
  }
  const workspace = decodeClaudeProjectPath(filePath) ?? defaultWorkspace
  return buildImportedConversation({
    sourceKind: 'claude',
    sourcePath: filePath,
    workspace,
    sourceTitle,
    messages
  })
}

function buildImportedConversation(input: {
  sourceKind: ExternalSyncSourceKind
  sourcePath: string
  workspace: string
  sourceTitle?: string
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: string }>
}): ExternalConversation | null {
  if (input.messages.length === 0) return null
  const id = `${IMPORT_THREAD_PREFIX}_${input.sourceKind}_${shortHash(input.sourcePath)}`
  const turnId = `${IMPORT_TURN_PREFIX}_${shortHash(`${input.sourcePath}:turn`)}`
  const createdAt = input.messages[0]?.at ?? new Date().toISOString()
  const updatedAt = input.messages[input.messages.length - 1]?.at ?? createdAt
  const prompt = input.messages.find((message) => message.role === 'user')?.text ?? 'Imported conversation'
  const title = compactTitle(input.sourceTitle ?? prompt)
  const items = input.messages.map((message, index): TurnItem => {
    const base = {
      id: `${shortHash(`${input.sourcePath}:${index}:${message.role}`)}_${index}`,
      turnId,
      threadId: id,
      role: message.role,
      status: 'completed' as const,
      createdAt: message.at,
      finishedAt: message.at
    }
    return message.role === 'user'
      ? {
          ...base,
          kind: 'user_message',
          text: message.text,
          displayText: message.text
        }
      : {
          ...base,
          kind: 'assistant_text',
          text: message.text
        }
  })
  return {
    id,
    sourcePath: input.sourcePath,
    sourceKind: input.sourceKind,
    title,
    workspace: input.workspace,
    createdAt,
    updatedAt,
    turnPrompt: prompt,
    items
  }
}

async function parseCodexMemory(filePath: string): Promise<ExternalMemoryChunk[]> {
  const text = await safeReadUtf8(filePath)
  if (!text?.trim()) return []
  const chunks = splitMarkdownMemory(text)
  return chunks.map((content, index) => ({
    id: `mem_import_codex_${shortHash(`${filePath}:${index}`)}`,
    sourceKind: 'codex',
    sourcePath: filePath,
    content,
    scope: 'user',
    tags: ['imported', 'codex', basename(filePath, '.md')]
  }))
}

async function parseClaudeMemory(
  filePath: string,
  projectDir: string,
  defaultWorkspace: string
): Promise<ExternalMemoryChunk[]> {
  const text = await safeReadUtf8(filePath)
  if (!text?.trim()) return []
  const projectPath = decodeClaudeProjectPath(projectDir) ?? defaultWorkspace
  const chunks = splitMarkdownMemory(text)
  return chunks.map((content, index) => ({
    id: `mem_import_claude_${shortHash(`${filePath}:${index}`)}`,
    sourceKind: 'claude',
    sourcePath: filePath,
    content,
    scope: 'project',
    workspace: projectPath,
    project: projectPath,
    tags: ['imported', 'claude', basename(filePath, '.md')]
  }))
}

function splitMarkdownMemory(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block
    if (next.length <= MAX_MEMORY_CHUNK_CHARS) {
      current = next
      continue
    }
    if (current) chunks.push(current)
    if (block.length <= MAX_MEMORY_CHUNK_CHARS) {
      current = block
      continue
    }
    for (const slice of splitLongText(block, MAX_MEMORY_CHUNK_CHARS)) {
      chunks.push(slice)
    }
    current = ''
  }
  if (current) chunks.push(current)
  return chunks.slice(0, 100)
}

function splitLongText(text: string, maxChars: number): string[] {
  const out: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxChars) {
    const breakpoint = remaining.lastIndexOf(' ', maxChars)
    const end = breakpoint > Math.floor(maxChars * 0.6) ? breakpoint : maxChars
    out.push(remaining.slice(0, end).trim())
    remaining = remaining.slice(end).trim()
  }
  if (remaining) out.push(remaining)
  return out
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  const parts = Array.isArray(content) ? content : [content]
  const texts: string[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.trim()) texts.push(part.trim())
      continue
    }
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    const candidates = [
      stringValue(record.text),
      stringValue(record.input_text),
      stringValue(record.output_text),
      stringValue(record.value),
      stringValue(record.content)
    ].filter((value): value is string => Boolean(value?.trim()))
    if (candidates.length > 0) {
      texts.push(...candidates.map((value) => value.trim()))
      continue
    }
    const nestedText = extractMessageText(recordValue(record, 'text'))
    if (nestedText) texts.push(nestedText)
  }
  return texts.join('\n\n').trim()
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      // Ignore malformed telemetry lines.
    }
  }
  return out
}

async function listFilesRecursive(
  root: string,
  predicate: (path: string) => boolean
): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const out: string[] = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listFilesRecursive(fullPath, predicate))
      continue
    }
    if (entry.isFile() && predicate(fullPath)) out.push(fullPath)
  }
  return out
}

async function listDirectories(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
}

function decodeClaudeProjectPath(pathLike: string): string | null {
  const marker = 'projects'
  const parts = pathLike.split(/[/\\]/)
  const projectsIndex = parts.findIndex((part) => part === marker)
  const encoded = projectsIndex >= 0 ? parts[projectsIndex + 1] : basename(pathLike)
  if (!encoded) return null
  const driveMatch = /^([a-zA-Z])--(.+)$/.exec(encoded)
  if (!driveMatch) return null
  const drive = driveMatch[1].toUpperCase()
  const rest = driveMatch[2].replace(/-/g, '\\')
  return `${drive}:\\${rest}`
}

function compactTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized
}

function extractImportedConversationTitle(
  lines: Record<string, unknown>[],
  sessionMeta?: Record<string, unknown>
): string | undefined {
  const candidates: unknown[] = []
  if (sessionMeta) {
    candidates.push(sessionMeta, recordValue(sessionMeta, 'payload'))
  }
  for (const line of lines) {
    candidates.push(
      line,
      recordValue(line, 'payload'),
      recordValue(line, 'message'),
      fieldValue(line, 'content')
    )
  }

  for (const candidate of candidates) {
    const title = extractTitleCandidate(candidate)
    if (title) return title
  }
  return undefined
}

function extractTitleCandidate(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return cleanImportedTitle(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractTitleCandidate(item)
      if (nested) return nested
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const directKeys = [
    'title',
    'chat_title',
    'conversation_title',
    'session_title',
    'name',
    'summary',
    'label'
  ]
  for (const key of directKeys) {
    const title = cleanImportedTitle(stringValue(record[key]))
    if (title) return title
  }

  const nestedKeys = ['session', 'conversation', 'chat', 'metadata', 'meta', 'payload', 'message']
  for (const key of nestedKeys) {
    const nested = extractTitleCandidate(record[key])
    if (nested) return nested
  }
  return undefined
}

function cleanImportedTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (normalized.length < 4) return undefined
  if (/^[0-9a-f]{8,}$/i.test(normalized.replace(/-/g, ''))) return undefined
  if (/^[A-Za-z]:\\/.test(normalized)) return undefined
  if (/[{}[\]]/.test(normalized)) return undefined
  return normalized
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

async function safeReadUtf8(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function recordValue(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const next = (value as Record<string, unknown>)[key]
  if (!next || typeof next !== 'object' || Array.isArray(next)) return undefined
  return next as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function fieldValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function fieldString(value: unknown, key: string): string | undefined {
  return stringValue(fieldValue(value, key))
}

async function countPendingConversationImports(
  threadStore: ThreadStore,
  conversations: ExternalConversation[]
): Promise<number> {
  const checks = await Promise.all(
    conversations.map(async (conversation) => {
      const existing = await threadStore.get(conversation.id)
      return shouldImportConversation(existing, conversation)
    })
  )
  return checks.filter(Boolean).length
}

async function countPendingMemoryImports(
  destMemoryDir: string,
  memories: ExternalMemoryChunk[]
): Promise<number> {
  const checks = await Promise.all(
    memories.map(async (memory) => {
      const existing = await readMemoryRecord(join(destMemoryDir, `${memory.id}.json`))
      return shouldImportMemory(existing, memory)
    })
  )
  return checks.filter(Boolean).length
}

async function shouldImportConversation(
  existing: Awaited<ReturnType<ThreadStore['get']>>,
  conversation: ExternalConversation
): Promise<boolean> {
  if (!existing) return true
  if (timestampMs(conversation.updatedAt) > timestampMs(existing.updatedAt)) return true
  if ((existing.title ?? '').trim() !== conversation.title.trim()) return true
  if ((existing.workspace ?? '').trim() !== conversation.workspace.trim()) return true
  const existingItems = existing.turns.flatMap((turn) => turn.items ?? [])
  return existingItems.length !== conversation.items.length
}

async function shouldImportMemory(
  existing: MemoryRecord | null,
  memory: ExternalMemoryChunk
): Promise<boolean> {
  if (!existing) return true
  if (existing.content !== memory.content) return true
  if (existing.scope !== memory.scope) return true
  if ((existing.workspace ?? '') !== (memory.workspace ?? '')) return true
  if ((existing.project ?? '') !== (memory.project ?? '')) return true
  return JSON.stringify(existing.tags ?? []) !== JSON.stringify(memory.tags)
}

async function readMemoryRecord(path: string): Promise<MemoryRecord | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return MemoryRecord.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

function timestampMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

async function createSyncStores(
  dataDir: string,
  storage?: KunStorageSettingsV1
): Promise<{ threadStore: ThreadStore; sessionStore: SessionStore; shutdown?: () => Promise<void> }> {
  if (storage?.backend === 'file') {
    return {
      threadStore: new FileThreadStore({ dataDir }),
      sessionStore: new FileSessionStore({ dataDir })
    }
  }

  const sqlitePath = storage?.sqlitePath?.trim() ? expandHomePath(storage.sqlitePath.trim()) : undefined
  const threadStore = new HybridThreadStore({
    dataDir,
    sqlitePath,
    nowIso: () => new Date().toISOString()
  })
  await threadStore.ready()
  return {
    threadStore,
    sessionStore: new HybridSessionStore({
      dataDir,
      index: threadStore
    }),
    shutdown: async () => {
      threadStore.close()
    }
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8')
}
