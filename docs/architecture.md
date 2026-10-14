# AIタスク管理・オーケストレーション用 mdツール 構成案

## 前提（仮置き）

- 個人利用。ローカルのフォルダ（vault）で完結し、git で履歴管理する。
- AIは Claude（Claude Code / Claude Agent SDK）を主に想定。ほかのエージェントでも使えるよう、連携は MCP と CLI に寄せる。

## 決定事項（2026-10-14）

- **UIは Obsidian ベース**。専用アプリは作らず、Obsidian のプラグインと Bases で補う。
- **AIは頼まれたときだけ動く**。常駐して自動でタスクを拾う仕組みは作らない（将来の拡張候補として残す）。

## 基本方針

1. **mdファイルが唯一の正（source of truth）**。DBはあくまで検索用のキャッシュで、消しても md から再生成できる。
2. **人もAIも同じファイルを触る**。AIは専用ツール（MCP）経由でも、ファイル直接編集でも動けるようにし、スキーマ検証で壊れた状態を防ぐ。
3. **ツール本体は薄く作る**。中核は「パーサ＋スキーマ＋状態遷移ルール」のライブラリで、CLI・MCPサーバ・UI はその上に載る。

## フォルダ構成

```
vault/
├── AGENTS.md              # AI向けの運用ルール（CLAUDE.md からも参照）
├── .taskmd/
│   ├── config.yaml        # ステータス定義、ID採番、エージェント設定
│   ├── schema.json        # frontmatter の JSON Schema
│   └── index.sqlite       # 検索キャッシュ（.gitignore）
├── inbox/                 # 思いつきメモ。AIが整理してタスク化する
├── projects/
│   └── <project-slug>.md  # プロジェクトの目的・方針・関連タスクのリンク
├── tasks/
│   └── T-0042-login-api.md  # タスクは1ファイル1件、フラットに置く
├── runs/
│   └── 2026-10-14/T-0042-r1.md  # AIの実行ログ（1回の作業＝1ファイル）
├── notes/                 # 調査メモ・設計メモなど自由なナレッジ
└── templates/
    └── task.md
```

- ステータスはフォルダではなく frontmatter で持つ（ファイル移動が起きず、リンクやgit差分が壊れない）。
- ファイル名は `ID-slug.md`。リンクは Obsidian 互換の `[[T-0042]]` を使う。

## タスクファイルの設計

```markdown
---
id: T-0042
title: ログインAPIを実装する
status: ready          # backlog | ready | in_progress | review | done | blocked | cancelled
assignee: agent:claude # human:hiro / agent:claude / 空欄
priority: 2            # 1(高)〜4(低)
project: auth-renewal
parent: T-0040         # 親タスク（分解したとき）
depends_on: [T-0041]   # 全部 done になるまで ready にならない
labels: [backend]
due: 2026-10-20
lease:                 # 作業中のロック。期限切れなら他が奪える
  by: agent:claude#run-7
  until: 2026-10-14T08:00:00Z
created: 2026-10-14T06:00:00Z
updated: 2026-10-14T06:30:00Z
---

## 目的
なぜやるのか、1〜3行。

## 受け入れ条件
- [ ] /login が JWT を返す
- [ ] 失敗時に 401

## コンテキスト
- 方針: [[auth-renewal]]
- 参考: [[notes/jwt-調査]]

## 作業ログ
<!-- 追記のみ。人もAIも末尾に足す -->
- 2026-10-14 06:30 agent:claude 着手。[[runs/2026-10-14/T-0042-r1]]

## 結果
完了時の要約、成果物（PR・ファイル）へのリンク。
```

ポイントは、AIが判断に使う情報を「受け入れ条件」と「コンテキスト」に集めること、そして作業ログを追記専用にして履歴を壊さないことです。

## オーケストレーションの仕組み

状態遷移を中核ライブラリで強制します。

```
backlog → ready → in_progress → review → done
              ↘ blocked ↗          ↘ in_progress（差し戻し）
```

