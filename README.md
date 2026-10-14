# taskmd

AIエージェントと人が**同じ Markdown ファイル**でタスクを管理するためのツールです。タスクは1ファイル1件の Markdown で、状態は frontmatter に持たせます。画面は Obsidian をそのまま使い、AI（Claude Code など）は MCP サーバ経由でタスクを読み、着手し、review に出します。

- mdファイルが唯一の正。DB は持たず、git で履歴を残す
- 状態遷移・依存関係・作業ロック（lease）のルールは、CLI と MCP で共通の中核ライブラリが守る
- AIは頼まれたときだけ動き、done にするのは人

設計の背景は [docs/architecture.md](docs/architecture.md) を参照してください。

## セットアップ

Node.js 20 以上が必要です。

```sh
git clone https://github.com/hirofumi-morita/manage-task-md.git
cd manage-task-md
npm install
npm run build
npm link          # taskmd と taskmd-mcp コマンドが使えるようになる
```

### vault を作る

```sh
taskmd init ~/tasks-vault
```

次のファイルができます。このフォルダを Obsidian で vault として開いてください。

```
tasks-vault/
├── AGENTS.md          # AI向けの運用ルール
├── CLAUDE.md          # AGENTS.md を読み込む
├── .mcp.json          # Claude Code に taskmd の MCP サーバを登録する
├── .taskmd/config.yaml
├── views/タスク.base  # Obsidian Bases のビュー（着手できる・作業中・レビュー待ち…）
├── templates/task.md
└── tasks/  runs/  inbox/  projects/  notes/
```

### Claude Code から使う

vault のフォルダで `claude` を起動すると、`.mcp.json` の `taskmd` サーバが使えます（初回は許可を求められます）。あとは普通に頼むだけです。

- 「T-0002 をやって」
- 「次のタスクを1つ進めて」
- 「T-0001 を3〜5個の子タスクに分解して」
- 「inbox を整理してタスクにして」

AI がどう動くかは `AGENTS.md` に書いてあり、vault ごとに書き換えられます。AI の名前は `.mcp.json` の `TASKMD_ACTOR`（既定 `agent:claude`）です。

## タスクファイル

```markdown
---
id: T-0002
aliases:
  - T-0002              # [[T-0002]] でリンクできるようにする
title: ログインAPIを実装する
status: in_progress     # backlog | ready | in_progress | review | done | blocked | cancelled
assignee: agent:claude  # human:名前 / agent:名前
priority: 2             # 1(高)〜4(低)
project: auth
parent: "[[T-0001]]"
depends_on:
  - "[[T-0003]]"
labels: []
due: 2026-10-20
lease_by: agent:claude  # 作業中のロック（claim で付き、review で外れる）
lease_until: 2026-10-14T08:00:00.000Z
lease_run: "[[runs/2026-10-14/T-0002-r1]]"
created: 2026-10-14T06:00:00.000Z
updated: 2026-10-14T06:30:00.000Z
---

## 目的
## 受け入れ条件
- [ ] /login が JWT を返す
## コンテキスト
## 作業ログ
- 2026-10-14 15:30 agent:claude 着手（ready → in_progress）。実行ログ: [[runs/2026-10-14/T-0002-r1]]
## 結果
```

### ルール

```
backlog → ready → in_progress → review → done
              ↘ blocked ↗          ↘ in_progress（差し戻し）
```

- 未完了の `depends_on` があるタスクは ready / in_progress にできません。作成時は自動で `blocked` になり、依存がすべて done（または cancelled）になると `ready` に戻ります。
- 未完了の子タスク（`parent` で指している）がある親は done にできず、`next` でも選ばれません。
- `claim` は lease を付けます（既定60分、`.taskmd/config.yaml` の `leaseMinutes`）。期限内は他のエージェントが着手できず、期限が切れたら引き継げます。
- エージェント（`agent:` で始まる操作者）は done にできません。`agentsCanComplete: true` で許可できます。
- `## 作業ログ` は追記のみです。
- ファイルを Obsidian で直接編集したら `taskmd validate` で検証できます。

## CLI

```
taskmd init [dir]
taskmd list [--status ready,blocked] [--assignee a] [--project p] [--label l] [--parent id] [--actionable]
taskmd show T-0002
taskmd new "タイトル" [--project p] [--priority 1-4] [--depends T-0001] [--parent T-0001] [--accept 条件 ...]
taskmd next [--assignee agent:claude]
taskmd claim T-0002
taskmd renew T-0002
taskmd status T-0002 blocked --note "API仕様待ち"
taskmd review T-0002 "要約"
taskmd done T-0002
taskmd log T-0002 "メモ"
taskmd validate
```

共通オプション: `--vault dir`、`--as human:名前`（既定は `$TASKMD_ACTOR` か `human:<OSのユーザー名>`）、`--json`。

## MCP ツール

| ツール | 内容 |
|---|---|
| `list_tasks` | 条件で一覧（`actionable` で着手できるものだけ） |
| `get_task` | ファイル全文と、未完了の依存・子タスク・lease の状態 |
| `next_task` | 次に着手すべき1件 |
| `claim_task` | 着手（lease を付けて in_progress、実行ログを作成） |
| `renew_lease` | lease の延長 |
| `append_log` | 作業ログに1行追記 |
| `submit_for_review` | 結果を書いて review に出す |
| `set_status` | ステータス変更（blocked にするときなど） |
| `create_task` / `split_task` / `update_task` | 作成・分解・プロパティ変更 |
| `validate_vault` | vault 全体の検証 |

## 開発

```sh
npm test          # vitest
npm run typecheck
npm run build
```

構成:

- `src/core/` パーサ・スキーマ・状態遷移などの中核。CLI・MCP・今後の Obsidian プラグインで共有する
- `src/cli/` `taskmd` コマンド
- `src/mcp/` `taskmd-mcp`（stdio の MCP サーバ）
- `vault-template/` `taskmd init` でコピーする雛形

## 今後

- Obsidian プラグイン（ID採番つきのタスク作成、ルールチェック付きのステータス変更、保存時の検証）
- Obsidian から「このタスクをAIに依頼」
