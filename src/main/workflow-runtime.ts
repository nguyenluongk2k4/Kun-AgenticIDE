import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import type {
  AppSettingsV1,
  WorkflowConditionConfigV1,
  WorkflowConnectionV1,
  WorkflowHttpRequestConfigV1,
  WorkflowNodeRunResultV1,
  WorkflowNodeRunStatus,
  WorkflowNodeV1,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowRunV1,
  WorkflowRuntimeStatus,
  WorkflowScheduleV1,
  WorkflowV1
} from '../shared/app-settings'
import { MAX_WORKFLOW_RUNS } from '../shared/app-settings-workflow'
import {
  SCHEDULER_INTERVAL_MS,
  hasEnabledScheduledTask,
  resolveScheduleModelConfig,
  runPromptViaRuntime,
  sleep,
  summarizeTaskResult,
  type ScheduleRuntimeDeps
} from './schedule-runtime-helpers'

const MAX_NODE_EXECUTIONS = 200
const MAX_RUN_DURATION_MS = 30 * 60_000
const AI_NODE_RESPONSE_TIMEOUT_MS = 30 * 60_000
const HTTP_MAX_RESPONSE_BYTES = 5_000_000
const LIVE_STATUS_LINGER_MS = 8_000

type WorkflowPayload = { json: unknown; text: string }
type ScheduleTriggerNode = Extract<WorkflowNodeV1, { type: 'schedule-trigger' }>

type NodeOutcome = {
  payload: WorkflowPayload
  message: string
  /** For condition nodes: which outgoing handle to follow ('true' | 'false'). */
  branch?: string
  /** For ai-agent nodes: the Kun thread created. */
  threadId?: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isScheduleTrigger(node: WorkflowNodeV1): node is ScheduleTriggerNode {
  return node.type === 'schedule-trigger'
}

function activeScheduleTriggers(workflow: WorkflowV1): ScheduleTriggerNode[] {
  return workflow.nodes
    .filter(isScheduleTrigger)
    .filter((node) => !node.disabled && node.config.schedule.kind !== 'manual')
}

export function workflowHasScheduleTrigger(workflow: WorkflowV1): boolean {
  return activeScheduleTriggers(workflow).length > 0
}

export function hasEnabledScheduledWorkflow(settings: AppSettingsV1): boolean {
  return settings.workflow.workflows.some((workflow) => workflow.enabled && workflowHasScheduleTrigger(workflow))
}

/** Minimal, dependency-free 5-field cron field parser ("* , - /"). */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const match = part.trim().match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!match) return null
    const star = match[1] === '*'
    const lo = star ? min : Number(match[1])
    const hi = star ? max : match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? max : lo
    const step = match[3] !== undefined ? Number(match[3]) : 1
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || step < 1) return null
    for (let value = lo; value <= hi; value += step) {
      if (value >= min && value <= max) out.add(value)
    }
  }
  return out.size ? out : null
}

