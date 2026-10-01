import type { CeoMentionToken } from '../../../shared/types'

/** Preserve tokens outside the changed span. Editing a token invalidates it. Offsets use UTF-16, as Main does. */
export function updateMentionRanges(before: string, after: string, tokens: CeoMentionToken[]): CeoMentionToken[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length; let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const shift = newEnd - oldEnd
  return tokens.flatMap((token) => {
    const next = token.end <= start ? token : token.start >= oldEnd ? { ...token, start: token.start + shift, end: token.end + shift } : null
    return next && after.slice(next.start, next.end) === next.text && (next.start === 0 || !/[\p{L}\p{N}_@]/u.test(after[next.start - 1]))
      && (next.end === after.length || !/[\p{L}\p{N}_]/u.test(after[next.end])) ? [next] : []
  })
}
