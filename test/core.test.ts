import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLog,
  appendToSection,
  claimTask,
  createTask,
  listTasks,
  nextTask,
  parseMarkdown,
  serializeMarkdown,
  setStatus,
  splitTask,
  submitForReview,
  taskDetail,
  updateTask,
  validateVault,
  Vault,
} from "../src/core/index.js";

const HUMAN = "human:hiro";
const AGENT = "agent:claude";

let dir: string;
let vault: Vault;
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskmd-"));
  vault = Vault.init(dir);
  clock = new Date("2026-10-14T06:00:00Z");
  vault.now = () => clock;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("markdown", () => {
  it("frontmatter のコメントとキー順を保ったまま書き戻す", () => {
    const src = "---\n# メモ\ntitle: a\nstatus: ready # 状態\n---\n\n本文\n";
    const f = parseMarkdown(src);
    f.doc.set("status", "done");
    expect(serializeMarkdown(f)).toBe("---\n# メモ\ntitle: a\nstatus: done # 状態\n---\n\n本文\n");
  });

  it("セクションの末尾に追記し、次のセクションを壊さない", () => {
    const body = "\n## 作業ログ\n\n- a\n\n## 結果\n\nok\n";
    expect(appendToSection(body, "作業ログ", "- b")).toBe("\n## 作業ログ\n\n- a\n- b\n\n## 結果\n\nok\n");
  });
});

