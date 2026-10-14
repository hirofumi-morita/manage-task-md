import { z } from "zod";

export const STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];

/** 許可する状態遷移。ここにない遷移は force なしでは拒否する。 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  backlog: ["ready", "blocked", "cancelled"],
  ready: ["in_progress", "backlog", "blocked", "cancelled"],
  in_progress: ["review", "ready", "blocked", "cancelled"],
  review: ["done", "in_progress"],
  blocked: ["ready", "backlog", "cancelled"],
  done: ["ready"],
  cancelled: ["backlog"],
};

/** 後続タスクの前提として「片付いた」とみなす状態 */
export const CLOSED_STATUSES: readonly Status[] = ["done", "cancelled"];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で書いてください");
const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/, "ISO 8601 の日時で書いてください");
/** タスク参照。`T-0042` でも Obsidian リンクの `[[T-0042]]` でもよい */
const taskRef = z.string().regex(/^(\[\[)?[A-Za-z]+-\d+(\|[^\]]*)?(\]\])?$/, "T-0042 か [[T-0042]] の形で書いてください");

export const ACTOR_RE = /^(human|agent):[\w.@-]+$/;

export const TaskFrontmatterSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z]+-\d+$/, "ID は T-0042 の形で書いてください"),
    title: z.string().min(1),
    status: z.enum(STATUSES),
    assignee: z.string().regex(ACTOR_RE, "human:名前 か agent:名前 の形で書いてください").nullish(),
    priority: z.number().int().min(1).max(4).nullish(),
    project: z.string().nullish(),
    parent: taskRef.nullish(),
    depends_on: z.array(taskRef).nullish(),
    labels: z.array(z.string()).nullish(),
    due: isoDate.nullish(),
    lease_by: z.string().nullish(),
    lease_until: isoDateTime.nullish(),
    lease_run: z.string().nullish(),
    aliases: z.array(z.string()).nullish(),
    created: isoDateTime.nullish(),
    updated: isoDateTime.nullish(),
  })
  .passthrough();

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

/** `[[T-0042|表示名]]` → `T-0042` */
export function normalizeRef(ref: string): string {
  return ref.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/\|.*$/, "").trim();
}

/** Obsidian でリンクになる形で保存する */
export function toLink(id: string): string {
  return `[[${normalizeRef(id)}]]`;
}
