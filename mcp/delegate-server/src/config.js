import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_WORKER } from "./worker.js";

export const DEFAULT_CONFIG = {
  worker: DEFAULT_WORKER,
  defaultModel: null,
  maxIterations: 3,
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
