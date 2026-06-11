'use client';
import ReactMarkdown from 'react-markdown';

// Agent replies are markdown-ish (code blocks, lists, links). react-markdown does not
// render raw HTML by default, so agent-controlled content cannot inject markup.
export function Markdown({ text }: { text: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}
    >
      {text}
    </ReactMarkdown>
  </div>;
}
