import { parseMarkdown, serializeMarkdown, appendToSection, replaceSection } from "./markdown.js";
import { TaskmdError } from "./errors.js";
import {
  ACTOR_RE,
  CLOSED_STATUSES,
  STATUSES,
  TaskFrontmatterSchema,
  TRANSITIONS,
  normalizeRef,
  toLink,
  type Status,
} from "./schema.js";
import { Task, type Vault } from "./vault.js";

export const LOG_HEADING = "作業ログ";
export const RESULT_HEADING = "結果";

// ---------------------------------------------------------------- 参照系

export interface TaskFilter {
  status?: Status | Status[];
  assignee?: string;
  project?: string;
  label?: string;
  parent?: string;
  /** 今すぐ着手できるものだけ（isActionable を参照） */
  actionable?: boolean;
}

export function isLeaseActive(task: Task, now: Date): boolean {
  const until = task.leaseUntil;
  return Boolean(task.leaseBy && until && until.getTime() > now.getTime());
}

export function openDependencies(task: Task, all: Task[]): string[] {
  const byId = new Map(all.map((t) => [t.id.toUpperCase(), t]));
  return task.dependsOn.filter((d) => {
    const dep = byId.get(d.toUpperCase());
    return !dep || !CLOSED_STATUSES.includes(dep.status);
  });
}

export function openChildren(task: Task, all: Task[]): Task[] {
  return all.filter(
    (t) => t.parent?.toUpperCase() === task.id.toUpperCase() && !CLOSED_STATUSES.includes(t.status),
  );
}

/** ready・依存完了・lease なし・未完了の子タスクなし（子があるなら作業は子の方で行う） */
export function isActionable(task: Task, all: Task[], now: Date): boolean {
  return (
    task.status === "ready" &&
    openDependencies(task, all).length === 0 &&
    openChildren(task, all).length === 0 &&
    !isLeaseActive(task, now)
  );
}

export function listTasks(vault: Vault, filter: TaskFilter = {}): Task[] {
  const all = vault.listTasks();
  const now = vault.now();
  const statuses = filter.status ? ([] as Status[]).concat(filter.status) : undefined;
  return sortTasks(
    all.filter(
      (t) =>
        (!statuses || statuses.includes(t.status)) &&
        (!filter.assignee || t.assignee === filter.assignee) &&
        (!filter.project || t.project === filter.project) &&
        (!filter.label || t.labels.includes(filter.label)) &&
        (!filter.parent || t.parent?.toUpperCase() === normalizeRef(filter.parent).toUpperCase()) &&
        (!filter.actionable || isActionable(t, all, now)),
    ),
  );
}

/** 優先度 → 期日 → ID の順 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      (a.priority ?? 3) - (b.priority ?? 3) ||
      (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

/**
 * 次に着手すべきタスク。assignee を渡すと、その担当のものと担当なしのものから選ぶ
 * （担当が決まっているものを優先）。
 */
export function nextTask(vault: Vault, opts: { assignee?: string; project?: string } = {}): Task | undefined {
  const candidates = listTasks(vault, { actionable: true, project: opts.project }).filter(
    (t) => !opts.assignee || !t.assignee || t.assignee === opts.assignee,
  );
  if (opts.assignee) {
    const mine = candidates.find((t) => t.assignee === opts.assignee);
    if (mine) return mine;
  }
  return candidates[0];
}

export interface TaskSummary {
  id: string;
  title: string;
  status: Status;
  assignee?: string;
  priority?: number;
  project?: string;
  labels?: string[];
  due?: string;
  parent?: string;
  depends_on?: string[];
  path: string;
}

export function summarize(t: Task): TaskSummary {
  const s: TaskSummary = { id: t.id, title: t.title, status: t.status, path: t.path };
  if (t.assignee) s.assignee = t.assignee;
  if (t.priority !== undefined) s.priority = t.priority;
  if (t.project) s.project = t.project;
  if (t.labels.length) s.labels = t.labels;
  if (t.due) s.due = t.due;
  if (t.parent) s.parent = t.parent;
  if (t.dependsOn.length) s.depends_on = t.dependsOn;
  return s;
}

export interface TaskDetail extends TaskSummary {
  markdown: string;
  open_dependencies: string[];
  children: { id: string; title: string; status: Status }[];
  lease?: { by: string; until: string; run?: string; active: boolean };
}

