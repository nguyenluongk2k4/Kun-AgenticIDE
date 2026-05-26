import type { WorkspaceEntry } from './workspace-file'

export const WRITE_TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text'
])

export function isWriteTextFileExtension(ext: string): boolean {
  return WRITE_TEXT_FILE_EXTENSIONS.has(ext.trim().toLowerCase())
}

export function isWriteTextFilePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  const dot = normalized.lastIndexOf('.')
  if (dot < 0) return false
  const slash = normalized.lastIndexOf('/')
  if (dot < slash) return false
  return isWriteTextFileExtension(normalized.slice(dot))
}

export function isWriteWorkspaceEntry(entry: WorkspaceEntry): boolean {
  return entry.type === 'directory' || isWriteTextFileExtension(entry.ext)
}