- **ready 判定**: `depends_on` がすべて done なら自動で ready。
- **claim（着手）**: エージェントは `lease` を書き込んで in_progress にする。lease の期限切れで自動解放するので、AIが途中で落ちても詰まらない。
- **分解**: 大きいタスクはAIが子タスク（`parent` 付き）を作り、親は子が全部 done になるまで done にできない。
- **review**: AIの完了は review まで。人が確認して done にする（自動 done にするかは設定で選べる）。
- **実行ログ**: 1回の作業ごとに `runs/` にログを残し、タスクの作業ログからリンクする。何をしたか後から追える。

## AIエージェント連携

3つの入口を用意し、すべて同じ中核ライブラリを通します。

1. **MCPサーバ**（主役）: Claude Code / Claude Desktop などから使うツール群。
   - `list_tasks(filter)` / `get_task(id)` / `next_task(assignee)`
   - `claim_task(id)` / `update_task(id, fields)` / `append_log(id, text)`
   - `create_task(...)` / `split_task(id, subtasks)` / `submit_for_review(id, summary)`
2. **CLI**（`taskmd`）: MCPと同じ操作をコマンドで。フックやシェルスクリプト、cron から使う。
3. **ファイル直接編集**: AIが普通に md を書いても成立するように、`AGENTS.md` に規約を書き、保存時と pre-commit でスキーマ検証する。

**AIの起動は人が行います**。典型的な流れは次の通りです。

- Claude Code で「T-0042 をやって」「次の ready タスクを1つ進めて」と頼む → MCP で claim → 作業 → review に出して止まる。
- 「inbox を整理してタスク化して」「T-0040 を分解して」のような整理・計画の依頼も同じ入口で受ける。
- Obsidian 側からも頼めるように、プラグインのコマンドで「このタスクをAIに依頼」→ `claude -p` をタスクIDつきで起動できるようにする（任意）。

将来、自動実行（ready タスクを常駐プロセスが拾う）を足す場合も、同じ MCP / CLI の上に載せられる設計にしておきます。

## UI（Obsidian ベース）

自作アプリは作らず、Obsidian を画面として使います。足りない部分は小さな Obsidian プラグインで補います。

- **そのまま使える部分**: frontmatter は Properties として編集できます。一覧・カンバン的な表示は Bases（コア機能）で `status` 別・`project` 別のビューを `.base` ファイルとして vault に置きます。リンク・バックリンク・グラフで依存関係もたどれます。
- **自作プラグイン（taskmd-obsidian）で足すもの**:
  - タスク新規作成コマンド（ID自動採番、テンプレート適用）
  - ステータス変更コマンド（状態遷移ルールをチェックし、不正な遷移は拒否）
  - 保存時のスキーマ検証と警告表示
  - 「このタスクをAIに依頼」コマンド（任意）
  - ロジックは `packages/core` を共有し、CLI・MCP と同じルールで動かす
- **外部からの変更**: AI や git が md を書き換えても Obsidian が自動で再読み込みするので、特別な同期は不要です。

## 技術スタック

| 層 | 推奨 |
|---|---|
| 言語 | TypeScript（Node.js または Bun） |
| md パース | gray-matter（frontmatter）、remark / unified（本文・リンク解析） |
| スキーマ | zod（JSON Schema も生成して AI と pre-commit で共有） |
| ファイル監視 | chokidar |
| インデックス | SQLite（better-sqlite3）。全文検索は FTS5 |
| AI連携 | @modelcontextprotocol/sdk、Claude Agent SDK |
| 履歴・競合 | git（自動コミットはオプション） |
| UI | Obsidian ＋ 自作プラグイン（Obsidian Plugin API、TypeScript） |

モノレポ構成の例: `packages/core`（パーサ・スキーマ・状態遷移）、`packages/cli`、`packages/mcp-server`、`packages/obsidian-plugin`。

## 進め方（MVP）

1. **core ＋ CLI**: スキーマ、パース、状態遷移、ready 判定、lease、インデックス。
2. **MCPサーバ**: Claude Code から「T-0042 をやって」「次のタスクを進めて」と頼んで、review に出すところまで回ることを確認。
3. **vault 雛形**: フォルダ、テンプレート、`AGENTS.md`、Bases のビュー（カンバン・プロジェクト別）。
4. **Obsidian プラグイン**: 作成・ステータス変更・検証コマンド。
5. 日常運用しながら改善。自動実行は必要になったら検討。
