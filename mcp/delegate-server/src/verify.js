import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function detectFromPackageJson(worktreePath) {
  const pkg = await readJsonIfExists(path.join(worktreePath, "package.json"));
  if (!pkg || !pkg.scripts) return [];
  const commands = [];
  for (const scriptName of ["test", "build", "lint"]) {
    if (pkg.scripts[scriptName]) {
      commands.push({ name: `npm run ${scriptName}`, command: ["npm", "run", scriptName] });
    }
  }
  return commands;
}

async function detectFromMakefile(worktreePath) {
  const makefilePath = path.join(worktreePath, "Makefile");
  if (!(await exists(makefilePath))) return [];
  const contents = await readFile(makefilePath, "utf8");
  const targets = new Set(
    [...contents.matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((m) => m[1])
  );
  const commands = [];
  for (const target of ["test", "build", "lint"]) {
    if (targets.has(target)) {
      commands.push({ name: `make ${target}`, command: ["make", target] });
    }
  }
  return commands;
}

async function detectFromCommonRunners(worktreePath) {
  const commands = [];
  if (await exists(path.join(worktreePath, "Cargo.toml"))) {
    commands.push({ name: "cargo test", command: ["cargo", "test"] });
  }
  if (await exists(path.join(worktreePath, "go.mod"))) {
    commands.push({ name: "go test ./...", command: ["go", "test", "./..."] });
  }
  if (
    (await exists(path.join(worktreePath, "pyproject.toml"))) ||
    (await exists(path.join(worktreePath, "pytest.ini"))) ||
    (await exists(path.join(worktreePath, "setup.cfg")))
  ) {
    commands.push({ name: "pytest", command: ["pytest"] });
  }
  return commands;
}

export async function detectVerifyCommands(worktreePath) {
  const [fromPackageJson, fromMakefile, fromRunners] = await Promise.all([
    detectFromPackageJson(worktreePath),
    detectFromMakefile(worktreePath),
    detectFromCommonRunners(worktreePath),
  ]);
  return [...fromPackageJson, ...fromMakefile, ...fromRunners];
}

function runCommand(cwd, argv, { shell = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = shell
      ? execFile("sh", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 })
      : execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? null,
        signal,
        timedOut: signal === "SIGTERM" && exitCode === null,
        stdout,
        stderr,
      });
    });
  });
}

export async function runVerification(worktreePath, { verifyCommand } = {}) {
  if (verifyCommand) {
    const result = await runCommand(worktreePath, [verifyCommand], { shell: true });
    return {
      source: "config-override",
      commandsRun: 1,
      results: [{ name: verifyCommand, ...result }],
      allPassed: result.exitCode === 0,
    };
  }

  const detected = await detectVerifyCommands(worktreePath);
  if (detected.length === 0) {
    return {
      source: "none-detected",
      commandsRun: 0,
      results: [],
      allPassed: null,
      note: "No verify command configured and none auto-detected (no package.json scripts, Makefile test/build/lint targets, or recognized project files). Review the diff manually.",
    };
  }

  const results = [];
  for (const { name, command } of detected) {
    const result = await runCommand(worktreePath, command);
    results.push({ name, ...result });
  }

  return {
    source: "auto-detected",
    commandsRun: results.length,
    results,
    allPassed: results.every((r) => r.exitCode === 0),
  };
}
