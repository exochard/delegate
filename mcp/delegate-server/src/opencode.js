import { spawn } from "node:child_process";

const SERVER_START_TIMEOUT_MS = 15_000;
const LISTEN_REGEX = /listening on (https?:\/\/\S+)/i;

let managedServer = null; // { child, baseUrl } | null, module-singleton

function killManagedServer() {
  if (managedServer?.child && !managedServer.child.killed) {
    managedServer.child.kill();
  }
  managedServer = null;
}

process.once("exit", killManagedServer);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    killManagedServer();
    process.exit(0);
  });
}

/** Explicitly stops the managed `opencode serve` child, if any. Callers (and tests) should invoke this on shutdown. */
export function shutdownServer() {
  killManagedServer();
}

/** Maps our config's {bash:true, webfetch:false, ...} onto opencode's PermissionRuleset. */
export function permissionRulesetFromConfig(workerPermissions = {}) {
  return Object.entries(workerPermissions).map(([permission, allowed]) => ({
    permission,
    pattern: "*",
    action: allowed ? "allow" : "deny",
  }));
}

/** "provider/model-id" -> {providerID, id}. Returns null for falsy input. */
export function parseModel(modelString) {
  if (!modelString) return null;
  const slash = modelString.indexOf("/");
  if (slash === -1) {
    throw new Error(`Model must be in "provider/model" format, got "${modelString}"`);
  }
  return { providerID: modelString.slice(0, slash), id: modelString.slice(slash + 1) };
}

async function isServerHealthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/doc`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts a local `opencode serve` (or reuses one already started by this process) and returns its base URL. */
export async function ensureServer() {
  if (managedServer && (await isServerHealthy(managedServer.baseUrl))) {
    return managedServer.baseUrl;
  }
  killManagedServer();

  const baseUrl = await new Promise((resolve, reject) => {
    const child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("opencode serve did not report a listening address within timeout"));
      }
    }, SERVER_START_TIMEOUT_MS);

    const onData = (chunk) => {
      const match = chunk.toString().match(LISTEN_REGEX);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        managedServer = { child, baseUrl: match[1] };
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to spawn opencode serve: ${err.message}`));
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`opencode serve exited early with code ${code}`));
      }
    });
  });

  return baseUrl;
}

function buildUrl(baseUrl, urlPath, query = {}) {
  const url = new URL(urlPath, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url;
}

async function apiFetch(baseUrl, method, urlPath, { query, body } = {}) {
  const url = buildUrl(baseUrl, urlPath, query);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`opencode API ${method} ${urlPath} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Thin client over a known base URL — kept separate from ensureServer() so it's testable against a stub HTTP server. */
export function createApiClient(baseUrl) {
  return {
    async createSession({ directory, title, agent, model, permission }) {
      return apiFetch(baseUrl, "POST", "/session", {
        query: { directory },
        body: {
          title,
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(permission ? { permission } : {}),
        },
      });
    },

    async sendMessage({ directory, sessionId, text, model, agent }) {
      // Note: unlike session-create's {providerID, id}, this endpoint's model shape is
      // {providerID, modelID} — the same parsed model object is reshaped here to match.
      return apiFetch(baseUrl, "POST", `/session/${sessionId}/message`, {
        query: { directory },
        body: {
          parts: [{ type: "text", text }],
          ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
          ...(agent ? { agent } : {}),
        },
      });
    },

    async getSession({ directory, sessionId }) {
      return apiFetch(baseUrl, "GET", `/session/${sessionId}`, { query: { directory } });
    },

    async getSessionDiff({ directory, sessionId }) {
      return apiFetch(baseUrl, "GET", `/session/${sessionId}/diff`, { query: { directory } });
    },

    async abortSession({ directory, sessionId }) {
      return apiFetch(baseUrl, "POST", `/session/${sessionId}/abort`, { query: { directory } });
    },
  };
}