describe("タスクの作成", () => {
  it("ID を採番し、テンプレートから Obsidian で読めるファイルを作る", () => {
    const t = createTask(vault, { title: "ログインAPIを実装する", acceptance: ["JWT を返す"] }, HUMAN);
    expect(t.id).toBe("T-0001");
    expect(t.path).toBe("tasks/T-0001-ログインAPIを実装する.md");
    const text = readFileSync(join(dir, t.path), "utf8");
    expect(text).toContain("aliases:\n  - T-0001");
    expect(text).toContain("- [ ] JWT を返す");
    expect(text).toMatch(/## 作業ログ\n\n- 2026-10-14 \d\d:\d\d human:hiro 作成（ready）/);
    expect(createTask(vault, { title: "次" }, HUMAN).id).toBe("T-0002");
  });

  it("未完了の依存があれば blocked で作り、依存が done になると ready に戻す", () => {
    const a = createTask(vault, { title: "A" }, HUMAN);
    const b = createTask(vault, { title: "B", depends_on: [a.id] }, HUMAN);
    expect(b.status).toBe("blocked");
    expect(readFileSync(join(dir, b.path), "utf8")).toContain('depends_on:\n  - "[[T-0001]]"');

    claimTask(vault, a.id, AGENT);
    submitForReview(vault, a.id, AGENT, "やった");
    setStatus(vault, a.id, "done", { actor: HUMAN });
    expect(vault.getTask(b.id).status).toBe("ready");
  });

  it("存在しない依存は拒否する", () => {
    expect(() => createTask(vault, { title: "x", depends_on: ["T-0099"] }, HUMAN)).toThrow(/見つかりません/);
  });
});

describe("着手から review まで", () => {
  it("claim で lease と実行ログを作り、review で結果を書いて lease を外す", () => {
    const t = createTask(vault, { title: "作業" }, HUMAN);
    const { task, runPath } = claimTask(vault, t.id, AGENT);
    expect(task.status).toBe("in_progress");
    expect(task.assignee).toBe(AGENT);
    expect(task.leaseUntil?.toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(runPath).toMatch(/^runs\/2026-10-14\/T-0001-r1\.md$/);

    expect(() => claimTask(vault, t.id, "agent:other")).toThrow(/作業中/);

    const done = submitForReview(vault, t.id, AGENT, "API を実装した\n詳細は PR #1");
    expect(done.status).toBe("review");
    expect(done.leaseBy).toBeUndefined();
    const text = readFileSync(join(dir, done.path), "utf8");
    expect(text).toContain("## 結果\n\nAPI を実装した\n詳細は PR #1\n");
    expect(text).not.toContain("lease_by");
    expect(readFileSync(join(dir, runPath), "utf8")).toContain("status: review");
  });

  it("lease が切れたら別のエージェントが引き継げる", () => {
    const t = createTask(vault, { title: "作業" }, HUMAN);
    claimTask(vault, t.id, AGENT);
    clock = new Date("2026-10-14T07:01:00Z");
    const r = claimTask(vault, t.id, "agent:other");
    expect(r.task.leaseBy).toBe("agent:other");
    expect(r.runPath).toMatch(/T-0001-r2\.md$/);
  });

  it("エージェントは done にできない", () => {
    const t = createTask(vault, { title: "作業" }, HUMAN);
    claimTask(vault, t.id, AGENT);
    submitForReview(vault, t.id, AGENT, "済");
    expect(() => setStatus(vault, t.id, "done", { actor: AGENT })).toThrow(/review/);
    expect(setStatus(vault, t.id, "done", { actor: HUMAN }).status).toBe("done");
  });

  it("許可されていない遷移は拒否し、force なら通す", () => {
    const t = createTask(vault, { title: "作業" }, HUMAN);
    expect(() => setStatus(vault, t.id, "done", { actor: HUMAN })).toThrow(/変えられません/);
    expect(setStatus(vault, t.id, "done", { actor: HUMAN, force: true }).status).toBe("done");
  });
});

describe("分解と子タスク", () => {
  it("子タスクが残っている親は done にできない", () => {
    const p = createTask(vault, { title: "親", project: "auth" }, HUMAN);
    const [c1, c2] = splitTask(vault, p.id, [{ title: "子1" }, { title: "子2" }], AGENT);
    expect(c1!.parent).toBe(p.id);
    expect(c1!.project).toBe("auth");
    expect(taskDetail(vault, p.id).children.map((c) => c.id)).toEqual([c1!.id, c2!.id]);

    claimTask(vault, p.id, HUMAN);
    submitForReview(vault, p.id, HUMAN, "まとめ");
    expect(() => setStatus(vault, p.id, "done", { actor: HUMAN })).toThrow(/子タスク/);
    setStatus(vault, c1!.id, "cancelled", { actor: HUMAN });
    setStatus(vault, c2!.id, "cancelled", { actor: HUMAN });
    expect(setStatus(vault, p.id, "done", { actor: HUMAN }).status).toBe("done");
  });
});

describe("一覧と次のタスク", () => {
  it("優先度順に、担当が自分のものを優先して選ぶ", () => {
    createTask(vault, { title: "低", priority: 4 }, HUMAN);
    const high = createTask(vault, { title: "高", priority: 1 }, HUMAN);
    const mine = createTask(vault, { title: "自分の", priority: 3, assignee: AGENT }, HUMAN);
    createTask(vault, { title: "他人の", priority: 1, assignee: "human:hiro" }, HUMAN);

    expect(nextTask(vault)?.id).toBe(high.id);
    expect(nextTask(vault, { assignee: AGENT })?.id).toBe(mine.id);
    expect(listTasks(vault, { status: ["ready"] }).map((t) => t.title)).toEqual(["高", "他人の", "自分の", "低"]);
  });
});

describe("更新と検証", () => {
  it("update_task はプロパティを変えてログを残す", () => {
    const a = createTask(vault, { title: "A" }, HUMAN);
    const b = createTask(vault, { title: "B" }, HUMAN);
    const t = updateTask(vault, b.id, { depends_on: [a.id], priority: 1, due: "2026-10-20" }, AGENT);
    expect(t.dependsOn).toEqual([a.id]);
    expect(t.body).toContain("更新: depends_on, priority, due");
    expect(() => updateTask(vault, b.id, { due: "来週" }, AGENT)).toThrow(/YYYY-MM-DD/);
  });

  it("手で壊したファイルや循環を見つける", () => {
    const a = createTask(vault, { title: "A" }, HUMAN);
    const b = createTask(vault, { title: "B", depends_on: [a.id] }, HUMAN);
    // 人が Obsidian で直接 A → B の依存を足して循環させた
    const p = join(dir, a.path);
    writeFileSync(p, readFileSync(p, "utf8").replace("depends_on: []", 'depends_on:\n  - "[[T-0002]]"'));
    writeFileSync(join(dir, "tasks", "broken.md"), "---\nid: T-0009\nstatus: doing\n---\n");

    const issues = validateVault(vault);
    expect(issues.some((i) => i.message.includes("循環"))).toBe(true);
    expect(issues.some((i) => i.path === "tasks/broken.md" && i.level === "error")).toBe(true);
    expect(b.id).toBe("T-0002");
  });

  it("作業ログは追記のみ", () => {
    const t = createTask(vault, { title: "A" }, HUMAN);
    appendLog(vault, t.id, AGENT, "調べた");
    appendLog(vault, t.id, AGENT, "直した");
    const log = readFileSync(join(dir, t.path), "utf8").split("## 作業ログ")[1]!.split("## 結果")[0]!;
    expect(log.trim().split("\n").map((l) => l.replace(/^- \S+ \S+ /, ""))).toEqual([
      "human:hiro 作成（ready）",
      "agent:claude 調べた",
      "agent:claude 直した",
    ]);
  });
});

describe("子タスクのある親", () => {
  it("next_task は未完了の子がある親を選ばない", () => {
    const p = createTask(vault, { title: "親", priority: 1 }, HUMAN);
    const [c] = splitTask(vault, p.id, [{ title: "子", priority: 2 }], AGENT);
    expect(nextTask(vault)?.id).toBe(c!.id);
  });
});
