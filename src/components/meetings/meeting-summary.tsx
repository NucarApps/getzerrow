import { Fragment, type ReactNode } from "react";

/**
 * Lightweight renderer for the AI meeting breakdown. It handles the narrow
 * markdown subset the breakdown prompt produces — "## " sections, "### "
 * subheadings, "- " bullets, and inline **bold** — styled to match the rest of
 * the meeting detail view. Older meetings whose summary is still the plain
 * "Key moments" digest render fine too: lines without markup become paragraphs.
 */

/** Render inline **bold** spans within a line of text. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) {
      return (
        <strong key={i} className="font-medium text-foreground">
          {bold[1]}
        </strong>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "p"; text: string };

/** Parse the breakdown markdown into a flat list of renderable blocks. */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let list: string[] | null = null;

  const flushList = () => {
    if (list && list.length) blocks.push({ kind: "list", items: list });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      blocks.push({ kind: "h3", text: line.slice(4).trim() });
    } else if (line.startsWith("## ")) {
      flushList();
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      if (!list) list = [];
      list.push(line.slice(2).trim());
    } else {
      flushList();
      blocks.push({ kind: "p", text: line });
    }
  }
  flushList();
  return blocks;
}

export function MeetingSummary({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        if (block.kind === "h2") {
          return (
            <h4 key={i} className="mt-1 text-sm font-semibold text-foreground first:mt-0">
              {block.text}
            </h4>
          );
        }
        if (block.kind === "h3") {
          return (
            <h5 key={i} className="text-sm font-medium text-foreground">
              {renderInline(block.text)}
            </h5>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
                  <span
                    aria-hidden
                    className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                  />
                  <span>{renderInline(item)}</span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-muted-foreground">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