export function taskDetail(vault: Vault, id: string): TaskDetail {
  const all = vault.listTasks();
  const t = vault.getTask(id);
  const detail: TaskDetail = {
    ...summarize(t),
    markdown: t.toMarkdown(),
    open_dependencies: openDependencies(t, all),
    children: all
      .filter((c) => c.parent?.toUpperCase() === t.id.toUpperCase())
      .map((c) => ({ id: c.id, title: c.title, status: c.status })),
  };
  if (t.leaseBy && t.leaseUntil) {
    detail.lease = {
      by: t.leaseBy,
      until: t.leaseUntil.toISOString(),
      run: t.leaseRun,
      active: isLeaseActive(t, vault.now()),
    };
  }
  return detail;
}

// ---------------------------------------------------------------- 更新系

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 作業ログ用のローカル時刻（YYYY-MM-DD HH:mm） */
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function assertActor(actor: string): void {
  if (!ACTOR_RE.test(actor)) {
    throw new TaskmdError(`担当者は human:名前 か agent:名前 の形で指定してください（${actor}）`, "invalid_input");
  }
}

function addLog(task: Task, vault: Vault, actor: string, text: string): void {
  const line = `- ${localStamp(vault.now())} ${actor} ${text.replace(/\s*\n\s*/g, " ").trim()}`;
  task.body = appendToSection(task.body, LOG_HEADING, line);
}

function clearLease(task: Task): void {
  task.set("lease_by", undefined);
  task.set("lease_until", undefined);
  task.set("lease_run", undefined);
}

export function appendLog(vault: Vault, id: string, actor: string, text: string): Task {
  assertActor(actor);
  if (!text.trim()) throw new TaskmdError("ログの本文が空です", "invalid_input");
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const t = vault.getTask(id);
    addLog(t, vault, actor, text);
    vault.saveTask(t);
    return t;
  });
}

export interface SetStatusOptions {
  actor: string;
  note?: string;
  /** 遷移表・依存関係のチェックを無視する（人の手での修正用） */
  force?: boolean;
}

/** 状態遷移のルールを確かめて status を変える。done にしたときは後続タスクの blocked を解く */
export function setStatus(vault: Vault, id: string, to: Status, opts: SetStatusOptions): Task {
  assertActor(opts.actor);
  if (!STATUSES.includes(to)) throw new TaskmdError(`不明なステータスです: ${to}`, "invalid_input");
  if (to === "done" && opts.actor.startsWith("agent:") && !vault.config.agentsCanComplete) {
    throw new TaskmdError(
      "エージェントは done にできません。submit_for_review で review に出して、人の確認を待ってください。",
      "forbidden",
    );
  }
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const all = vault.listTasks();
    const t = vault.getTask(id);
    const from = t.status;
    if (from === to) return t;
    if (!opts.force) {
      if (!TRANSITIONS[from]?.includes(to)) {
        throw new TaskmdError(
          `${t.id} を ${from} から ${to} には変えられません（${from} から行けるのは ${TRANSITIONS[from]?.join(", ") || "なし"}）`,
          "invalid_transition",
        );
      }
      const deps = openDependencies(t, all);
      if ((to === "ready" || to === "in_progress") && deps.length) {
        throw new TaskmdError(
          `${t.id} は未完了の依存タスクがあるため ${to} にできません: ${deps.join(", ")}`,
          "dependencies_open",
        );
      }
      const children = openChildren(t, all);
      if (to === "done" && children.length) {
        throw new TaskmdError(
          `${t.id} には未完了の子タスクがあります: ${children.map((c) => c.id).join(", ")}`,
          "children_open",
        );
      }
    }
    t.set("status", to);
    if (to !== "in_progress") clearLease(t);
    addLog(t, vault, opts.actor, `${from} → ${to}${opts.note ? `: ${opts.note}` : ""}`);
    vault.saveTask(t);
    if (to === "done" || to === "cancelled") unblockDependents(vault, t.id);
    return t;
  });
}

/**
 * 依存がすべて片付いた blocked タスクを ready に戻す。
 * depends_on を持たない blocked タスクは手動で止めたものなので触らない。
 */
export function unblockDependents(vault: Vault, doneId: string): Task[] {
  const all = vault.listTasks();
  const changed: Task[] = [];
  for (const t of all) {
    if (t.status !== "blocked") continue;
    if (!t.dependsOn.some((d) => d.toUpperCase() === doneId.toUpperCase())) continue;
    if (openDependencies(t, all).length) continue;
    t.set("status", "ready");
    addLog(t, vault, "agent:taskmd", `依存タスクがすべて完了したため blocked → ready`);
    vault.saveTask(t);
    changed.push(t);
  }
  return changed;
}

