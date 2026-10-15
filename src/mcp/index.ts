#!/usr/bin/env node
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ACTOR_RE,
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
  updateTask,
  validateVault,
  Vault,
  splitTask,
} from "../core/index.js";

const { values: args } = parseArgs({
  options: { vault: { type: "string" }, actor: { type: "string" } },
});

const vault = Vault.open(args.vault);
const defaultActor = args.actor ?? process.env.TASKMD_ACTOR ?? "agent:claude";
if (!ACTOR_RE.test(defaultActor)) throw new Error(`TASKMD_ACTOR は agent:名前 の形で指定してください: ${defaultActor}`);

const server = new McpServer(
  { name: "taskmd", version: "0.1.0" },
  {
    instructions:
      "Markdown のタスク vault を操作するツールです。頼まれたタスクだけを扱い、get_task → claim_task → 作業 → submit_for_review の順に進めてください。done にするのは人です。",
  },
);

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function run(fn: () => unknown): Result {
  try {
    const value = fn();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (e) {
    if (e instanceof TaskmdError) {
      return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true };
    }
    throw e;
  }
}

const status = z.enum(STATUSES);
const taskId = z.string().describe("タスクID（例: T-0042）");
const actor = z
  .string()
  .regex(ACTOR_RE)
  .optional()
  .describe(`操作者（agent:名前 / human:名前）。省略時は ${defaultActor}`);
const subtask = z.object({
  title: z.string(),
  goal: z.string().optional().describe("目的（なぜやるのか）"),
  acceptance: z.array(z.string()).optional().describe("受け入れ条件。1要素が1つのチェックボックスになる"),
  context: z.string().optional().describe("コンテキスト。関連ノートへの [[リンク]] など"),
  assignee: z.string().regex(ACTOR_RE).optional(),
  priority: z.number().int().min(1).max(4).optional().describe("1(高)〜4(低)。既定は 3"),
  project: z.string().optional(),
  depends_on: z.array(z.string()).optional().describe("先に終わっている必要があるタスクのID"),
  labels: z.array(z.string()).optional(),
  due: z.string().optional().describe("期日 YYYY-MM-DD"),
});

server.registerTool(
  "list_tasks",
  {
    description: "タスクを一覧する。条件を組み合わせて絞り込める。",
    inputSchema: {
      status: z.array(status).optional(),
      assignee: z.string().optional(),
      project: z.string().optional(),
      label: z.string().optional(),
      parent: z.string().optional().describe("この親タスクの子だけ"),
      actionable: z.boolean().optional().describe("今すぐ着手できるもの（ready・依存完了・ロックなし・未完了の子なし）だけ"),
    },
  },
  async (a) => run(() => listTasks(vault, a).map(summarize)),
);

server.registerTool(
  "get_task",
  {
    description: "タスクのファイル全文と、未完了の依存・子タスク・lease の状態を返す。着手前に必ず読む。",
    inputSchema: { id: taskId },
  },
  async ({ id }) => run(() => taskDetail(vault, id)),
);

server.registerTool(
  "next_task",
  {
    description: "次に着手すべきタスクを1件返す（優先度・期日順）。着手はしないので、続けて claim_task を呼ぶ。",
    inputSchema: {
      assignee: z.string().optional().describe(`この担当のものと担当なしのものから選ぶ。既定は ${defaultActor}`),
      project: z.string().optional(),
    },
  },
  async (a) =>
    run(() => {
      const t = nextTask(vault, { assignee: a.assignee ?? defaultActor, project: a.project });
      return t ? summarize(t) : "着手できるタスクはありません";
    }),
);

server.registerTool(
  "claim_task",
  {
    description:
      "タスクに着手する。lease（作業中のロック）を付けて in_progress にし、runs/ に実行ログファイルを作る。返ってくる run のファイルに作業メモを書く。",
    inputSchema: { id: taskId, actor },
  },
  async ({ id, actor: a }) =>
    run(() => {
      const r = claimTask(vault, id, a ?? defaultActor);
      return { ...summarize(r.task), run: r.runPath, lease_until: r.task.leaseUntil?.toISOString() };
    }),
);

server.registerTool(
  "renew_lease",
  {
    description: "作業中のタスクの lease を延長する。長い作業の途中で呼ぶ。",
    inputSchema: { id: taskId, actor },
  },
  async ({ id, actor: a }) =>
    run(() => {
      const t = renewLease(vault, id, a ?? defaultActor);
      return { id: t.id, lease_until: t.leaseUntil?.toISOString() };
    }),
);

server.registerTool(
  "append_log",
  {
    description: "タスクの「作業ログ」に1行追記する。判断の理由や途中経過を残す。",
    inputSchema: { id: taskId, text: z.string(), actor },
  },
  async ({ id, text, actor: a }) => run(() => summarize(appendLog(vault, id, a ?? defaultActor, text))),
);

server.registerTool(
  "submit_for_review",
  {
    description:
      "作業を終えて review に出す。summary はタスクの「結果」と実行ログに書かれる。何をしたか・成果物へのリンク・残課題を含める。",
    inputSchema: { id: taskId, summary: z.string(), actor },
  },
  async ({ id, summary, actor: a }) => run(() => summarize(submitForReview(vault, id, a ?? defaultActor, summary))),
);

server.registerTool(
  "set_status",
  {
    description:
      "ステータスを変える（遷移ルールと依存関係をチェックする）。進められないときは blocked にして note に理由を書く。エージェントは done にできない。",
    inputSchema: { id: taskId, status, note: z.string().optional(), actor },
  },
  async ({ id, status: to, note, actor: a }) =>
    run(() => summarize(setStatus(vault, id, to, { actor: a ?? defaultActor, note }))),
);

server.registerTool(
  "create_task",
  {
    description: "タスクを作る。未完了の依存があれば自動で blocked になる。",
    inputSchema: {
      ...subtask.shape,
      parent: z.string().optional(),
      status: status.optional().describe("既定は ready（依存が未完了なら blocked）"),
      actor,
    },
  },
  async ({ actor: a, ...input }) => run(() => summarize(createTask(vault, input, a ?? defaultActor))),
);

server.registerTool(
  "split_task",
  {
    description: "大きいタスクを子タスクに分解する。親は子がすべて完了するまで done にできない。",
    inputSchema: { id: taskId.describe("親タスクのID"), subtasks: z.array(subtask).min(1), actor },
  },
  async ({ id, subtasks, actor: a }) => run(() => splitTask(vault, id, subtasks, a ?? defaultActor).map(summarize)),
);

server.registerTool(
  "update_task",
  {
    description: "status 以外のプロパティを変える。null を渡すと空にする。",
    inputSchema: {
      id: taskId,
      title: z.string().optional(),
      assignee: z.string().regex(ACTOR_RE).nullable().optional(),
      priority: z.number().int().min(1).max(4).nullable().optional(),
      project: z.string().nullable().optional(),
      parent: z.string().nullable().optional(),
      depends_on: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      due: z.string().nullable().optional(),
      actor,
    },
  },
  async ({ id, actor: a, ...fields }) => run(() => summarize(updateTask(vault, id, fields, a ?? defaultActor))),
);

server.registerTool(
  "validate_vault",
  {
    description: "vault 全体を検証する（frontmatter の形式、ID 重複、存在しない参照、依存の循環、lease 切れなど）。ファイルを直接編集したあとに呼ぶ。",
    inputSchema: {},
  },
  async () =>
    run(() => {
      const issues = validateVault(vault);
      return issues.length ? issues : "問題はありません";
    }),
);

await server.connect(new StdioServerTransport());
