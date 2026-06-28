import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import type { ExternalSyncDetectResult } from '@shared/kun-gui-api'
import { compactHomePathForSettingsDisplay } from '../lib/settings-home-paths'
import { useChatStore } from '../store/chat-store'
import { rememberCodeWorkspaceRoots } from '../store/chat-store-helpers'
import { InlineNoticeView, SettingsCard, SettingRow, type InlineNotice } from './settings-controls'

const buttonClass =
  'inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50'

type SyncContext = {
  t: (key: string, options?: Record<string, unknown>) => string
  refreshThreads: () => Promise<void> | void
  refreshKunDiagnostics: () => Promise<void> | void
}

export function SyncSettingsSection({ ctx }: { ctx: SyncContext }): ReactElement {
  const { t, refreshThreads, refreshKunDiagnostics } = ctx
  const codeWorkspaceRoots = useChatStore((s) => s.codeWorkspaceRoots)
  const [detection, setDetection] = useState<ExternalSyncDetectResult | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<InlineNotice | null>(null)
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [includeConversations, setIncludeConversations] = useState(true)
  const [includeMemories, setIncludeMemories] = useState(true)

  const refreshDetection = useCallback(async () => {
    if (typeof window.kunGui?.detectExternalSyncSources !== 'function') {
      setDetecting(false)
      return
    }
    setDetecting(true)
    try {
      setDetection(await window.kunGui.detectExternalSyncSources())
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void refreshDetection()
  }, [refreshDetection])

  useEffect(() => {
    if (!detection?.sources.length) {
      setSelectedSourceIds([])
      return
    }
    setSelectedSourceIds((current) => {
      const available = new Set(detection.sources.map((source) => source.id))
      const kept = current.filter((id) => available.has(id))
      return kept.length > 0 ? kept : detection.sources.map((source) => source.id)
    })
  }, [detection])

  const runImport = useCallback(async () => {
    if (typeof window.kunGui?.importExternalSyncSources !== 'function') return
    setBusy(true)
    setNotice(null)
    try {
      const request = {
        sourceIds: selectedSourceIds,
        includeConversations,
        includeMemories
      }
      const result = await window.kunGui.importExternalSyncSources(request)
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message })
        return
      }
      if (result.conversationsTotal === 0 && result.memoriesTotal === 0) {
        setNotice({ tone: 'info', message: t('externalSyncResultNone') })
        return
      }
      if (result.workspaceRoots.length > 0) {
        const nextWorkspaceRoots = rememberCodeWorkspaceRoots(codeWorkspaceRoots, result.workspaceRoots)
        useChatStore.setState({ codeWorkspaceRoots: nextWorkspaceRoots })
      }
      await Promise.allSettled([
        refreshDetection(),
        Promise.resolve(refreshThreads()),
        Promise.resolve(refreshKunDiagnostics())
      ])
      const warningSuffix =
        result.warnings.length > 0
          ? ` ${t('externalSyncWarnings', { count: result.warnings.length })}`
          : ''
      const workspaceSuffix =
        result.workspaceRoots.length > 0
          ? ` ${t('externalSyncProjectsAdded', { count: result.workspaceRoots.length })}`
          : ''
      setNotice({
        tone: 'success',
        message:
          t('externalSyncResult', {
            conversationsImported: result.conversationsImported,
            conversationsSkipped: result.conversationsSkipped,
            memoriesImported: result.memoriesImported,
            memoriesSkipped: result.memoriesSkipped
          }) + workspaceSuffix + warningSuffix
      })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [
    codeWorkspaceRoots,
    includeConversations,
    includeMemories,
    refreshDetection,
    refreshKunDiagnostics,
    refreshThreads,
    selectedSourceIds,
    t
  ])

  const selectedSources = detection?.sources.filter((source) => selectedSourceIds.includes(source.id)) ?? []
  const totalConversations = includeConversations
    ? selectedSources.reduce((total, source) => total + source.conversationCount, 0)
    : 0
  const totalNewConversations = includeConversations
    ? selectedSources.reduce((total, source) => total + source.newConversationCount, 0)
    : 0
  const totalMemories = includeMemories
    ? selectedSources.reduce((total, source) => total + source.memoryCount, 0)
    : 0
  const totalNewMemories = includeMemories
    ? selectedSources.reduce((total, source) => total + source.newMemoryCount, 0)
    : 0
  const canImport =
    selectedSourceIds.length > 0 &&
    (includeConversations || includeMemories) &&
    (totalNewConversations > 0 || totalNewMemories > 0)

  const statusText = detecting
    ? t('externalSyncScanning')
    : totalNewConversations > 0 || totalNewMemories > 0
      ? t('externalSyncFound', {
          conversations: totalNewConversations,
          memories: totalNewMemories
        })
      : totalConversations > 0 || totalMemories > 0
        ? t('externalSyncAllPresent')
        : t('externalSyncNoneFound')

  return (
    <>
      <SettingsCard title={t('externalSyncTitle')}>
        <SettingRow
          title={t('externalSyncOverview')}
          description={t('externalSyncDesc')}
          wideControl
          control={
            <div className="flex w-full min-w-0 flex-col items-start gap-3">
              <div className="rounded-xl border border-emerald-300/70 bg-emerald-50/70 px-3 py-2 text-[12px] leading-5 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                {t('externalSyncCopyOnly')}
              </div>

              <div className="grid w-full gap-3 rounded-xl border border-ds-border-muted bg-ds-main/35 px-3 py-3">
                <div className="text-[12px] font-medium text-ds-muted">{t('externalSyncChoose')}</div>
                <div className="flex flex-wrap gap-3">
                  <label className="inline-flex items-center gap-2 text-[13px] text-ds-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-ds-border"
                      checked={includeConversations}
                      onChange={(event) => setIncludeConversations(event.target.checked)}
                    />
                    <span>{t('externalSyncToggleConversations')}</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-[13px] text-ds-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-ds-border"
                      checked={includeMemories}
                      onChange={(event) => setIncludeMemories(event.target.checked)}
                    />
                    <span>{t('externalSyncToggleMemories')}</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[13px] text-ds-muted">
                {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{statusText}</span>
              </div>

              {detection?.sources.length ? (
                <ul className="w-full space-y-2">
                  {detection.sources.map((source) => (
                    <li
                      key={source.id}
                      className="flex flex-col gap-1 rounded-xl border border-ds-border-muted bg-ds-main/35 px-3 py-2 text-[12px] text-ds-faint"
                    >
                      <div className="flex items-start gap-3">
                        <label className="mt-0.5 inline-flex items-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-ds-border"
                            checked={selectedSourceIds.includes(source.id)}
                            onChange={(event) => {
                              setSelectedSourceIds((current) =>
                                event.target.checked
                                  ? [...new Set([...current, source.id])]
                                  : current.filter((id) => id !== source.id)
                              )
                            }}
                          />
                        </label>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium text-ds-muted">{t(`externalSyncSource_${source.kind}`)}</span>
                            <span>
                              {t('externalSyncSourceCount', {
                                newConversations: source.newConversationCount,
                                totalConversations: source.conversationCount,
                                newMemories: source.newMemoryCount,
                                totalMemories: source.memoryCount
                              })}
                            </span>
                          </div>
                          <code className="break-all font-mono">{compactHomePathForSettingsDisplay(source.path)}</code>
                          {source.note ? <span>{source.note}</span> : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}

              {detection?.unsupported.length ? (
                <div className="w-full rounded-xl border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                  {detection.unsupported.map((entry) => `${entry.kind}: ${entry.note}`).join(' ')}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || detecting || !canImport}
                  onClick={() => void runImport()}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {t('externalSyncButton')}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void refreshDetection()}
                >
                  <RefreshCw className={`h-4 w-4 ${detecting ? 'animate-spin' : ''}`} />
                  {t('refresh')}
                </button>
              </div>

              {notice ? <InlineNoticeView notice={notice} /> : null}
            </div>
          }
        />
      </SettingsCard>
    </>
  )
}
