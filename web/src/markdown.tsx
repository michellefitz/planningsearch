import type { ReactNode } from "react";

// Minimal markdown renderer: headings, bullet/numbered lists, **bold**,
// *italic*/_italic_, links flattened to their label. Unpaired markers stay literal.
// Shared by the chat panel and the pre-planner report narrative.
const ITALIC_RE = /(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
const BULLET_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;

export function inline(s: string): ReactNode[] {
  const text = s.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1");
  return text.split(/\*\*([^*]+)\*\*/g).flatMap((part, i) => {
    if (i % 2) return [<strong key={`b${i}`}>{part}</strong>];
    return part
      .split(ITALIC_RE)
      .map((seg, j) =>
        j % 2 ? <em key={`i${i}-${j}`}>{seg.slice(1, -1)}</em> : seg
      );
  });
}

export function renderMarkdown(text: string, key: number): ReactNode[] {
  const blocks: ReactNode[] = [];
  text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .forEach((para, pi) => {
      const lines = para
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let i = 0;
      let seg = 0;
      while (i < lines.length) {
        const k = `${key}-${pi}-${seg++}`;
        const heading = lines[i].match(/^#{1,4}\s+(.*)/);
        if (heading) {
          blocks.push(
            <p key={k} className="chat-heading">
              {inline(heading[1])}
            </p>
          );
          i++;
        } else if (BULLET_RE.test(lines[i])) {
          const items: string[] = [];
          while (i < lines.length && BULLET_RE.test(lines[i]))
            items.push(lines[i++].replace(BULLET_RE, ""));
          blocks.push(
            <ul key={k}>
              {items.map((it, li) => (
                <li key={li}>{inline(it)}</li>
              ))}
            </ul>
          );
        } else if (ORDERED_RE.test(lines[i])) {
          const items: string[] = [];
          while (i < lines.length && ORDERED_RE.test(lines[i]))
            items.push(lines[i++].replace(ORDERED_RE, ""));
          blocks.push(
            <ol key={k}>
              {items.map((it, li) => (
                <li key={li}>{inline(it)}</li>
              ))}
            </ol>
          );
        } else {
          const plain: string[] = [];
          while (
            i < lines.length &&
            !/^#{1,4}\s/.test(lines[i]) &&
            !BULLET_RE.test(lines[i]) &&
            !ORDERED_RE.test(lines[i])
          )
            plain.push(lines[i++]);
          blocks.push(<p key={k}>{inline(plain.join("\n"))}</p>);
        }
      }
    });
  return blocks;
}
