import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Compact markdown rendering for sidebar text (agent replies are markdown). */
export function Md({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
