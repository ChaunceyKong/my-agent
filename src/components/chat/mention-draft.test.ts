import { expect, it } from 'vitest'
import { updateMentionRanges } from './mention-draft'
const token = { agentId: 'a', start: 3, end: 7, text: '@规划师' }
it('keeps UTF-16 token ranges when inserting text before and after an intact mention', () => {
  expect(updateMentionRanges('😀 @规划师 完成', '先 😀 @规划师 完成', [token])).toEqual([{ ...token, start: 5, end: 9 }])
  expect(updateMentionRanges('😀 @规划师 完成', '😀 @规划师 完成任务', [token])).toEqual([token])
})
it('invalidates edited, removed and boundary-merged tokens instead of retargeting a typed name', () => {
  for (const text of ['😀 @策划师 完成', '😀 完成', '😀 @规划师补充 完成']) expect(updateMentionRanges('😀 @规划师 完成', text, [token])).toEqual([])
})
