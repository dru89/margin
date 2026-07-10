import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '@/store';

export function Preview() {
  const content = useStore((s) => s.content);
  return (
    <div className="preview-pane">
      <article className="preview-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    </div>
  );
}
