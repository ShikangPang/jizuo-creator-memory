import { Fragment, type ReactNode } from "react";

const INLINE_TOKEN = /(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\)|\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;

function safeHref(value: string): string | undefined {
  const href = value.trim();
  if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith("#")) return href;
  return undefined;
}

function linkParts(token: string): { label: string; href: string } | null {
  const imageOffset = token.startsWith("!") ? 1 : 0;
  const labelEnd = token.indexOf("](", imageOffset);
  if (labelEnd < 0) return null;
  const destination = token.slice(labelEnd + 2, -1);
  const titleStart = destination.indexOf(' "');
  return {
    label: token.slice(imageOffset + 1, labelEnd),
    href: titleStart < 0 ? destination : destination.slice(0, titleStart),
  };
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of value.matchAll(INLINE_TOKEN)) {
    const index = match.index;
    const token = match[0];
    if (index > cursor) nodes.push(value.slice(cursor, index));
    const key = `${keyPrefix}-${tokenIndex}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("![")) {
      const parts = linkParts(token);
      if (parts === null) {
        nodes.push(<span key={key}>{token}</span>);
      } else {
        const src = safeHref(parts.href);
        nodes.push(src === undefined ? (
          <span key={key}>{parts.label}</span>
        ) : (
          <img key={key} src={src} alt={parts.label} loading="lazy" referrerPolicy="no-referrer" />
        ));
      }
    } else if (token.startsWith("[")) {
      const parts = linkParts(token);
      if (parts === null) {
        nodes.push(<span key={key}>{token}</span>);
      } else {
        const href = safeHref(parts.href);
        nodes.push(href === undefined ? (
          <span key={key}>{parts.label}</span>
        ) : (
          <a key={key} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">
            {renderInline(parts.label, `${key}-link`)}
          </a>
        ));
      }
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}-strong`)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), `${key}-delete`)}</del>);
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}-emphasis`)}</em>);
    }

    cursor = index + token.length;
    tokenIndex += 1;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function renderParagraph(lines: string[], key: string): ReactNode {
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 && <br />}
          {renderInline(line, `${key}-${index}`)}
        </Fragment>
      ))}
    </p>
  );
}

function startsBlock(line: string): boolean {
  return /^(?: {0,3}```|#{1,6}\s+| {0,3}>\s?| {0,3}(?:[-+*]|\d+[.)])\s+| {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
}

function renderBlocks(content: string): ReactNode[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}```\s*([^\s`]*)\s*$/);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] ?? "";
      nodes.push(
        <pre key={`code-${index}`}>
          <code className={language === "" ? undefined : `language-${language}`}>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading !== null) {
      const level = (heading[1] ?? "").length;
      const children = renderInline(heading[2] ?? "", `heading-${index}`);
      if (level === 1) nodes.push(<h1 key={`heading-${index}`}>{children}</h1>);
      else if (level === 2) nodes.push(<h2 key={`heading-${index}`}>{children}</h2>);
      else if (level === 3) nodes.push(<h3 key={`heading-${index}`}>{children}</h3>);
      else if (level === 4) nodes.push(<h4 key={`heading-${index}`}>{children}</h4>);
      else if (level === 5) nodes.push(<h5 key={`heading-${index}`}>{children}</h5>);
      else nodes.push(<h6 key={`heading-${index}`}>{children}</h6>);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quote: string[] = [];
      const start = index;
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      nodes.push(<blockquote key={`quote-${start}`}>{renderBlocks(quote.join("\n"))}</blockquote>);
      continue;
    }

    const listItem = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (listItem !== null) {
      const ordered = /^\d/.test(listItem[1] ?? "");
      const items: string[] = [];
      const start = index;
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (item === null || /^\d/.test(item[1] ?? "") !== ordered) break;
        items.push(item[2] ?? "");
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`item-${start}-${itemIndex}`}>{renderInline(item, `item-${start}-${itemIndex}`)}</li>
      ));
      nodes.push(ordered
        ? <ol key={`list-${start}`}>{children}</ol>
        : <ul key={`list-${start}`}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    const start = index;
    while (
      index < lines.length
      && (lines[index] ?? "").trim() !== ""
      && (paragraph.length === 0 || !startsBlock(lines[index] ?? ""))
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    nodes.push(renderParagraph(paragraph, `paragraph-${start}`));
  }

  return nodes;
}

export function MarkdownDocument({ content }: { content: string }) {
  return <>{renderBlocks(content)}</>;
}
