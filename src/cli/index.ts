#!/usr/bin/env node
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import {
  appendLog,
  claimTask,
  createTask,
  listTasks,
  nextTask,
  renewLease,
  setStatus,
  STATUSES,
  submitForReview,
  summarize,
  taskDetail,
  TaskmdError,
  validateVault,
  Vault,
  type Status,
  type Task,
} from "../core/index.js";

const HELP = `taskmd — Markdown ファイルでタスクを管理する

使い方: taskmd <コマンド> [引数] [オプション]

コマンド:
  init [dir]                    vault を作る（既定は今のフォルダ）
  list                          タスク一覧
      --status s[,s]  --assignee a  --project p  --label l  --parent id  --actionable
  show <id>                     タスクの中身と依存・子タスクの状態
  new <title>                   タスクを作る
      --project p  --assignee a  --priority 1-4  --depends id[,id]  --parent id
      --label l[,l]  --due YYYY-MM-DD  --status s  --goal 文  --accept 条件（複数可）
  next                          次に着手すべきタスク  [--assignee a] [--project p]
  claim <id>                    着手する（lease を付けて in_progress に）  [--force]
  renew <id>                    lease を延長する
  status <id> <status>          ステータスを変える  [--note 文] [--force]
  review <id> <summary>         review に出す
  done <id>                     done にする（status <id> done と同じ）
  log <id> <text>               作業ログに1行追記する
  validate                      vault 全体を検証する（エラーがあれば終了コード 1）

共通オプション:
  --vault dir   vault の場所（既定は今のフォルダから上にたどって .taskmd/ を探す）
  --as actor    操作する人（既定は $TASKMD_ACTOR か human:<ユーザー名>）
  --json        JSON で出力
`;

function fail(msg: string): never {
  process.stderr.write(`エラー: ${msg}\n`);
  process.exit(1);
}

function list(v: string | undefined): string[] | undefined {
  return v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function line(t: Task): string {
  const parts = [t.id.padEnd(8), `[${t.status}]`.padEnd(14), t.title];
  const meta = [t.assignee, t.project && `#${t.project}`, t.due && `〆${t.due}`, t.priority && `P${t.priority}`].filter(Boolean);
  return meta.length ? `${parts.join(" ")}  (${meta.join(" ")})` : parts.join(" ");
}

function main(argv: string[]): void {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      vault: { type: "string" },
      as: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      status: { type: "string" },
      assignee: { type: "string" },
      project: { type: "string" },
      label: { type: "string" },
      parent: { type: "string" },
      actionable: { type: "boolean" },
      priority: { type: "string" },
      depends: { type: "string" },
      due: { type: "string" },
      goal: { type: "string" },
      accept: { type: "string", multiple: true },
      note: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || o.help) {
    process.stdout.write(HELP);
    return;
  }
  const actor = o.as ?? process.env.TASKMD_ACTOR ?? `human:${userInfo().username.replace(/[^\w.@-]/g, "_")}`;
  const out = (human: string, json: unknown) =>
    process.stdout.write((o.json ? JSON.stringify(json, null, 2) : human) + "\n");
  const need = (i: number, name: string): string => args[i] ?? fail(`${name} を指定してください`);

  if (cmd === "init") {
    const v = Vault.init(args[0] ?? o.vault ?? ".");
    out(`vault を作りました: ${v.root}`, { root: v.root });
    return;
  }

  const vault = Vault.open(o.vault);
  switch (cmd) {
    case "list": {
      const statuses = list(o.status) as Status[] | undefined;
      for (const s of statuses ?? []) if (!STATUSES.includes(s)) fail(`不明なステータスです: ${s}`);
      const tasks = listTasks(vault, {
        status: statuses,
        assignee: o.assignee,
        project: o.project,
        label: o.label,
        parent: o.parent,
        actionable: o.actionable,
      });
      out(tasks.map(line).join("\n") || "（該当するタスクはありません）", tasks.map(summarize));
      return;
    }
    case "show": {
      const d = taskDetail(vault, need(0, "タスクID"));
      const extra = [
        d.open_dependencies.length ? `未完了の依存: ${d.open_dependencies.join(", ")}` : "",
        d.children.length ? `子タスク: ${d.children.map((c) => `${c.id}[${c.status}]`).join(", ")}` : "",
        d.lease ? `lease: ${d.lease.by} 〜${d.lease.until}${d.lease.active ? "" : "（期限切れ）"}` : "",
      ].filter(Boolean);
      out(`# ${d.path}\n${extra.length ? extra.join("\n") + "\n" : ""}\n${d.markdown}`, d);
      return;
    }
    case "new": {
      const t = createTask(
        vault,
        {
          title: args.join(" ") || fail("タイトルを指定してください"),
          project: o.project,
          assignee: o.assignee,
          priority: o.priority ? Number(o.priority) : undefined,
          depends_on: list(o.depends),
          parent: o.parent,
          labels: list(o.label),
          due: o.due,
          status: o.status as Status | undefined,
          goal: o.goal,
          acceptance: o.accept,
        },
        actor,
      );
      out(`作成しました: ${line(t)}\n  ${t.path}`, summarize(t));
      return;
    }
    case "next": {
      const t = nextTask(vault, { assignee: o.assignee, project: o.project });
      out(t ? line(t) : "（着手できるタスクはありません）", t ? summarize(t) : null);
      return;
    }
    case "claim": {
      const r = claimTask(vault, need(0, "タスクID"), actor, { force: o.force });
      out(`着手しました: ${line(r.task)}\n  実行ログ: ${r.runPath}`, { ...summarize(r.task), run: r.runPath });
      return;
    }
    case "renew": {
      const t = renewLease(vault, need(0, "タスクID"), actor);
      out(`lease を延長しました: ${t.id} 〜${t.leaseUntil?.toISOString()}`, summarize(t));
      return;
    }
    case "status":
    case "done": {
      const id = need(0, "タスクID");
      const to = (cmd === "done" ? "done" : need(1, "ステータス")) as Status;
      const t = setStatus(vault, id, to, { actor, note: o.note, force: o.force });
      out(`変更しました: ${line(t)}`, summarize(t));
      return;
    }
    case "review": {
      const t = submitForReview(vault, need(0, "タスクID"), actor, args.slice(1).join(" ") || fail("要約を指定してください"));
      out(`review に出しました: ${line(t)}`, summarize(t));
      return;
    }
    case "log": {
      const t = appendLog(vault, need(0, "タスクID"), actor, args.slice(1).join(" "));
      out(`追記しました: ${t.id}`, summarize(t));
      return;
    }
    case "validate": {
      const issues = validateVault(vault);
      const errors = issues.filter((i) => i.level === "error");
      out(
        issues.length
          ? issues.map((i) => `${i.level === "error" ? "✗" : "!"} ${i.path}: ${i.message}`).join("\n")
          : "問題はありません",
        issues,
      );
      if (errors.length) process.exitCode = 1;
      return;
    }
    default:
      fail(`不明なコマンドです: ${cmd}（taskmd --help で一覧）`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof TaskmdError || (e as Error).name === "ZodError") fail((e as Error).message);
  if ((e as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS")) fail((e as Error).message);
  throw e;
}
