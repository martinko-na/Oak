/**
 * The agent emits GitHub-flavored Markdown, but Telegram renders message text
 * literally unless a parse_mode is set, so `**bold**` shows up as raw asterisks.
 * These helpers convert that Markdown into the small HTML subset Telegram accepts
 * (parse_mode "HTML"), with a plain-text stripper for the fallback path used when
 * Telegram rejects the entities.
 */

// A control char that will not appear in model output and is not HTML-escaped, so
// code placeholders survive the escape and transform passes untouched.
const SENTINEL = String.fromCharCode(0);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The coach must never use em dashes (per CLAUDE.md). Enforce it deterministically
 * on outbound text rather than trusting the model: collapse an em dash (and the
 * horizontal bar) plus any surrounding spaces into a comma. En dashes are left
 * alone so numeric ranges like "8–12 reps" survive. Call this only on prose;
 * code spans are protected by the caller.
 */
function stripEmDashes(s: string): string {
  return s.replace(/\s*[—―]\s*/g, ", ");
}

/**
 * Telegram has no table entity, so a Markdown table would arrive as raw pipes in a
 * proportional font. Render it instead as space-padded columns, which line up once
 * the caller wraps them in <pre> (or, in plain text, at least read as columns).
 * Inline markup is stripped from cells because <pre> shows it literally. Numeric
 * columns (or ones marked `---:`) are right-aligned so totals line up.
 */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function cleanCell(cell: string): string {
  return stripEmDashes(cell)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, "$1$2");
}

const NUMERIC_CELL = /^([~≈<>+-]?\d[\d.,]*\s*[a-z%]{0,4}|-|)$/i;

function renderTable(lines: string[]): string {
  const header = splitRow(lines[0] ?? "").map(cleanCell);
  const aligns = splitRow(lines[1] ?? "");
  const body = lines.slice(2).map((line) => splitRow(line).map(cleanCell));
  const rows = [header, ...body];
  const cols = header.length;
  const widths = Array.from({ length: cols }, (_v, c) =>
    Math.max(...rows.map((row) => [...(row[c] ?? "")].length)),
  );
  const rightAligned = Array.from({ length: cols }, (_v, c) => {
    const spec = aligns[c] ?? "";
    if (spec.startsWith(":") || spec.endsWith(":")) return !spec.startsWith(":");
    return (
      body.some((row) => (row[c] ?? "") !== "") &&
      body.every((row) => NUMERIC_CELL.test(row[c] ?? ""))
    );
  });
  const pad = (cell: string, c: number): string => {
    const gap = " ".repeat((widths[c] ?? 0) - [...cell].length);
    return rightAligned[c] ? gap + cell : cell + gap;
  };
  const format = (row: string[]): string =>
    Array.from({ length: cols }, (_v, c) => pad(row[c] ?? "", c))
      .join("  ")
      .trimEnd();
  const rule = widths.map((w) => "─".repeat(w)).join("  ");
  return [format(header), rule, ...body.map(format)].join("\n");
}

/**
 * Replace every Markdown table outside fenced code with `wrap(rendered)`. A table
 * is a pipe row, a separator row, then any following rows that contain a pipe.
 */
function convertTables(input: string, wrap: (rendered: string) => string): string {
  return input
    .split(/(```[\s\S]*?```)/)
    .map((segment, s) => {
      if (s % 2 === 1) return segment;
      const lines = segment.split("\n");
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const next = lines[i + 1] ?? "";
        if (line.includes("|") && TABLE_SEPARATOR.test(next) && next.includes("|")) {
          let end = i + 2;
          while (end < lines.length && (lines[end] ?? "").includes("|")) end++;
          out.push(wrap(renderTable(lines.slice(i, end))));
          i = end - 1;
          continue;
        }
        out.push(line);
      }
      return out.join("\n");
    })
    .join("");
}

/** Convert the model's Markdown to Telegram-flavored HTML. */
export function toTelegramHtml(input: string): string {
  const codeStore: string[] = [];
  const stash = (html: string): string => {
    codeStore.push(html);
    return `${SENTINEL}${codeStore.length - 1}${SENTINEL}`;
  };

  // 1. Pull code out first so its contents are never touched by the inline
  //    transforms below (a `**` inside a code span must stay literal). Fenced
  //    blocks before inline spans.
  let text = input.replace(/```[ \t]*[\w+-]*\n?([\s\S]*?)```/g, (_m, body: string) =>
    stash(`<pre>${escapeHtml(body.replace(/\n$/, ""))}</pre>`),
  );
  text = convertTables(text, (rendered) => stash(`<pre>${escapeHtml(rendered)}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  // 1b. With code stashed away, scrub em dashes from the remaining prose.
  text = stripEmDashes(text);

  // 2. Escape HTML in the remaining prose, before we generate any tags.
  text = escapeHtml(text);

  // 3a. Line-level: headings become bold, bullets become "•". Done before inline
  //     bold so a heading never nests <b> inside <b>.
  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading) {
        const inner = (heading[1] ?? "")
          .replace(/\*\*/g, "")
          .replace(/\s*#+\s*$/, "")
          .trim();
        return `<b>${inner}</b>`;
      }
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n");

  // 3b. Inline: links, then bold, then italic, then strikethrough.
  text = text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/(^|[^\w])_(.+?)_(?=[^\w]|$)/g, "$1<i>$2</i>");
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 4. Restore code placeholders.
  text = text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i: string) => codeStore[Number(i)] ?? "",
  );
  return text;
}

/**
 * Prepare the model's Markdown for sendRichMessage (Bot API 10.1+), which renders
 * Markdown natively, tables included. Only the em-dash rule is applied, and never
 * inside code.
 */
export function toRichMarkdown(input: string): string {
  const codeStore: string[] = [];
  const stash = (code: string): string => {
    codeStore.push(code);
    return `${SENTINEL}${codeStore.length - 1}${SENTINEL}`;
  };
  let text = input.replace(/```[\s\S]*?```/g, stash);
  text = text.replace(/`[^`\n]+`/g, stash);
  text = stripEmDashes(text);
  return text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i: string) => codeStore[Number(i)] ?? "",
  );
}

/** Strip Markdown to clean plain text for the no-parse-mode fallback. */
export function toPlainText(input: string): string {
  let text = convertTables(input, (rendered) => rendered);
  text = stripEmDashes(text);
  text = text.replace(/```[ \t]*[\w+-]*\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/~~(.+?)~~/g, "$1");
  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (heading)
        return (heading[1] ?? "")
          .replace(/\*\*/g, "")
          .replace(/\s*#+\s*$/, "")
          .trim();
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n");
  return text;
}