export interface ClaimResult {
  task: Task;
  runPath: string;
}

/**
 * 着手する。ready（または lease 切れの in_progress）のタスクに lease を書き、
 * in_progress にして、runs/ に実行ログファイルを作る。
 */
export function claimTask(vault: Vault, id: string, actor: string, opts: { force?: boolean } = {}): ClaimResult {
  assertActor(actor);
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const all = vault.listTasks();
    const t = vault.getTask(id);
    const now = vault.now();
    if (t.status === "in_progress") {
      if (isLeaseActive(t, now) && !opts.force) {
        throw new TaskmdError(
          `${t.id} は ${t.leaseBy} が ${t.leaseUntil!.toISOString()} まで作業中です`,
          "leased",
        );
      }
    } else if (t.status !== "ready" && !opts.force) {
      throw new TaskmdError(
        `${t.id} は ${t.status} なので着手できません（着手できるのは ready のタスクです）`,
        "invalid_transition",
      );
    }
    const deps = openDependencies(t, all);
    if (deps.length && !opts.force) {
      throw new TaskmdError(`${t.id} は未完了の依存タスクがあります: ${deps.join(", ")}`, "dependencies_open");
    }

    const runPath = createRunFile(vault, t, actor, now);
    const until = new Date(now.getTime() + vault.config.leaseMinutes * 60_000);
    const from = t.status;
    t.set("status", "in_progress");
    if (!t.assignee) t.set("assignee", actor);
    t.set("lease_by", actor);
    t.set("lease_until", until.toISOString());
    t.set("lease_run", toLink(runPath.replace(/\.md$/, "")));
    addLog(
      t,
      vault,
      actor,
      `着手（${from} → in_progress）。実行ログ: ${toLink(runPath.replace(/\.md$/, ""))}`,
    );
    vault.saveTask(t);
    return { task: t, runPath };
  });
}

function createRunFile(vault: Vault, task: Task, actor: string, now: Date): string {
  const prefix = `${task.id}-r`;
  const existing = vault
    .listFiles(vault.config.runsDir)
    .map((p) => p.split("/").pop()!)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".md"))
    .map((n) => Number(n.slice(prefix.length, -3)))
    .filter((n) => Number.isFinite(n));
  const runNo = (existing.length ? Math.max(...existing) : 0) + 1;
  const path = `${vault.config.runsDir}/${localDate(now)}/${prefix}${runNo}.md`;
  const { doc } = parseMarkdown("---\n---\n");
  doc.set("task", toLink(task.id));
  doc.set("run", runNo);
  doc.set("actor", actor);
  doc.set("status", "running");
  doc.set("started", now.toISOString());
  const body = `\n# ${task.id} 実行 ${runNo}: ${task.title}\n\n## メモ\n\n## 結果\n`;
  vault.writeFile(path, serializeMarkdown({ doc, body }));
  return path;
}

/** lease を延長する（長い作業の途中で呼ぶ） */
export function renewLease(vault: Vault, id: string, actor: string): Task {
  assertActor(actor);
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const t = vault.getTask(id);
    if (t.status !== "in_progress" || t.leaseBy !== actor) {
      throw new TaskmdError(`${t.id} は ${actor} が作業中ではありません`, "invalid_input");
    }
    const until = new Date(vault.now().getTime() + vault.config.leaseMinutes * 60_000);
    t.set("lease_until", until.toISOString());
    vault.saveTask(t);
    return t;
  });
}

/** 作業を終えて review に出す。結果セクションと実行ログに要約を書く */
export function submitForReview(vault: Vault, id: string, actor: string, summary: string): Task {
  assertActor(actor);
  if (!summary.trim()) throw new TaskmdError("結果の要約を書いてください", "invalid_input");
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const t = vault.getTask(id);
    if (t.status !== "in_progress") {
      throw new TaskmdError(`${t.id} は ${t.status} です。review に出せるのは in_progress のタスクです`, "invalid_transition");
    }
    const run = t.leaseRun ? normalizeRef(t.leaseRun) : undefined;
    if (run && vault.exists(`${run}.md`)) {
      const f = parseMarkdown(vault.readFile(`${run}.md`));
      f.doc.set("status", "review");
      f.doc.set("ended", vault.now().toISOString());
      f.body = replaceSection(f.body, "結果", summary);
      vault.writeFile(`${run}.md`, serializeMarkdown(f));
    }
    t.body = replaceSection(t.body, RESULT_HEADING, summary);
    t.set("status", "review");
    clearLease(t);
    addLog(t, vault, actor, `review に提出: ${firstLine(summary)}`);
    vault.saveTask(t);
    return t;
  });
}

