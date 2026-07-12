import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '@/store';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  onEscape?: () => void;
}

interface Completion {
  label: string;
  insert: string;
}

/**
 * Textarea with lightweight completions: `@` completes workspace file paths,
 * `/` at the start of a message/line completes project skill names. Both are
 * conventions the review agent is prompted to honor.
 */
export function MentionTextarea({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  onSubmit,
  onEscape,
}: Props) {
  const workspace = useStore((s) => s.workspace);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [token, setToken] = useState<{ start: number; text: string } | null>(null);
  const [selected, setSelected] = useState(0);

  const completions = useMemo<Completion[]>(() => {
    if (!token || !workspace) return [];
    const query = token.text.slice(1).toLowerCase();
    if (token.text.startsWith('@')) {
      return workspace.files
        .filter((f) => f.rel.toLowerCase().includes(query))
        .slice(0, 6)
        .map((f) => ({ label: `@${f.rel}`, insert: `@${f.rel}` }));
    }
    return workspace.skills
      .filter((s) => s.toLowerCase().startsWith(query))
      .slice(0, 6)
      .map((s) => ({ label: `/${s}`, insert: `/${s}` }));
  }, [token, workspace]);

  const updateToken = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = /(^|\s)([@/][^\s@]*)$/.exec(before);
    if (!match) {
      setToken(null);
      return;
    }
    const tok = match[2];
    // Slash commands only trigger at the start of a message or line.
    if (tok.startsWith('/')) {
      const lineStart = before.lastIndexOf('\n') + 1;
      if (before.slice(lineStart).trimStart() !== tok) {
        setToken(null);
        return;
      }
    }
    setToken({ start: caret - tok.length, text: tok });
    setSelected(0);
  };

  const apply = (completion: Completion) => {
    if (!token || !ref.current) return;
    const caret = ref.current.selectionStart;
    const next = `${value.slice(0, token.start)}${completion.insert} ${value.slice(caret)}`;
    onChange(next);
    setToken(null);
    const pos = token.start + completion.insert.length + 1;
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (token && completions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => (i + 1) % completions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => (i - 1 + completions.length) % completions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        apply(completions[selected]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setToken(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      onSubmit?.();
      return;
    }
    if (e.key === 'Escape') onEscape?.();
  };

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        className={className}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          updateToken(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setToken(null), 150)}
        onClick={(e) => updateToken(value, (e.target as HTMLTextAreaElement).selectionStart)}
      />
      {token && completions.length > 0 && (
        <div className="mention-menu">
          {completions.map((c, i) => (
            <button
              key={c.label}
              className={`mention-item${i === selected ? ' on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                apply(c);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
