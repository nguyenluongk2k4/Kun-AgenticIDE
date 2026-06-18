import type { ComponentType, ReactElement } from 'react'
import { createContext, useContext } from 'react'
import { Handle, NodeToolbar, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import {
  Braces,
  Brain,
  CalendarClock,
  GitBranch,
  Globe,
  Hand,
  Play,
  Power,
  Timer,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type { WorkflowNodeKind, WorkflowNodeRunStatus, WorkflowNodeV1 } from '@shared/app-settings'
import type { WorkflowFlowNodeData } from './workflow-types'

/** workflowId-scoped live node status, provided by the editor and read by each node. */
export const WorkflowRunStatusContext = createContext<Record<string, WorkflowNodeRunStatus>>({})

export type WorkflowNodeActions = {
  runNode: (nodeId: string) => void
  toggleDisabled: (nodeId: string) => void
  deleteNode: (nodeId: string) => void
}

export const WorkflowNodeActionsContext = createContext<WorkflowNodeActions>({
  runNode: () => {},
  toggleDisabled: () => {},
  deleteNode: () => {}
})

export const NODE_ICONS: Record<WorkflowNodeKind, LucideIcon> = {
  'manual-trigger': Hand,
  'schedule-trigger': CalendarClock,
  'ai-agent': Brain,
  condition: GitBranch,
  'set-fields': Braces,
  'http-request': Globe,
  delay: Timer
}

function statusDotClass(status: WorkflowNodeRunStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'bg-amber-500 animate-pulse'
    case 'success':
      return 'bg-emerald-500'
    case 'error':
      return 'bg-red-500'
    case 'skipped':
      return 'bg-ds-border'
    default:
      return 'bg-transparent'
  }
}

function nodeSummary(node: WorkflowNodeV1): string {
  switch (node.type) {
    case 'schedule-trigger': {
      const s = node.config.schedule
      if (s.kind === 'cron') return s.cron || 'cron'
      if (s.kind === 'interval') return `${s.everyMinutes}m`
      if (s.kind === 'daily') return s.timeOfDay
      if (s.kind === 'at') return s.atTime ? new Date(s.atTime).toLocaleString() : 'once'
      return 'manual'
    }
    case 'ai-agent':
      return node.config.prompt.trim().slice(0, 60) || node.config.model || 'AI task'
    case 'condition':
      return `${node.config.leftExpr || 'text'} ${node.config.operator} ${node.config.rightValue}`.trim()
    case 'set-fields':
      return node.config.fields.map((field) => field.key).filter(Boolean).join(', ')
    case 'http-request':
      return `${node.config.method} ${node.config.url}`.trim()
    case 'delay':
      return `${Math.round(node.config.delayMs / 1000)}s`
    default:
      return ''
  }
}

const TOOLBAR_BTN =
  'nodrag nopan flex h-7 w-7 items-center justify-center rounded-md text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink'

function WorkflowCanvasNode({ id, data, selected }: NodeProps): ReactElement {
  const { t } = useTranslation('common')
  const runStatus = useContext(WorkflowRunStatusContext)
  const actions = useContext(WorkflowNodeActionsContext)
  const node = (data as WorkflowFlowNodeData).node
  const Icon = NODE_ICONS[node.type]
  const status = runStatus[id]
  const isTrigger = node.type === 'manual-trigger' || node.type === 'schedule-trigger'
  const isCondition = node.type === 'condition'
  const summary = nodeSummary(node)

  const ring = selected ? 'border-accent ring-2 ring-accent/30' : 'border-ds-border'
  const disabled = node.disabled ? 'opacity-50' : ''

  return (
    <div
      className={`relative w-[210px] rounded-xl border bg-ds-card px-3 py-2.5 shadow-sm ${ring} ${disabled}`}
    >
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-0.5 rounded-lg border border-ds-border bg-ds-card p-1 shadow-md">
          {!isTrigger ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              title={t('workflowRunNode')}
              aria-label={t('workflowRunNode')}
              onClick={() => actions.runNode(id)}
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
          ) : null}
          <button
            type="button"
            className={TOOLBAR_BTN}
            title={node.disabled ? t('workflowEnableNode') : t('workflowDisableNode')}
            aria-label={node.disabled ? t('workflowEnableNode') : t('workflowDisableNode')}
            onClick={() => actions.toggleDisabled(id)}
          >
            <Power className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={`${TOOLBAR_BTN} hover:bg-red-500/10 hover:text-red-600`}
            title={t('workflowDeleteNode')}
            aria-label={t('workflowDeleteNode')}
            onClick={() => actions.deleteNode(id)}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
        </div>
      </NodeToolbar>

      {!isTrigger ? (
        <Handle type="target" position={Position.Left} id="in" />
      ) : null}

      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ds-ink">
            {node.name.trim() || t(`workflowNode_${node.type}`)}
          </div>
          {summary ? (
            <div className="truncate text-[11px] text-ds-faint">{summary}</div>
          ) : null}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)}`} />
      </div>

      {isCondition ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: '38%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: '70%' }}
          />
          <div className="pointer-events-none absolute right-1 top-[30%] text-[9px] font-medium text-emerald-600">
            {t('workflowConditionTrue')}
          </div>
          <div className="pointer-events-none absolute right-1 top-[62%] text-[9px] font-medium text-red-500">
            {t('workflowConditionFalse')}
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" />
      )}
    </div>
  )
}

const sharedNode = WorkflowCanvasNode as ComponentType<NodeProps>

export const workflowNodeTypes: NodeTypes = {
  'manual-trigger': sharedNode,
  'schedule-trigger': sharedNode,
  'ai-agent': sharedNode,
  condition: sharedNode,
  'set-fields': sharedNode,
  'http-request': sharedNode,
  delay: sharedNode
}
