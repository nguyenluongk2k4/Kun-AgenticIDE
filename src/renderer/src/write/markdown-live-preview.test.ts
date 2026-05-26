import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownLivePreviewTestInternals } from './markdown-live-preview'

describe('markdown live preview', () => {
  it('does not treat a visible closing fence as a new code block opener', () => {
    const state = EditorState.create({
      doc: [
        '```python',
        'python("hello world")',
        '```',
        '',
        '呀',
        'nihao'
      ].join('\n')
    })
    const closingFence = state.doc.line(3)

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      closingFence.from,
      state.doc.length,
      new Set()
    )

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toMatchObject({
      from: state.doc.line(1).from,
      to: closingFence.to,
      block: {
        language: 'python',
        code: 'python("hello world")'
      }
    })
  })

  it('does not leak code block ranges into following prose', () => {
    const state = EditorState.create({
      doc: [
        '```python',
        'python("hello world")',
        '```',
        '',
        '呀',
        'nihao'
      ].join('\n')
    })
    const proseLine = state.doc.line(5)

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      proseLine.from,
      state.doc.length,
      new Set()
    )

    expect(ranges).toHaveLength(0)
  })
})
