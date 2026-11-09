import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion, useInView } from "#/views/in-view";

// A dark code panel. `title` is shown in a bar above the code, `command` is
// printed after a "$" prompt, and `source` is highlighted as JSON, JSONC or
// TypeScript. `wrap` wraps long lines instead of scrolling them.
export function Terminal({
  title,
  command,
  source,
  className = "",
  wrap = false,
  children,
}: {
  title?: ReactNode;
  command?: string;
  source?: string;
  className?: string;
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`dark rounded-xl bg-term text-ink shadow-window overflow-hidden ${className}`}>
      {title && <TitleBar>{title}</TitleBar>}
      <pre
        className={`px-5 py-4 font-mono text-[12.5px] leading-[1.8] text-ink-2 overflow-x-auto ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      >
        {command && (
          <code className="block text-ink">
            <PromptMark />
            {command}
          </code>
        )}
        {command && source && <code className="block h-3" />}
        {source && <code className="block">{highlight(source)}</code>}
      </pre>
      {children}
    </div>
  );
}

export function TitleBar({ children }: { children: ReactNode }) {
  return (
    <div className="h-11 px-4 flex items-center gap-3 border-b border-rule font-mono text-xs text-ink-2">
      {children}
    </div>
  );
}

function PromptMark({ prompt }: { prompt?: string }) {
  return <span className="select-none text-accent-ink">{prompt ?? "$"} </span>;
}

function Caret() {
  return <span className="lenses-caret inline-block w-[0.55em] h-[1.15em] -mb-[0.2em] bg-accent" />;
}

export type TermLine = { prompt?: string; text: string; pause?: number };

// Types its commands once it is on screen. Each output line follows after a
// pause. Every line is laid out from the start, unseen, so nothing below
// moves while it types.
export function TypedTerminal({ title = "Terminal", lines }: { title?: string; lines: TermLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, 0.7);
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    if (seen && prefersReducedMotion()) setLine(lines.length);
  }, [seen, lines.length]);

  useEffect(() => {
    if (!seen || line >= lines.length) return;
    const current = lines[line]!;
    const typing = current.prompt !== undefined && chars < current.text.length;
    if (typing) {
      const timer = window.setTimeout(() => setChars(chars + 1), 22 + Math.random() * 38);
      return () => clearTimeout(timer);
    }
    const next = lines[line + 1];
    const wait = line === 0 && chars === 0 ? 500 : next?.prompt !== undefined ? 900 : (next?.pause ?? 350);
    const timer = window.setTimeout(() => {
      setLine(line + 1);
      setChars(next && next.prompt === undefined ? next.text.length : 0);
    }, wait);
    return () => clearTimeout(timer);
  }, [seen, line, chars, lines]);

  const done = line >= lines.length;
  return (
    <div ref={ref} className="dark w-full rounded-xl bg-term text-ink shadow-window overflow-hidden">
      <TitleBar>{title}</TitleBar>
      <pre className="px-5 py-4 font-mono text-[12.5px] leading-[1.8] whitespace-pre-wrap break-words">
        <code>
          {lines.map((item, index) => {
            const shown = index < line ? item.text.length : index === line ? chars : 0;
            const visible = index < line || (index === line && (item.prompt !== undefined || shown > 0));
            return (
              <span key={index} className={`block ${item.prompt === undefined ? "text-ink-2" : ""}`}>
                <span className={visible ? undefined : "invisible"}>
                  {item.prompt !== undefined && <PromptMark prompt={item.prompt} />}
                  {item.prompt === undefined ? highlight(item.text.slice(0, shown)) : item.text.slice(0, shown)}
                  {index === line && item.prompt !== undefined && <Caret />}
                </span>
                <span className="invisible">{item.text.slice(shown)}</span>
              </span>
            );
          })}
          <span className={`block ${done ? "" : "invisible"}`}>
            <PromptMark prompt={[...lines].reverse().find((item) => item.prompt !== undefined)?.prompt} />
            <Caret />
          </span>
        </code>
      </pre>
    </div>
  );
}

export type IdeFile = { name: string; source: string; command: string; output: string };

// A dark editor window: files on the left, the selected file in the middle,
// and the command for that file and its output on the right.
export function Ide({ files, className = "" }: { files: IdeFile[]; className?: string }) {
  const [active, setActive] = useState(0);
  const file = files[active]!;
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,3fr)_minmax(0,2fr)] lg:h-[34rem] dark rounded-xl bg-term text-ink-2 shadow-window overflow-hidden font-mono text-[12.5px] leading-[1.8] ${className}`}
    >
      <nav className="py-3 border-b lg:border-b-0 lg:border-r border-rule">
        {files.map((item, index) => (
          <button
            key={item.name}
            type="button"
            onClick={() => setActive(index)}
            className={`block w-full truncate px-4 py-1.5 text-left cursor-pointer ${
              index === active ? "bg-card text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            {item.name}
          </button>
        ))}
      </nav>
      <pre className="h-[28rem] lg:h-auto overflow-auto px-5 py-4 whitespace-pre">
        <code>{highlight(file.source)}</code>
      </pre>
      <pre className="h-[20rem] lg:h-auto overflow-auto px-5 py-4 whitespace-pre-wrap break-words border-t lg:border-t-0 lg:border-l border-rule">
        <code className="block text-ink">
          <PromptMark />
          {file.command}
        </code>
        <code className="block h-2" />
        <code className="block">{highlight(file.output)}</code>
      </pre>
    </div>
  );
}

// Enough of JSONC and TypeScript for the snippets on the landing page. A
// string followed by a colon is a key. "//" after a colon is part of a URL.
const token =
  /((?<![:\w])\/\/[^\n]*|(?<![:\w])#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')(\s*:)?|\b(import|from|await|using|const|export|default|if|else|true|false|null)\b|(-?\b\d+\b)/g;

function highlight(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > last) out.push(source.slice(last, index));
    const [text, comment, string, colon, keyword, number] = match;
    const key = out.length;
    if (comment) out.push(<span key={key} className="text-ink-3">{comment}</span>);
    else if (string && colon) out.push(<span key={key} className="text-ink">{string}</span>, colon);
    else if (string) out.push(<span key={key} className="text-[#ff9d85]">{string}</span>);
    else if (keyword) out.push(<span key={key} className="text-[#b39aff]">{keyword}</span>);
    else if (number) out.push(<span key={key} className="text-[#6ee7d8]">{number}</span>);
    else out.push(text);
    last = index + text.length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}
