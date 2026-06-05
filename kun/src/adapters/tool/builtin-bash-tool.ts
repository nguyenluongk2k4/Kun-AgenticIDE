import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { OutputAccumulator } from './output-accumulator.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from './truncate.js'
import type { BashLocalToolOptions, TextSlice, TruncateMode } from './builtin-tool-types.js'
import { DEFAULT_BASH_TIMEOUT_SECONDS } from './builtin-tool-types.js'
import { createLocalBashOperations } from './builtin-tool-operations.js'
import {
  describeKind,
  normalizePositiveInteger,
  shellRuntimeInfo,
  withToolBoundary,
  workspaceRoot
} from './builtin-tool-utils.js'

async function bashExecute(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutSeconds: number,
  onUpdate?: (update: { output: unknown; isError?: boolean }) => Promise<void> | void,
  execOperation?: (
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutSeconds: number; onData?: (data: Buffer) => void }
  ) => Promise<{ exitCode: number | null; shell?: string }>
): Promise<{
  output: string
  exitCode: number | null
  shell: string
  truncated: TextSlice
  fullOutputPath?: string
}> {
  await mkdir(cwd, { recursive: true })
  const shellRuntime = shellRuntimeInfo()
  let resultShell = shellRuntime.name
  const child = execOperation
    ? null
    : (() => {
        return spawn(shellRuntime.shell, [...shellRuntime.args, command], {
          cwd,
          env: process.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      })()
  let timedOut = false
  let settled = false
  const output = new OutputAccumulator({
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    tempFilePrefix: 'kun-bash'
  })
  let updateDirty = false
  let updateTimer: NodeJS.Timeout | undefined
  let lastUpdateAt = 0
  const handleData = (chunk: Buffer) => {
    output.append(chunk)
    scheduleUpdate()
  }
  const emitUpdate = async () => {
    if (!onUpdate || !updateDirty) return
    updateDirty = false
    lastUpdateAt = Date.now()
    const snapshot = output.snapshot({ persistIfTruncated: true })
    await onUpdate({
      output: {
        command,
        cwd,
        shell: resultShell,
        exit_code: null,
        output: snapshot.content,
        full_output_path: snapshot.fullOutputPath ?? null,
        truncation: snapshot.truncation.truncated
          ? {
              total_lines: snapshot.truncation.totalLines,
              output_lines: snapshot.truncation.outputLines,
              total_bytes: snapshot.truncation.totalBytes,
              output_bytes: snapshot.truncation.outputBytes,
              truncated_by: snapshot.truncation.truncatedBy ?? null,
              last_line_partial: snapshot.truncation.lastLinePartial === true
            }
          : null,
        partial: true
      }
    })
  }
  const scheduleUpdate = () => {
    if (!onUpdate) return
    updateDirty = true
    const delay = 100 - (Date.now() - lastUpdateAt)
    if (delay <= 0) {
      void emitUpdate()
      return
    }
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void emitUpdate()
    }, delay)
  }
  const kill = () => {
    if (settled) return
    if (!child) return
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM')
        return
      } catch {
        // Fall through to direct kill.
      }
    }
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutSeconds * 1000)
  const onAbort = () => kill()
  let exitCode: number | null
  if (execOperation) {
    try {
      const result = await execOperation(command, cwd, {
        signal,
        timeoutSeconds,
        onData: handleData
      })
      exitCode = result.exitCode
      resultShell = result.shell ?? resultShell
    } finally {
      settled = true
      clearTimeout(timer)
      if (updateTimer) clearTimeout(updateTimer)
    }
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
    child?.stdout?.on('data', (chunk: Buffer | string) => {
      handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child?.stderr?.on('data', (chunk: Buffer | string) => {
      handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child?.once('error', rejectPromise)
      child?.once('close', (code) => resolvePromise(code))
    }).finally(() => {
      settled = true
      clearTimeout(timer)
      if (updateTimer) clearTimeout(updateTimer)
      signal.removeEventListener('abort', onAbort)
    })
  }

  if (signal.aborted) {
    throw new Error('command aborted')
  }
  if (timedOut) {
    throw new Error(`command timed out after ${timeoutSeconds} seconds`)
  }

  output.finish()
  await emitUpdate()
  const snapshot = output.snapshot({ persistIfTruncated: true })
  await output.closeTempFile()
  const truncated: TextSlice = {
    text: snapshot.content,
    truncated: snapshot.truncation.truncated,
    totalLines: snapshot.truncation.totalLines,
    shownLines: snapshot.truncation.outputLines,
    totalBytes: snapshot.truncation.totalBytes,
    shownBytes: snapshot.truncation.outputBytes,
    firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
    truncatedBy: snapshot.truncation.truncatedBy ?? undefined,
    lastLinePartial: snapshot.truncation.lastLinePartial
  }
  return {
    output: snapshot.content,
    exitCode,
    shell: resultShell,
    truncated,
    fullOutputPath: snapshot.fullOutputPath
  }
}

function appendTruncationNotice(text: string, truncated: TextSlice, mode: TruncateMode): string {
  if (!truncated.truncated) return text
  const prefix = text.trimEnd()
  const notice = truncated.firstLineExceedsLimit
    ? `[first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}; refine the read range or use bash for a byte-limited slice]`
    : `[truncated: showing ${describeKind(mode)} ${truncated.shownLines} of ${truncated.totalLines} lines, ${truncated.shownBytes} of ${truncated.totalBytes} bytes]`
  return prefix ? `${prefix}\n\n${notice}` : notice
}

export function createBashLocalTool(options: BashLocalToolOptions = {}): LocalTool {
  const bashOps = options.operations ?? createLocalBashOperations()
  const shellRuntime = shellRuntimeInfo()
  return LocalToolHost.defineTool({
    name: 'bash',
    description: `Execute a shell command in the workspace using the host platform shell. Current shell: ${shellRuntime.name}. Use ${shellRuntime.syntax} syntax. Return the combined stdout and stderr output.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' }
      },
      required: ['command'],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'command_execution',
    execute: async (args, context, onUpdate) => withToolBoundary(async () => {
      const command = typeof args.command === 'string' ? args.command : ''
      if (!command.trim()) return { output: { error: 'command is required' }, isError: true }
      const timeout = normalizePositiveInteger(
        args.timeout,
        options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS
      )
      const cwd = workspaceRoot(context.workspace)
      try {
        const result = await bashExecute(
          command,
          cwd,
          context.abortSignal,
          timeout,
          onUpdate,
          bashOps.exec
        )
        const content = appendTruncationNotice(result.output, result.truncated, 'tail')
        if (result.exitCode && result.exitCode !== 0) {
          return {
            output: {
              command,
              cwd,
              shell: result.shell,
              exit_code: result.exitCode,
              output: content,
              full_output_path: result.fullOutputPath ?? null,
              truncation: result.truncated.truncated
                ? {
                    total_lines: result.truncated.totalLines,
                    output_lines: result.truncated.shownLines,
                    total_bytes: result.truncated.totalBytes,
                    output_bytes: result.truncated.shownBytes,
                    truncated_by: result.truncated.truncatedBy ?? null,
                    last_line_partial: result.truncated.lastLinePartial === true
                  }
                : null
            },
            isError: true
          }
        }
        return {
          output: {
            command,
            cwd,
            shell: result.shell,
            exit_code: result.exitCode ?? 0,
            output: content,
            full_output_path: result.fullOutputPath ?? null,
            truncation: result.truncated.truncated
              ? {
                  total_lines: result.truncated.totalLines,
                  output_lines: result.truncated.shownLines,
                  total_bytes: result.truncated.totalBytes,
                  output_bytes: result.truncated.shownBytes,
                  truncated_by: result.truncated.truncatedBy ?? null,
                  last_line_partial: result.truncated.lastLinePartial === true
                }
              : null
          }
        }
      } catch (error) {
        return {
          output: {
            command,
            cwd,
            error: error instanceof Error ? error.message : String(error)
          },
          isError: true
        }
      }
    })
  })
}

export const createBashTool = createBashLocalTool
export const createBashToolDefinition = createBashLocalTool
