function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function dirnamePortable(filePath: string): string {
  const normalized = normalizePath(filePath)
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return ''
  if (slash === 0) return '/'
  return normalized.slice(0, slash)
}

function normalizeJoinedPath(pathname: string): string {
  const normalized = normalizePath(pathname)
  const prefix = normalized.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of normalized.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }
  return `${prefix}${parts.join('/')}`
}

function pathToFileUrl(pathname: string): string {
  const normalized = normalizeJoinedPath(pathname)
  const encoded = normalized
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `file://${encoded.startsWith('/') ? encoded : `/${encoded}`}`
}

export function isExplicitWriteResourceUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

export function resolveWriteMarkdownResource(
  src: string | undefined,
  filePath?: string | null
): string | undefined {
  if (!src?.trim() || !filePath) return src
  const value = src.trim()
  if (isExplicitWriteResourceUrl(value) || value.startsWith('#')) return src
  const [pathname, suffix = ''] = value.split(/([?#].*)/, 2)
  const baseDir = dirnamePortable(filePath)
  if (!baseDir) return src
  const resolved = pathname.startsWith('/')
    ? normalizeJoinedPath(pathname)
    : normalizeJoinedPath(`${baseDir}/${pathname}`)
  return `${pathToFileUrl(resolved)}${suffix}`
}
