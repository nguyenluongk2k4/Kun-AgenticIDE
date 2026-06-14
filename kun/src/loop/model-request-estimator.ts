import type { TurnItem } from '../contracts/items.js'
import type { ModelRequest, ModelTextAttachmentFallback, ModelToolSpec } from '../ports/model-client.js'
import { ContextEstimator } from './context-estimator.js'

const CHARS_PER_TOKEN = 4

const estimator = new ContextEstimator(CHARS_PER_TOKEN)

export function estimateModelRequestInputTokens(request: ModelRequest): number {
  let tokens = 0
  tokens += estimateText(request.systemPrompt)
  tokens += estimateText(request.modeInstruction)
  tokens += estimateText(request.contextInstructions?.join('\n'))
  tokens += estimateItems(request.prefix)
  tokens += estimateItems(request.history)
  tokens += estimateTools(request.tools)
  tokens += estimateTextFallbacks(request.attachmentTextFallbacks)
  tokens += estimateText(request.requiredToolName)
  tokens += estimateText(request.reasoningEffort)
  return Math.max(0, tokens)
}

/**
 * Estimate the per-request token overhead that is sent on *every* turn
 * but is not part of the stored conversation items: the system prompt,
 * the few-shot prefix, the mode/context instructions, and the full tool
 * schemas. The item-only {@link ContextEstimator} ignores all of this,
 * which makes compaction under-trigger when no provider usage count is
 * available (e.g. the first turn after a process restart). Compaction
 * adds this overhead to its history estimate as a safety floor.
 */
export function estimateRequestOverheadTokens(input: {
  systemPrompt?: string
  modeInstruction?: string
  contextInstructions?: string[]
  prefix?: TurnItem[]
  tools?: readonly ModelToolSpec[]
}): number {
  let tokens = 0
  tokens += estimateText(input.systemPrompt)
  tokens += estimateText(input.modeInstruction)
  tokens += estimateText(input.contextInstructions?.join('\n'))
  tokens += estimateItems(input.prefix)
  tokens += estimateTools(input.tools)
  return Math.max(0, tokens)
}

function estimateItems(items?: TurnItem[]): number {
  return items && items.length > 0 ? estimator.estimateItems(items) : 0
}

function estimateTools(tools?: readonly ModelToolSpec[]): number {
  if (!tools?.length) return 0
  return tools.reduce((sum, tool) => {
    return sum + estimateText([
      tool.name,
      tool.description,
      JSON.stringify(tool.inputSchema)
    ].join('\n'))
  }, 0)
}

function estimateTextFallbacks(fallbacks?: ModelTextAttachmentFallback[]): number {
  if (!fallbacks?.length) return 0
  return fallbacks.reduce((sum, attachment) => {
    return sum + estimateText([
      attachment.name,
      attachment.mimeType,
      String(attachment.byteSize),
      attachment.dataBase64
    ].join('\n'))
  }, 0)
}

function estimateText(text?: string): number {
  if (!text?.trim()) return 0
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}
