import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWorkflowSettings,
  defaultWriteSettings,
  mergeWorkflowSettings,
  normalizeWorkflow,
  normalizeWorkflowSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type WorkflowRunResult,
  type WorkflowV1
} from '../shared/app-settings'
import { createWorkflowRuntime } from './workflow-runtime'

function settingsWithWorkflows(workflows: WorkflowV1[]): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: { kun: { ...defaultKunRuntimeSettings(), model: 'test-model', apiKey: 'test-key' } },
    workspaceRoot: '/tmp/workflow-workspace',
    log: { enabled: true, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    workflow: normalizeWorkflowSettings({ enabled: true, workflows }),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: '',
    disabledSkillIds: []
  }
}

function createStore(initial: AppSettingsV1) {
  let current = initial
  return {
    load: async () => current,
    patch: async (partial: AppSettingsPatch) => {
      current = { ...current, workflow: mergeWorkflowSettings(current.workflow, partial.workflow) }
      return current
    },
    read: () => current
  }
}

function buildWorkflow(partial: Partial<WorkflowV1>): WorkflowV1 {
  return normalizeWorkflow(partial, 0, '2026-06-18T00:00:00.000Z')
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out waiting for workflow run to finish')
}

function requireOk(result: WorkflowRunResult): string {
  if (!result.ok) throw new Error(`runWorkflow failed: ${result.message}`)
  return result.runId
}

describe('WorkflowRuntime end-to-end execution', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs trigger → AI → condition(true) → delay and skips the false branch', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thread-1' }) }
      }
      if (pathAndQuery.includes('/turns')) {
        return { ok: true, status: 200, body: JSON.stringify({ turn: { id: 'turn-1' } }) }
      }
      if (pathAndQuery.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'HELLO WORLD', turnId: 'turn-1' }]
              }
            ]
          })
        }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-1',
      name: 'Demo',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'say hi', model: 'test-model' } },
        { id: 'c', type: 'condition', config: { leftExpr: '', operator: 'contains', rightValue: 'HELL' } },
        { id: 'd', type: 'delay', config: { delayMs: 10 } },
        { id: 'h', type: 'http-request', config: { method: 'GET', url: 'https://example.com' } }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
        { id: 'e3', source: 'c', sourceHandle: 'true', target: 'd', targetHandle: 'in' },
        { id: 'e4', source: 'c', sourceHandle: 'false', target: 'h', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-1'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 15_000)

    const persisted = store.read().workflow.workflows[0]
    const run = persisted.runs.find((entry) => entry.id === runId)!
    const ranIds = run.nodeResults.map((result) => result.nodeId)

    expect(run.status).toBe('success')
    expect(persisted.lastStatus).toBe('success')
    expect(ranIds).toEqual(expect.arrayContaining(['m', 'a', 'c', 'd']))
    expect(ranIds).not.toContain('h') // false branch must be skipped

    const aiResult = run.nodeResults.find((result) => result.nodeId === 'a')!
    expect(aiResult.status).toBe('success')
    expect(aiResult.message).toContain('HELLO WORLD')
    expect(aiResult.threadId).toBe('thread-1')

    const conditionResult = run.nodeResults.find((result) => result.nodeId === 'c')!
    expect(conditionResult.message).toBe('true')

    runtime.stop()
  }, 20_000)

  it('executes an HTTP request node and captures the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"value":42}', { status: 200, statusText: 'OK' }))
    )

    const workflow = buildWorkflow({
      id: 'wf-http',
      name: 'Http',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        {
          id: 'h',
          type: 'http-request',
          config: { method: 'GET', url: 'https://example.com/data', parseJson: true }
        }
      ],
      connections: [{ id: 'e1', source: 'm', sourceHandle: 'out', target: 'h', targetHandle: 'in' }]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-http'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    const httpResult = run.nodeResults.find((result) => result.nodeId === 'h')!
    expect(run.status).toBe('success')
    expect(httpResult.status).toBe('success')
    expect(httpResult.message).toContain('200')
    expect(httpResult.outputJson).toContain('42')

    runtime.stop()
  }, 15_000)

  it('marks the run as error when a node fails and stops the chain', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') {
        return { ok: false, status: 500, body: JSON.stringify({ message: 'boom' }) }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-err',
      name: 'Err',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'fail', model: 'test-model' } },
        { id: 'd', type: 'delay', config: { delayMs: 10 } }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 'd', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-err'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const persisted = store.read().workflow.workflows[0]
    const run = persisted.runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('error')
    expect(persisted.lastStatus).toBe('error')
    const aiResult = run.nodeResults.find((result) => result.nodeId === 'a')!
    expect(aiResult.status).toBe('error')
    expect(aiResult.error).toContain('boom')
    // The downstream delay node must not have run.
    expect(run.nodeResults.find((result) => result.nodeId === 'd')).toBeUndefined()

    runtime.stop()
  }, 15_000)

  it('set-fields node shapes JSON and interpolates the upstream output', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thread-1' }) }
      if (pathAndQuery.includes('/turns')) return { ok: true, status: 200, body: JSON.stringify({ turn: { id: 'turn-1' } }) }
      if (pathAndQuery.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            turns: [{ id: 'turn-1', status: 'completed', items: [{ kind: 'assistant_text', text: 'WORLD', turnId: 'turn-1' }] }]
          })
        }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-set',
      name: 'Set',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'hi', model: 'test-model' } },
        {
          id: 's',
          type: 'set-fields',
          config: { fields: [{ key: 'greeting', value: 'hello {{text}}' }, { key: 'fixed', value: 'x' }], keepIncoming: false }
        }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 's', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-set'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const setResult = run.nodeResults.find((result) => result.nodeId === 's')!
    const output = JSON.parse(setResult.outputJson) as Record<string, unknown>
    expect(output).toEqual({ greeting: 'hello WORLD', fixed: 'x' })

    runtime.stop()
  }, 15_000)
})
