import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const ConfigSchema = z.object({
  /** タスクIDの接頭辞（T-0042 の T） */
  idPrefix: z.string().regex(/^[A-Za-z]+$/).default("T"),
  /** 連番の桁数 */
  idDigits: z.number().int().min(1).max(8).default(4),
  /** claim したときのロック時間（分） */
  leaseMinutes: z.number().int().positive().default(60),
  tasksDir: z.string().default("tasks"),
  runsDir: z.string().default("runs"),
  templatesDir: z.string().default("templates"),
  /** エージェントが done にしてよいか。false なら review で止まり、人が done にする */
  agentsCanComplete: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_DIR = ".taskmd";
export const CONFIG_FILE = "config.yaml";

export function loadConfig(root: string): Config {
  const path = join(root, CONFIG_DIR, CONFIG_FILE);
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) ?? {}) : {};
  return ConfigSchema.parse(raw);
}
