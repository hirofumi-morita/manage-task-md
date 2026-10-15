import { Document, parseDocument } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface MarkdownFile {
  /** frontmatter。コメントやキーの順番を保ったまま書き戻すため Document で持つ */
  doc: Document;
  body: string;
}

export function parseMarkdown(text: string): MarkdownFile {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { doc: new Document({}), body: text };
  const body = text.slice(m[0].length);
  const doc = parseDocument(m[1] ?? "");
  if (doc.errors.length > 0) {
    throw new Error(`frontmatter を読めません: ${doc.errors[0]!.message}`);
  }
  // 空の frontmatter はキーを足せるように空のマップにしておく
  return { doc: doc.contents === null ? new Document({}) : doc, body };
}

export function serializeMarkdown(file: MarkdownFile): string {
  const fm = file.doc.toString({ lineWidth: 0 });
  return `---\n${fm.endsWith("\n") ? fm : fm + "\n"}---\n${file.body}`;
}

function headingRe(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, "m");
}

/** `## 見出し` から次の `#`/`##` 見出しまでの範囲を返す */
function findSection(body: string, heading: string): { start: number; end: number } | undefined {
  const m = headingRe(heading).exec(body);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const next = /^#{1,2}[ \t]/m.exec(body.slice(start + 1));
  const end = next ? start + 1 + next.index : body.length;
  return { start, end };
}

export function getSection(body: string, heading: string): string | undefined {
  const s = findSection(body, heading);
  return s ? body.slice(s.start, s.end).trim() : undefined;
}

/** セクション末尾に行を追記する。セクションがなければ本文末尾に作る */
export function appendToSection(body: string, heading: string, line: string): string {
  const s = findSection(body, heading);
  if (!s) {
    const base = body.replace(/\s*$/, "");
    return `${base}${base ? "\n\n" : ""}## ${heading}\n\n${line}\n`;
  }
  const content = body.slice(s.start, s.end).replace(/\s*$/, "");
  const rest = body.slice(s.end);
  return `${body.slice(0, s.start)}${content || "\n"}\n${line}\n${rest ? "\n" + rest : ""}`;
}

/** セクションの中身を置き換える。セクションがなければ本文末尾に作る */
export function replaceSection(body: string, heading: string, content: string): string {
  const s = findSection(body, heading);
  const text = content.trim();
  if (!s) {
    const base = body.replace(/\s*$/, "");
    return `${base}${base ? "\n\n" : ""}## ${heading}\n\n${text}\n`;
  }
  const rest = body.slice(s.end);
  return `${body.slice(0, s.start)}\n\n${text}\n${rest ? "\n" + rest : ""}`;
}