function firstLine(s: string): string {
  const line = s.trim().split("\n")[0]!;
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

export interface CreateTaskInput {
  title: string;
  status?: Status;
  assignee?: string;
  priority?: number;
  project?: string;
  parent?: string;
  depends_on?: string[];
  labels?: string[];
  due?: string;
  /** 目的セクション */
  goal?: string;
  /** 受け入れ条件（1要素1チェックボックス） */
  acceptance?: string[];
  /** コンテキストセクション */
  context?: string;
}

const UNSAFE_FILENAME = /[\\/:*?"<>|#^[\]]/g;

function fileSlug(title: string): string {
  return title.replace(UNSAFE_FILENAME, " ").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
}

function defaultBody(): string {
  return `\n## 目的\n\n## 受け入れ条件\n\n## コンテキスト\n\n## ${LOG_HEADING}\n\n## ${RESULT_HEADING}\n`;
}

export function createTask(vault: Vault, input: CreateTaskInput, actor: string): Task {
  assertActor(actor);
  const title = input.title?.trim();
  if (!title) throw new TaskmdError("タイトルが空です", "invalid_input");
  if (input.assignee) assertActor(input.assignee);

  return vault.withLock("create", () => {
    const all = vault.listTasks();
    const ids = new Set(all.map((t) => t.id.toUpperCase()));
    const deps = (input.depends_on ?? []).map(normalizeRef);
    for (const ref of [...deps, ...(input.parent ? [normalizeRef(input.parent)] : [])]) {
      if (!ids.has(ref.toUpperCase())) throw new TaskmdError(`タスク ${ref} が見つかりません`, "not_found");
    }

    const id = vault.nextId();
    const now = vault.now().toISOString();
    const templatePath = `${vault.config.templatesDir}/task.md`;
    const file = parseMarkdown(vault.exists(templatePath) ? vault.readFile(templatePath) : `---\n---\n${defaultBody()}`);
    const t = new Task(`${vault.config.tasksDir}/${id}${fileSlug(title) ? "-" + fileSlug(title) : ""}.md`, file.doc, file.body);

    const blockedByDeps = deps.some((d) => {
      const dep = all.find((x) => x.id.toUpperCase() === d.toUpperCase());
      return !dep || !CLOSED_STATUSES.includes(dep.status);
    });
    let status: Status = input.status ?? "ready";
    if (blockedByDeps && (status === "ready" || status === "in_progress")) status = "blocked";

    t.set("id", id);
    t.set("aliases", [id]);
    t.set("title", title);
    t.set("status", status);
    t.set("assignee", input.assignee ?? null);
    t.set("priority", input.priority ?? 3);
    t.set("project", input.project ?? null);
    t.set("parent", input.parent ? toLink(input.parent) : null);
    t.set("depends_on", deps.map(toLink));
    t.set("labels", input.labels ?? []);
    t.set("due", input.due ?? null);
    t.set("created", now);
    t.set("updated", now);

    if (input.goal) t.body = replaceSection(t.body, "目的", input.goal);
    if (input.acceptance?.length) {
      t.body = replaceSection(t.body, "受け入れ条件", input.acceptance.map((a) => `- [ ] ${a}`).join("\n"));
    }
    if (input.context) t.body = replaceSection(t.body, "コンテキスト", input.context);
    addLog(t, vault, actor, `作成（${status}）`);

    const check = TaskFrontmatterSchema.safeParse(t.data);
    if (!check.success) {
      throw new TaskmdError(`入力が不正です: ${formatZodIssues(check.error.issues)}`, "invalid_input");
    }
    vault.saveTask(t, { touch: false });
    return t;
  });
}

/** 親タスクの下に子タスクをまとめて作る */
export function splitTask(vault: Vault, parentId: string, subtasks: CreateTaskInput[], actor: string): Task[] {
  const parent = vault.getTask(parentId);
  const created = subtasks.map((s) =>
    createTask(vault, { project: parent.project, ...s, parent: parent.id }, actor),
  );
  appendLog(vault, parent.id, actor, `子タスクに分解: ${created.map((c) => toLink(c.id)).join(", ")}`);
  return created;
}

export interface UpdateFields {
  title?: string;
  assignee?: string | null;
  priority?: number | null;
  project?: string | null;
  parent?: string | null;
  depends_on?: string[];
  labels?: string[];
  due?: string | null;
}

/** status 以外のプロパティを変える（status は setStatus で） */
export function updateTask(vault: Vault, id: string, fields: UpdateFields, actor: string): Task {
  assertActor(actor);
  if (fields.assignee) assertActor(fields.assignee);
  return vault.withLock(`task-${normalizeRef(id).toUpperCase()}`, () => {
    const all = vault.listTasks();
    const t = vault.getTask(id);
    const ids = new Set(all.map((x) => x.id.toUpperCase()));
    const refs = [...(fields.depends_on ?? []), ...(fields.parent ? [fields.parent] : [])].map(normalizeRef);
    for (const ref of refs) {
      if (!ids.has(ref.toUpperCase())) throw new TaskmdError(`タスク ${ref} が見つかりません`, "not_found");
      if (ref.toUpperCase() === t.id.toUpperCase()) throw new TaskmdError("自分自身は参照できません", "invalid_input");
    }
    const changed: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      let v: unknown = value;
      if (key === "depends_on") v = (value as string[]).map(toLink);
      if (key === "parent" && value) v = toLink(value as string);
      t.set(key, v);
      changed.push(key);
    }
    if (!changed.length) return t;
    const check = TaskFrontmatterSchema.safeParse(t.data);
    if (!check.success) {
      throw new TaskmdError(`入力が不正です: ${formatZodIssues(check.error.issues)}`, "invalid_input");
    }
    addLog(t, vault, actor, `更新: ${changed.join(", ")}`);
    vault.saveTask(t);
    return t;
  });
}

// ---------------------------------------------------------------- 検証

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  id?: string;
  message: string;
}

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function validateVault(vault: Vault): ValidationIssue[] {
  const issues: ValidationIssue[] = vault
    .parseIssues()
    .map((p) => ({ level: "error" as const, path: p.path, message: p.message }));
  const all = vault.listTasks();
  const now = vault.now();
  const byId = new Map<string, Task>();

  for (const t of all) {
    const res = TaskFrontmatterSchema.safeParse(t.data);
    if (!res.success) {
      issues.push({ level: "error", path: t.path, id: t.id, message: formatZodIssues(res.error.issues) });
    }
    const key = t.id.toUpperCase();
    const dup = byId.get(key);
    if (dup) issues.push({ level: "error", path: t.path, id: t.id, message: `ID が ${dup.path} と重複しています` });
    else byId.set(key, t);
  }

  for (const t of all) {
    for (const d of t.dependsOn) {
      if (!byId.has(d.toUpperCase())) {
        issues.push({ level: "error", path: t.path, id: t.id, message: `depends_on の ${d} が見つかりません` });
      }
    }
    if (t.parent && !byId.has(t.parent.toUpperCase())) {
      issues.push({ level: "error", path: t.path, id: t.id, message: `parent の ${t.parent} が見つかりません` });
    }
    if (t.status === "done" && openChildren(t, all).length) {
      issues.push({ level: "error", path: t.path, id: t.id, message: "done なのに未完了の子タスクがあります" });
    }
    if ((t.status === "ready" || t.status === "in_progress") && openDependencies(t, all).length) {
      issues.push({
        level: "warning",
        path: t.path,
        id: t.id,
        message: `${t.status} ですが未完了の依存タスクがあります: ${openDependencies(t, all).join(", ")}`,
      });
    }
    if (t.status === "in_progress" && !isLeaseActive(t, now)) {
      issues.push({
        level: "warning",
        path: t.path,
        id: t.id,
        message: t.leaseBy ? `lease が切れています（${t.leaseBy}）` : "in_progress ですが lease がありません",
      });
    }
  }

  // 依存関係の循環
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const t = byId.get(id)!;
      issues.push({ level: "error", path: t.path, id: t.id, message: `依存関係が循環しています: ${cycle.join(" → ")}` });
      return;
    }
    state.set(id, "visiting");
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(d.toUpperCase())) visit(d.toUpperCase(), [...stack, id]);
    }
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);

  return issues;
}
