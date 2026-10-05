import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Message text stays untrusted: no raw HTML or automatic remote image requests.
export const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{content}</Markdown>
})
