import type { Edge, Node } from '@xyflow/react'
import { MarkerType } from '@xyflow/react'
import type {
  WorkflowConnectionV1,
  WorkflowNodeKind,
  WorkflowNodeRunStatus,
  WorkflowNodeV1,
  WorkflowV1
} from '@shared/app-settings'

export const WORKFLOW_PALETTE: readonly WorkflowNodeKind[] = [
  'manual-trigger',
  'schedule-trigger',
  'ai-agent',
  'condition',
  'set-fields',
  'http-request',
  'delay'
]

export const TRIGGER_KINDS: ReadonlySet<WorkflowNodeKind> = new Set([
  'manual-trigger',
  'schedule-trigger'
])

export type WorkflowFlowNodeData = {
  node: WorkflowNodeV1
  [key: string]: unknown
}
export type WorkflowFlowNode = Node<WorkflowFlowNodeData>
export type WorkflowFlowEdge = Edge

function uid(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  return `${prefix}-${random}`
}

export function createWorkflowNode(
  kind: WorkflowNodeKind,
  position: { x: number; y: number }
): WorkflowNodeV1 {
  const base = { id: uid('node'), name: '', position, disabled: false }
  switch (kind) {
    case 'manual-trigger':
      return { ...base, type: 'manual-trigger', config: {} }
    case 'schedule-trigger':
      return {
        ...base,
        type: 'schedule-trigger',
        config: { schedule: { kind: 'interval', everyMinutes: 60, timeOfDay: '09:00', atTime: '', cron: '' } }
      }
    case 'ai-agent':
      return {
        ...base,
        type: 'ai-agent',
        config: { prompt: '', workspaceRoot: '', providerId: '', model: '', reasoningEffort: 'medium', mode: 'agent' }
      }
    case 'condition':
      return {
        ...base,
        type: 'condition',
        config: { leftExpr: '', operator: 'contains', rightValue: '', caseSensitive: false }
      }
    case 'set-fields':
      return {
        ...base,
        type: 'set-fields',
        config: { fields: [{ key: '', value: '' }], keepIncoming: false }
      }
    case 'http-request':
      return {
        ...base,
        type: 'http-request',
        config: { method: 'GET', url: '', headers: [], body: '', timeoutMs: 30_000, parseJson: false }
      }
    case 'delay':
      return { ...base, type: 'delay', config: { delayMs: 1_000 } }
    default:
      return { ...base, type: 'manual-trigger', config: {} }
  }
}

export function createWorkflow(name: string): WorkflowV1 {
  const now = new Date().toISOString()
  const trigger = createWorkflowNode('manual-trigger', { x: 80, y: 140 })
  return {
    id: uid('workflow'),
    name,
    enabled: false,
    nodes: [trigger],
    connections: [],
    createdAt: now,
    updatedAt: now,
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: []
  }
}

const EDGE_DEFAULTS = {
  type: 'default',
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
} as const

export function toFlowNodes(nodes: WorkflowNodeV1[]): WorkflowFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: { node }
  }))
}

export function toFlowEdges(
  connections: WorkflowConnectionV1[],
  runStatus?: Record<string, WorkflowNodeRunStatus>
): WorkflowFlowEdge[] {
  return connections.map((connection) => ({
    id: connection.id,
    source: connection.source,
    sourceHandle: connection.sourceHandle || 'out',
    target: connection.target,
    targetHandle: connection.targetHandle || 'in',
    ...EDGE_DEFAULTS,
    animated: runStatus?.[connection.source] === 'running',
    className: runStatus?.[connection.source] === 'running' ? 'is-running' : undefined
  }))
}

export function flowToWorkflowGraph(
  rfNodes: WorkflowFlowNode[],
  rfEdges: WorkflowFlowEdge[]
): { nodes: WorkflowNodeV1[]; connections: WorkflowConnectionV1[] } {
  const nodes = rfNodes.map((rfNode) => ({
    ...rfNode.data.node,
    position: { x: Math.round(rfNode.position.x), y: Math.round(rfNode.position.y) }
  }))
  const connections: WorkflowConnectionV1[] = rfEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle || 'out',
    target: edge.target,
    targetHandle: edge.targetHandle || 'in'
  }))
  return { nodes, connections }
}
