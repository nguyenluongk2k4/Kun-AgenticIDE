import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  dialog: {
    showSaveDialog: vi.fn()
  }
}))

import {
  buildWriteExportFileName,
  buildWriteExportHtmlDocument
} from './write-export-service'

describe('write-export-service helpers', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-export-'))
  })

  it('builds export file names with the requested extension', () => {
    expect(buildWriteExportFileName('/tmp/draft.md', 'html')).toBe('draft.html')
    expect(buildWriteExportFileName('/tmp/draft.md', 'pdf')).toBe('draft.pdf')
    expect(buildWriteExportFileName('/tmp/draft.md', 'doc')).toBe('draft.doc')
    expect(buildWriteExportFileName('/tmp/draft.md', 'docx')).toBe('draft.docx')
  })

  it('renders markdown exports with resolved links and inlined local images', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const html = await buildWriteExportHtmlDocument({
      sourcePath,
      content: '# Heading\n\n![Cover](./cover.png)\n\n[Notes](./notes.md)'
    })

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain(`href="${pathToFileURL(join(workspaceRoot, 'notes.md')).href}"`)
  })
})
