import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Document } from "yaml";
import { CONFIG_DIR, loadConfig, type Config } from "./config.js";
import { TaskmdError } from "./errors.js";
import { parseMarkdown, serializeMarkdown } from "./markdown.js";
import { normalizeRef, type Status } from "./schema.js";

export class Task {
  constructor(
    /** vault からの相対パス（区切りは常に /） */
    public path: string,
    public doc: Document,
    public body: string,
  ) {}

  get data(): Record<string, unknown> {
    return (this.doc.toJS() ?? {}) as Record<string, unknown>;
  }
  get id(): string {
    return String(this.data.id ?? "");
  }
  get title(): string {
    return String(this.data.title ?? "");
  }
  get status(): Status {
    return this.data.status as Status;
  }
  get assignee(): string | undefined {
    return (this.data.assignee as string | null) ?? undefined;
  }
  get priority(): number | undefined {
    return (this.data.priority as number | null) ?? undefined;
  }
  get project(): string | undefined {
    return (this.data.project as string | null) ?? undefined;
  }
  get labels(): string[] {
    return ((this.data.labels as string[] | null) ?? []).map(String);
  }
  get due(): string | undefined {
    return (this.data.due as string | null) ?? undefined;
  }
  get parent(): string | undefined {
    const p = this.data.parent as string | null | undefined;
    return p ? normalizeRef(p) : undefined;
  }
  get dependsOn(): string[] {
    return ((this.data.depends_on as string[] | null) ?? []).map((r) => normalizeRef(String(r)));
  }
  get leaseBy(): string | undefined {
    return (this.data.lease_by as string | null) ?? undefined;
  }
  get leaseUntil(): Date | undefined {
    const v = this.data.lease_until as string | null | undefined;
    return v ? new Date(v) : undefined;
  }
  get leaseRun(): string | undefined {
    return (this.data.lease_run as string | null) ?? undefined;
  }

  set(key: string, value: unknown): void {
    if (value === undefined) this.doc.delete(key);
    else this.doc.set(key, value);
  }

  toMarkdown(): string {
    return serializeMarkdown({ doc: this.doc, body: this.body });
  }
}

export interface ParseIssue {
  path: string;
  message: string;
}

const LOCK_STALE_MS = 30_000;

export class Vault {
  /** テストで時刻を固定できるようにする */
  now: () => Date = () => new Date();

  constructor(
    readonly root: string,
    readonly config: Config,
  ) {}

  /** start から上にたどって `.taskmd/` のあるフォルダを vault とみなす */
  static open(start: string = process.env.TASKMD_VAULT ?? process.cwd()): Vault {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, CONFIG_DIR))) return new Vault(dir, loadConfig(dir));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    throw new TaskmdError(
      `${resolve(start)} から上に .taskmd/ が見つかりません。\`taskmd init\` で vault を作るか、--vault で場所を指定してください。`,
      "no_vault",
    );
  }

  /** vault-template をコピーして新しい vault を作る。既存ファイルは上書きしない */
  static init(dir: string): Vault {
    const target = resolve(dir);
    const template = fileURLToPath(new URL("../../vault-template", import.meta.url));
    mkdirSync(target, { recursive: true });
    cpSync(template, target, { recursive: true, force: false, errorOnExist: false });
    // .gitignore は npm パッケージに含められないのでここで書く
    const gitignore = join(target, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, ".taskmd/locks/\n*.tmp\n", "utf8");
    return new Vault(target, loadConfig(target));
  }

  abs(rel: string): string {
    return join(this.root, ...rel.split("/"));
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  private readTaskFiles(): { tasks: Task[]; issues: ParseIssue[] } {
    const dir = this.abs(this.config.tasksDir);
    const tasks: Task[] = [];
    const issues: ParseIssue[] = [];
    if (!existsSync(dir)) return { tasks, issues };
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name.endsWith(".md")) {
          try {
            const { doc, body } = parseMarkdown(readFileSync(p, "utf8"));
            tasks.push(new Task(this.rel(p), doc, body));
          } catch (e) {
            issues.push({ path: this.rel(p), message: (e as Error).message });
          }
        }
      }
    };
    walk(dir);
    return { tasks, issues };
  }

  /** tasks/ 配下の全タスク。frontmatter を読めないファイルは除く */
  listTasks(): Task[] {
    return this.readTaskFiles().tasks.filter((t) => t.id);
  }

  parseIssues(): ParseIssue[] {
    return this.readTaskFiles().issues;
  }

  findTask(id: string): Task | undefined {
    const want = normalizeRef(id).toUpperCase();
    return this.listTasks().find((t) => t.id.toUpperCase() === want);
  }

  getTask(id: string): Task {
    const t = this.findTask(id);
    if (!t) throw new TaskmdError(`タスク ${id} が見つかりません`, "not_found");
    return t;
  }

  saveTask(task: Task, opts: { touch?: boolean } = {}): void {
    if (opts.touch !== false) task.set("updated", this.now().toISOString());
    this.writeFile(task.path, task.toMarkdown());
  }

  /** 一時ファイルに書いてから rename するので、途中で落ちても壊れたファイルが残らない */
  writeFile(rel: string, text: string): void {
    const p = this.abs(rel);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, p);
  }

  readFile(rel: string): string {
    return readFileSync(this.abs(rel), "utf8");
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  listFiles(relDir: string): string[] {
    const dir = this.abs(relDir);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else out.push(this.rel(p));
      }
    };
    walk(dir);
    return out;
  }

  nextId(): string {
    const prefix = this.config.idPrefix.toUpperCase();
    const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
    let max = 0;
    for (const t of this.listTasks()) {
      const m = re.exec(t.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}-${String(max + 1).padStart(this.config.idDigits, "0")}`;
  }

  /**
   * 同じ名前のロックを持つ処理を直列化する。CLI・MCP・Obsidian から同時に
   * 書き込まれても、claim や ID 採番が二重にならないようにするため。
   */
  withLock<T>(name: string, fn: () => T): T {
    const dir = this.abs(`${CONFIG_DIR}/locks`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.lock`);
    const deadline = Date.now() + 5_000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(path, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
        } catch {
          // 他のプロセスが先に消した
        }
        if (Date.now() > deadline) throw new Error(`ロック ${name} を取得できません: ${path}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // すでに消えている
      }
    }
  }
}
