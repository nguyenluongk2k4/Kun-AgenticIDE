#!/usr/bin/env node
/**
 * Build GitHub release notes from conventional commits since the previous tag.
 *
 * Usage:
 *   node scripts/generate-release-notes.cjs [sinceTag]
 *   node scripts/generate-release-notes.cjs v0.1.0.8
 *
 * If sinceTag is omitted, uses the newest v* tag on origin (excluding HEAD).
 */

const { execFileSync } = require('node:child_process')

const CONVENTIONAL =
  /^(feat|fix|perf|refactor|docs|chore|test|build|ci)(\([\w./-]+\))?!?:\s*(.+)$/i

const GROUPS = [
  { key: 'feat', heading: '### âœ¨ æ–°åŠŸèƒ½' },
  { key: 'fix', heading: '### ðŸ› ä¿®å¤' },
  { key: 'perf', heading: '### âš¡ æ€§èƒ½' },
  { key: 'refactor', heading: '### â™»ï¸ é‡æž„' },
  { key: 'docs', heading: '### ðŸ“ æ–‡æ¡£' },
  { key: 'other', heading: '### ðŸ“¦ å…¶ä»–' }
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim()
}

function normalizeGithubOwnerRepo(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const stripped = value.startsWith('github:') ? value.slice('github:'.length).trim() : value
  const ssh = stripped.match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)
  if (ssh?.[1]) return ssh[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const https = stripped.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:$|[#/])/i)
  if (https?.[1]) return https[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  return /^[\w.-]+\/[\w.-]+$/.test(stripped) ? stripped : ''
}

function resolveGithubRepo() {
  const envRepo = normalizeGithubOwnerRepo(process.env.KUN_GITHUB_REPO || process.env.DEEPSEEK_GUI_GITHUB_REPO || '')
  if (envRepo) return envRepo
  try {
    return normalizeGithubOwnerRepo(git(['remote', 'get-url', 'origin'])) || 'KunAgent/Kun'
  } catch {
    return 'KunAgent/Kun'
  }
}

function resolveSinceTag(arg) {
  const input = (arg || '').trim()
  if (input) {
    return input.startsWith('v') ? input : `v${input}`
  }

  const lines = git([
    'tag',
    '--list',
    'v*',
    '--sort=-version:refname'
  ])
    .split('\n')
    .filter(Boolean)

  if (lines.length === 0) return null
  return lines[0]
}

function formatCommitLine(hash, subject) {
  const short = hash.slice(0, 7)
  const match = subject.match(CONVENTIONAL)
  if (!match) {
    return { type: 'other', line: `- ${subject} (\`${short}\`)` }
  }

  const type = match[1].toLowerCase()
  const scope = match[2] ? match[2].slice(1, -1) : ''
  const description = match[3].trim()
  const scopePrefix = scope ? `**${scope}**: ` : ''
  const bucket = ['feat', 'fix', 'perf', 'refactor', 'docs'].includes(type)
    ? type
    : ['chore', 'test', 'build', 'ci'].includes(type)
      ? 'other'
      : 'other'

  return {
    type: bucket,
    line: `- ${scopePrefix}${description} (\`${short}\`)`
  }
}

function main() {
  const githubRepo = resolveGithubRepo()
  const sinceTag = resolveSinceTag(process.argv[2])
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD'
  const count = git(['rev-list', '--count', range])
  if (count === '0') {
    console.log('## æ›´æ–°æ‘˜è¦\n\nï¼ˆè‡ªä¸Šä¸€ç‰ˆæœ¬ä»¥æ¥æ²¡æœ‰æ–°çš„ commitï¼‰\n')
    return
  }

  const log = git([
    'log',
    range,
    '--pretty=format:%H%x09%s',
    '--no-merges',
    '--reverse'
  ])

  const buckets = Object.fromEntries(GROUPS.map((g) => [g.key, []]))

  for (const row of log.split('\n').filter(Boolean)) {
    const tab = row.indexOf('\t')
    if (tab === -1) continue
    const hash = row.slice(0, tab)
    const subject = row.slice(tab + 1)
    const { type, line } = formatCommitLine(hash, subject)
    buckets[type].push(line)
  }

  const out = ['## æ›´æ–°æ‘˜è¦', '']
  if (sinceTag) {
    out.push(`è‡ª [\`${sinceTag}\`](https://github.com/${githubRepo}/compare/${sinceTag}...HEAD) ä»¥æ¥çš„å˜æ›´ï¼š`, '')
  }

  let wroteSection = false
  for (const group of GROUPS) {
    const items = buckets[group.key]
    if (!items.length) continue
    wroteSection = true
    out.push(group.heading, '', ...items, '')
  }

  if (!wroteSection) {
    out.push('ï¼ˆæš‚æ— ç¬¦åˆ Conventional Commits è§„èŒƒçš„æäº¤ï¼Œè§ä¸‹æ–¹å®Œæ•´ commit åˆ—è¡¨ï¼‰', '')
    for (const row of log.split('\n').filter(Boolean)) {
      const subject = row.slice(row.indexOf('\t') + 1)
      out.push(`- ${subject}`)
    }
    out.push('')
  }

  process.stdout.write(`${out.join('\n').trimEnd()}\n`)
}

main()