/** Next fire time at or after `from` for a standard "min hour dom month dow" cron, in local time. */
export function cronNextRun(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dowsRaw = parseCronField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set([...dowsRaw].map((day) => (day === 7 ? 0 : day)))
  const domRestricted = parts[2].trim() !== '*'
  const dowRestricted = parts[4].trim() !== '*'

  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i += 1) {
    if (months.has(cursor.getMonth() + 1)) {
      const dom = cursor.getDate()
      const dow = cursor.getDay()
      // Standard cron: when both DOM and DOW are restricted, match either.
      const dayOk =
        domRestricted && dowRestricted
          ? doms.has(dom) || dows.has(dow)
          : (domRestricted ? doms.has(dom) : true) && (dowRestricted ? dows.has(dow) : true)
      if (dayOk && hours.has(cursor.getHours()) && minutes.has(cursor.getMinutes())) {
        return new Date(cursor.getTime())
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

function nextRunFromSchedule(schedule: WorkflowScheduleV1, from: Date): string {
  switch (schedule.kind) {
    case 'manual':
      return ''
    case 'at':
      return schedule.atTime.trim()
    case 'interval':
      return new Date(from.getTime() + schedule.everyMinutes * 60_000).toISOString()
    case 'cron': {
      const next = schedule.cron.trim() ? cronNextRun(schedule.cron, from) : null
      return next ? next.toISOString() : ''
    }
    case 'daily':
    default: {
      const [hourRaw, minuteRaw] = schedule.timeOfDay.split(':')
      const hour = Number(hourRaw)
      const minute = Number(minuteRaw)
      const next = new Date(from)
      next.setSeconds(0, 0)
      next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
      return next.toISOString()
    }
  }
}

export function computeWorkflowNextRunAt(workflow: WorkflowV1, from: Date): string {
  if (!workflow.enabled) return ''
  const candidates = activeScheduleTriggers(workflow)
    .map((node) => nextRunFromSchedule(node.config.schedule, from).trim())
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort()
  return candidates[0] ?? ''
}

function buildAdjacency(connections: WorkflowConnectionV1[]): Map<string, WorkflowConnectionV1[]> {
  const map = new Map<string, WorkflowConnectionV1[]>()
  for (const edge of connections) {
    const list = map.get(edge.source) ?? []
    list.push(edge)
    map.set(edge.source, list)
  }
  return map
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function readPath(payload: WorkflowPayload, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed || trimmed === 'text') return payload.text
  if (trimmed === 'json') return payload.json
  const segments = trimmed.replace(/^json\.?/, '').split('.').filter(Boolean)
  let cursor: unknown = payload.json
  for (const segment of segments) {
    if (cursor && typeof cursor === 'object' && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : safeJson(value)
}

function interpolate(template: string, payload: WorkflowPayload): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => stringifyValue(readPath(payload, expr)))
}

function evaluateCondition(config: WorkflowConditionConfigV1, payload: WorkflowPayload): boolean {
  const leftRaw = config.leftExpr.trim() ? readPath(payload, config.leftExpr) : payload.text
  const left = stringifyValue(leftRaw)
  const right = config.rightValue
  const l = config.caseSensitive ? left : left.toLowerCase()
  const r = config.caseSensitive ? right : right.toLowerCase()
  switch (config.operator) {
    case 'contains':
      return l.includes(r)
    case 'notContains':
      return !l.includes(r)
    case 'equals':
      return l === r
    case 'notEquals':
      return l !== r
    case 'startsWith':
      return l.startsWith(r)
    case 'endsWith':
      return l.endsWith(r)
    case 'isEmpty':
      return left.trim() === ''
    case 'isNotEmpty':
      return left.trim() !== ''
    case 'gt':
      return Number(left) > Number(right)
    case 'gte':
      return Number(left) >= Number(right)
    case 'lt':
      return Number(left) < Number(right)
    case 'lte':
      return Number(left) <= Number(right)
    default:
      return false
  }
}

async function readBodyCapped(response: Response, limit: number): Promise<string> {
  const body = response.body
  if (!body) return response.text()
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw new Error('Response body exceeds the 5MB limit.')
      }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runHttpNode(config: WorkflowHttpRequestConfigV1, payload: WorkflowPayload): Promise<NodeOutcome> {
  const url = interpolate(config.url, payload).trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url || '(empty)'}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.')
  }
  const headers: Record<string, string> = {}
  for (const header of config.headers) {
    const key = header.key.trim()
    if (key) headers[key] = interpolate(header.value, payload)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const init: RequestInit = { method: config.method, headers, signal: controller.signal }
    if (config.method !== 'GET' && config.method !== 'DELETE' && config.body.trim()) {
      init.body = interpolate(config.body, payload)
    }
    const response = await fetch(url, init)
    const raw = await readBodyCapped(response, HTTP_MAX_RESPONSE_BYTES)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }
    let json: unknown = { status: response.status, body: raw }
    if (config.parseJson) {
      try {
        json = JSON.parse(raw)
      } catch {
        json = { status: response.status, body: raw }
      }
    }
    return { payload: { json, text: raw }, message: `${response.status} ${response.statusText}`.trim() }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${config.timeoutMs}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function summarizeRun(results: WorkflowNodeRunResultV1[]): string {
  const lastMeaningful = [...results].reverse().find((result) => result.status === 'success' && result.message.trim())
  if (lastMeaningful) return lastMeaningful.message
  return `Completed ${results.length} step${results.length === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  private readonly deps: ScheduleRuntimeDeps
  private scheduler: ReturnType<typeof setInterval> | null = null
  private runningWorkflowIds = new Set<string>()
  private cancelRequested = new Set<string>()
  /** workflowId -> nodeId -> live status, surfaced to the canvas via status(). */
  private liveNodeStatus = new Map<string, Map<string, WorkflowNodeRunStatus>>()
  private powerSaveBlockerId: number | null = null

  constructor(deps: ScheduleRuntimeDeps) {
    this.deps = deps
  }

  sync(settings: AppSettingsV1): void {
    this.startScheduler()
    this.syncPowerSaveBlocker(settings)
    void this.ensureNextRuns(settings)
  }

  stop(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler)
      this.scheduler = null
    }
    this.stopPowerSaveBlocker()
  }

  async status(): Promise<WorkflowRuntimeStatus> {
    const nodeStatus: Record<string, Record<string, WorkflowNodeRunStatus>> = {}
    for (const [workflowId, map] of this.liveNodeStatus) {
      nodeStatus[workflowId] = Object.fromEntries(map)
    }
    return {
      runningWorkflowIds: [...this.runningWorkflowIds],
      nodeStatus,
      powerSaveBlockerActive: this.isPowerSaveBlockerActive()
    }
  }

  async runWorkflow(workflowId: string): Promise<WorkflowRunResult> {
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) return { ok: false, message: 'Workflow not found.' }
    if (this.runningWorkflowIds.has(workflowId)) return { ok: false, message: 'Workflow is already running.' }
    const trigger =
      workflow.nodes.find((node) => node.type === 'manual-trigger') ??
      workflow.nodes.find((node) => node.type === 'schedule-trigger')
    if (!trigger) return { ok: false, message: 'Workflow has no trigger node.' }
    const runId = randomUUID()
    // Fire-and-poll: the UI watches status() for per-node progress.
    void this.runWorkflowInternal(workflow, trigger.id, 'manual', runId)
    return { ok: true, runId, status: 'running', message: 'Started' }
  }

  async stopWorkflow(workflowId: string): Promise<WorkflowRunResult> {
    if (!this.runningWorkflowIds.has(workflowId)) return { ok: false, message: 'Workflow is not running.' }
    this.cancelRequested.add(workflowId)
    return { ok: true, runId: '', status: 'running', message: 'Stopping' }
  }

  async runSingleNode(workflowId: string, nodeId: string): Promise<WorkflowRunResult> {
    const settings = await this.deps.store.load()
    const workflow = settings.workflow.workflows.find((item) => item.id === workflowId)
    if (!workflow) return { ok: false, message: 'Workflow not found.' }
    const node = workflow.nodes.find((item) => item.id === nodeId)
    if (!node) return { ok: false, message: 'Node not found.' }
    const runId = randomUUID()
    void (async () => {
      const live = new Map<string, WorkflowNodeRunStatus>([[nodeId, 'running']])
      this.liveNodeStatus.set(workflowId, live)
      try {
        await this.executeNode(node, { json: {}, text: '' }, settings)
        live.set(nodeId, 'success')
      } catch {
        live.set(nodeId, 'error')
      } finally {
        setTimeout(() => this.liveNodeStatus.delete(workflowId), LIVE_STATUS_LINGER_MS)
      }
    })()
    return { ok: true, runId, status: 'running', message: 'Started' }
  }

  private startScheduler(): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => {
      void this.tick()
    }, SCHEDULER_INTERVAL_MS)
    this.scheduler.unref?.()
    void this.tick()
  }

  private async tick(): Promise<void> {
    const settings = await this.deps.store.load()
    if (!settings.workflow.enabled) return
    await this.ensureNextRuns(settings)
    const fresh = await this.deps.store.load()
    const now = Date.now()
    for (const workflow of fresh.workflow.workflows) {
      if (!workflow.enabled || this.runningWorkflowIds.has(workflow.id)) continue
      const trigger = activeScheduleTriggers(workflow)[0]
      if (!trigger) continue
      const dueAt = Date.parse(workflow.nextRunAt)
      if (!Number.isFinite(dueAt) || dueAt > now) continue
      void this.runWorkflowInternal(workflow, trigger.id, 'schedule')
    }
  }

  private async ensureNextRuns(settings: AppSettingsV1): Promise<void> {
    if (!settings.workflow.enabled) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    let changed = false
    const now = new Date()
    const workflows = settings.workflow.workflows.map((workflow) => {
      const wasInterrupted = workflow.lastStatus === 'running' && !this.runningWorkflowIds.has(workflow.id)
      const scheduled = workflowHasScheduleTrigger(workflow)
      if (!workflow.enabled || !scheduled || this.runningWorkflowIds.has(workflow.id)) {
        if (!wasInterrupted) return workflow
        changed = true
        return {
          ...workflow,
          lastStatus: 'error' as const,
          lastMessage: 'Workflow was interrupted before completion.',
          updatedAt: now.toISOString()
        }
      }
      if (workflow.nextRunAt && !wasInterrupted) return workflow
      changed = true
      return {
        ...workflow,
        nextRunAt: computeWorkflowNextRunAt(workflow, now),
        ...(wasInterrupted
          ? {
              lastStatus: 'error' as const,
              lastMessage: 'Workflow was interrupted before completion.',
              updatedAt: now.toISOString()
            }
          : {})
      }
    })
    if (!changed) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    const saved = await this.deps.store.patch({ workflow: { ...settings.workflow, workflows } })
    this.syncPowerSaveBlocker(saved)
  }

  private async updateWorkflow(
    workflowId: string,
    updater: (workflow: WorkflowV1) => WorkflowV1
  ): Promise<AppSettingsV1> {
    const settings = await this.deps.store.load()
    const workflows = settings.workflow.workflows.map((workflow) =>
      workflow.id === workflowId ? updater(workflow) : workflow
    )
    const saved = await this.deps.store.patch({ workflow: { ...settings.workflow, workflows } })
    this.syncPowerSaveBlocker(saved)
    return saved
  }

  private setLive(workflowId: string, nodeId: string, status: WorkflowNodeRunStatus): void {
    const map = this.liveNodeStatus.get(workflowId) ?? new Map<string, WorkflowNodeRunStatus>()
    map.set(nodeId, status)
    this.liveNodeStatus.set(workflowId, map)
  }

  private async runWorkflowInternal(
    workflow: WorkflowV1,
    triggerNodeId: string,
    triggerLabel: string,
    runId = randomUUID()
  ): Promise<WorkflowRunResult> {
    if (this.runningWorkflowIds.has(workflow.id)) {
      return { ok: false, message: 'Workflow is already running.' }
    }
    this.runningWorkflowIds.add(workflow.id)
    this.cancelRequested.delete(workflow.id)

    const liveStatus = new Map<string, WorkflowNodeRunStatus>()
    workflow.nodes.forEach((node) => liveStatus.set(node.id, 'pending'))
    this.liveNodeStatus.set(workflow.id, liveStatus)

    const startedAt = new Date()
    const run: WorkflowRunV1 = {
      id: runId,
      trigger: triggerLabel,
      status: 'running',
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      message: '',
      nodeResults: []
    }
    await this.updateWorkflow(workflow.id, (current) => ({
      ...current,
      lastStatus: 'running',
      lastMessage: 'Running',
      nextRunAt: '',
      updatedAt: startedAt.toISOString(),
      runs: [...current.runs, run].slice(-MAX_WORKFLOW_RUNS)
    }))

    const settings = await this.deps.store.load()
    const adjacency = buildAdjacency(workflow.connections)
    const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
    const nodeResults: WorkflowNodeRunResultV1[] = []
    const visited = new Set<string>()
    const queue: Array<{ nodeId: string; payload: WorkflowPayload }> = [
      { nodeId: triggerNodeId, payload: { json: {}, text: '' } }
    ]
    const deadline = Date.now() + MAX_RUN_DURATION_MS
    let executions = 0
    let runStatus: WorkflowRunStatus = 'success'
    let runMessage = ''

    try {
      while (queue.length > 0) {
        if (this.cancelRequested.has(workflow.id)) {
          runStatus = 'error'
          runMessage = 'Canceled.'
          break
        }
        if (Date.now() > deadline) {
          runStatus = 'error'
          runMessage = 'Workflow exceeded the maximum run duration.'
          break
        }
        if (executions >= MAX_NODE_EXECUTIONS) {
          runStatus = 'error'
          runMessage = 'Workflow exceeded the maximum node count.'
          break
        }
        const item = queue.shift()
        if (!item) break
        if (visited.has(item.nodeId)) continue
        visited.add(item.nodeId)
        const node = nodeById.get(item.nodeId)
        if (!node) continue
        executions += 1

        if (node.disabled) {
          this.setLive(workflow.id, node.id, 'skipped')
          for (const edge of adjacency.get(node.id) ?? []) {
            queue.push({ nodeId: edge.target, payload: item.payload })
          }
          continue
        }

        this.setLive(workflow.id, node.id, 'running')
        const nodeStartedAt = new Date()
        try {
          const outcome = await this.executeNode(node, item.payload, settings)
          const result: WorkflowNodeRunResultV1 = {
            nodeId: node.id,
            status: 'success',
            startedAt: nodeStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            message: outcome.message,
            outputJson: safeJson(outcome.payload.json),
            threadId: outcome.threadId ?? '',
            error: ''
          }
          nodeResults.push(result)
          this.setLive(workflow.id, node.id, 'success')
          for (const edge of adjacency.get(node.id) ?? []) {
            if (outcome.branch !== undefined && edge.sourceHandle !== outcome.branch) continue
            queue.push({ nodeId: edge.target, payload: outcome.payload })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          nodeResults.push({
            nodeId: node.id,
            status: 'error',
            startedAt: nodeStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            message: '',
            outputJson: '',
            threadId: '',
            error: message
          })
          this.setLive(workflow.id, node.id, 'error')
          runStatus = 'error'
          runMessage = message
          break
        }
      }
    } catch (error) {
      runStatus = 'error'
      runMessage = error instanceof Error ? error.message : String(error)
      this.deps.logError('workflow', 'Workflow run failed', { message: runMessage, workflowId: workflow.id })
    } finally {
      const finishedAt = new Date()
      if (runStatus === 'success') runMessage = summarizeRun(nodeResults)
      await this.updateWorkflow(workflow.id, (current) => ({
        ...current,
        lastRunAt: finishedAt.toISOString(),
        lastStatus: runStatus,
        lastMessage: runMessage,
        nextRunAt: computeWorkflowNextRunAt(current, finishedAt),
        updatedAt: finishedAt.toISOString(),
        runs: current.runs.map((entry) =>
          entry.id === runId
            ? { ...entry, status: runStatus, finishedAt: finishedAt.toISOString(), message: runMessage, nodeResults }
            : entry
        )
      }))
      this.runningWorkflowIds.delete(workflow.id)
      this.cancelRequested.delete(workflow.id)
      setTimeout(() => this.liveNodeStatus.delete(workflow.id), LIVE_STATUS_LINGER_MS)
    }
    return { ok: runStatus !== 'error', runId, status: runStatus, message: runMessage }
  }

  private async executeNode(
    node: WorkflowNodeV1,
    payload: WorkflowPayload,
    settings: AppSettingsV1
  ): Promise<NodeOutcome> {
    switch (node.type) {
      case 'manual-trigger':
      case 'schedule-trigger':
        return { payload: { json: {}, text: '' }, message: 'Triggered' }
      case 'ai-agent': {
        const modelConfig = resolveScheduleModelConfig(
          settings,
          {
            providerId: node.config.providerId,
            model: node.config.model,
            reasoningEffort: node.config.reasoningEffort
          },
          settings.workflow.providerId?.trim() || ''
        )
        const workspace =
          node.config.workspaceRoot.trim() ||
          settings.workflow.defaultWorkspaceRoot.trim() ||
          settings.workspaceRoot
        const result = await runPromptViaRuntime(this.deps, settings, {
          prompt: interpolate(node.config.prompt, payload),
          title: `[Workflow] ${node.name || 'AI task'}`.trim(),
          workspaceRoot: workspace,
          model: modelConfig.model,
          reasoningEffort: modelConfig.reasoningEffort,
          mode: node.config.mode,
          waitForResult: true,
          responseTimeoutMs: AI_NODE_RESPONSE_TIMEOUT_MS
        })
        if (!result.ok) throw new Error(result.message)
        const text = result.text ?? ''
        return { payload: { json: { text }, text }, message: summarizeTaskResult(text), threadId: result.threadId }
      }
      case 'condition': {
        const matched = evaluateCondition(node.config, payload)
        return { payload, message: matched ? 'true' : 'false', branch: matched ? 'true' : 'false' }
      }
      case 'set-fields': {
        const base =
          node.config.keepIncoming && payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)
            ? { ...(payload.json as Record<string, unknown>) }
            : {}
        for (const field of node.config.fields) {
          if (field.key.trim()) base[field.key.trim()] = interpolate(field.value, payload)
        }
        const json = base
        return { payload: { json, text: safeJson(json) }, message: `${node.config.fields.length} fields` }
      }
      case 'http-request':
        return runHttpNode(node.config, payload)
      case 'delay':
        await sleep(node.config.delayMs)
        return { payload, message: `Waited ${node.config.delayMs}ms` }
      default:
        return { payload, message: '' }
    }
  }

  private syncPowerSaveBlocker(settings: AppSettingsV1): void {
    const shouldKeepAwake =
      settings.workflow.keepAwake && settings.workflow.enabled && hasEnabledScheduledWorkflow(settings)
    if (!shouldKeepAwake) {
      // Only release if the schedule runtime is not also keeping the app awake.
      if (!(settings.schedule.keepAwake && settings.schedule.enabled && hasEnabledScheduledTask(settings))) {
        this.stopPowerSaveBlocker()
      }
      return
    }
    if (this.isPowerSaveBlockerActive()) return
    const blocker = this.deps.powerSaveBlocker
    if (!blocker) return
    this.powerSaveBlockerId = blocker.start('prevent-app-suspension')
  }

  private stopPowerSaveBlocker(): void {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    this.powerSaveBlockerId = null
    if (!blocker || id == null) return
    try {
      if (blocker.isStarted(id)) blocker.stop(id)
    } catch (error) {
      this.deps.logError('workflow-power-save', 'Failed to stop power save blocker', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private isPowerSaveBlockerActive(): boolean {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    if (!blocker || id == null) return false
    try {
      return blocker.isStarted(id)
    } catch {
      return false
    }
  }
}

export function createWorkflowRuntime(deps: ScheduleRuntimeDeps): WorkflowRuntime {
  return new WorkflowRuntime(deps)
}
