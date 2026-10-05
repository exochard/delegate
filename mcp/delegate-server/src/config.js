import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_WORKER } from "./worker.js";

export const DEFAULT_MODEL = "opencode/mimo-v2.5-free";

export const DEFAULT_CONFIG = {
  worker: DEFAULT_WORKER,
  // A null default lets opencode pick its own model, which can hang for minutes on a
  // fresh install with no configured provider. Pin a free, verified-responsive model so
  // delegate_start works out of the box; override via delegate_config_set. Verify before
  // re-pinning: the opencode catalog retires free models without notice — the previous
  // pin (deepseek-v4-flash-free) started failing with "Unexpected server error" once
  // delisted, and `opencode models` is the ground truth.
  defaultModel: DEFAULT_MODEL,
  maxIterations: 3,
  gatherModel: "pro",
  verifyCommand: null,
  workerPermissions: {
    bash: true,
    read: true,
    edit: true,
    glob: true,
    grep: true,
    webfetch: false,
    task: false,
    todowrite: true,
    websearch: false,
    lsp: true,
    skill: false,
  },
};

export function configPath(repoRoot) {
  return path.join(repoRoot, ".claude", "delegate", "config.json");
}

export async function loadConfig(repoRoot) {
  try {
    const raw = await readFile(configPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      workerPermissions: { ...DEFAULT_CONFIG.workerPermissions, ...(parsed.workerPermissions ?? {}) },
    };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveConfig(repoRoot, config) {
  await mkdir(path.dirname(configPath(repoRoot)), { recursive: true });
  await writeFile(configPath(repoRoot), JSON.stringify(config, null, 2));
}
