import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  permissionRulesetFromConfig,
  parseModel,
  createApiClient,
  ensureServer,
  shutdownServer,
} from "../src/opencode.js";

after(() => {
  shutdownServer();
});

test("permissionRulesetFromConfig maps booleans to allow/deny rules", () => {
  const ruleset = permissionRulesetFromConfig({ bash: true, webfetch: false });
  assert.deepEqual(ruleset, [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "deny" },
  ]);
});

test("permissionRulesetFromConfig handles an empty/missing config", () => {
  assert.deepEqual(permissionRulesetFromConfig(), []);
  assert.deepEqual(permissionRulesetFromConfig({}), []);
});

test("parseModel splits provider/model", () => {
  assert.deepEqual(parseModel("deepseek/deepseek-coder"), {
    providerID: "deepseek",
    id: "deepseek-coder",
  });
});

test("parseModel keeps extra slashes in the model id", () => {
  assert.deepEqual(parseModel("openrouter/some/nested-model"), {
    providerID: "openrouter",
    id: "some/nested-model",
  });
});

test("parseModel returns null for falsy input", () => {
  assert.equal(parseModel(undefined), null);
  assert.equal(parseModel(""), null);
});

test("parseModel throws when there's no slash", () => {
  assert.throws(() => parseModel("not-a-provider-model"), /provider\/model/);
});

async function withStubServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
  });
}

test("createApiClient.createSession posts to /session with directory query and body", async () => {
  let seen;
  await withStubServer(
    async (req, res) => {
      seen = { method: req.method, url: req.url, body: await readBody(req) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "ses_abc123", directory: "/tmp/wt" }));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      const session = await client.createSession({
        directory: "/tmp/wt",
        title: "add a hello world function",
        model: { providerID: "deepseek", id: "deepseek-coder" },
        permission: [{ permission: "webfetch", pattern: "*", action: "deny" }],
      });
      assert.equal(session.id, "ses_abc123");
      assert.equal(seen.method, "POST");
      assert.equal(seen.url, "/session?directory=%2Ftmp%2Fwt");
      assert.equal(seen.body.title, "add a hello world function");
      assert.deepEqual(seen.body.model, { providerID: "deepseek", id: "deepseek-coder" });
      assert.deepEqual(seen.body.permission, [
        { permission: "webfetch", pattern: "*", action: "deny" },
      ]);
    }
  );
});

test("createApiClient.sendMessage posts a text part and returns info+parts", async () => {
  await withStubServer(
    async (req, res) => {
      const body = await readBody(req);
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/session/ses_abc123/message?directory=%2Ftmp%2Fwt");
      assert.deepEqual(body.parts, [{ type: "text", text: "please fix the failing test" }]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ info: { role: "assistant" }, parts: [] }));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      const result = await client.sendMessage({
        directory: "/tmp/wt",
        sessionId: "ses_abc123",
        text: "please fix the failing test",
      });
      assert.equal(result.info.role, "assistant");
    }
  );
});

test("createApiClient.sendMessage reshapes a parsed model to {providerID, modelID}", async () => {
  // This endpoint's model shape differs from session-create's {providerID, id} —
  // see the "opencode API" note in src/opencode.js. Caught by a live smoke-test 400.
  let seenBody;
  await withStubServer(
    async (req, res) => {
      seenBody = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ info: {}, parts: [] }));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      await client.sendMessage({
        directory: "/tmp/wt",
        sessionId: "ses_abc123",
        text: "hi",
        model: parseModel("ollama-cloud/gpt-oss:20b"),
      });
      assert.deepEqual(seenBody.model, { providerID: "ollama-cloud", modelID: "gpt-oss:20b" });
    }
  );
});

test("createApiClient.getSession returns cost/tokens/summary", async () => {
  await withStubServer(
    async (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/session/ses_abc123?directory=%2Ftmp%2Fwt");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "ses_abc123", cost: 0.0042, tokens: { input: 100, output: 50 } }));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      const session = await client.getSession({ directory: "/tmp/wt", sessionId: "ses_abc123" });
      assert.equal(session.cost, 0.0042);
      assert.equal(session.tokens.input, 100);
    }
  );
});

test("createApiClient.getSessionDiff returns file diffs", async () => {
  await withStubServer(
    async (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/session/ses_abc123/diff?directory=%2Ftmp%2Fwt");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ file: "foo.py", additions: 3, deletions: 0, status: "added" }]));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      const diff = await client.getSessionDiff({ directory: "/tmp/wt", sessionId: "ses_abc123" });
      assert.equal(diff.length, 1);
      assert.equal(diff[0].file, "foo.py");
    }
  );
});

test("createApiClient.abortSession posts to the abort endpoint", async () => {
  await withStubServer(
    async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/session/ses_abc123/abort?directory=%2Ftmp%2Fwt");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("true");
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      const aborted = await client.abortSession({ directory: "/tmp/wt", sessionId: "ses_abc123" });
      assert.equal(aborted, true);
    }
  );
});

test("apiFetch throws with status and body on a non-2xx response", async () => {
  await withStubServer(
    async (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
    },
    async (baseUrl) => {
      const client = createApiClient(baseUrl);
      await assert.rejects(
        () => client.getSession({ directory: "/tmp/wt", sessionId: "ses_x" }),
        /400/
      );
    }
  );
});

test("ensureServer starts a real opencode serve process and returns a reachable base URL", async () => {
  const baseUrl = await ensureServer();
  assert.match(baseUrl, /^https?:\/\/127\.0\.0\.1:\d+$/);
  const res = await fetch(`${baseUrl}/doc`);
  assert.equal(res.ok, true);

  // Calling again should reuse the same healthy server rather than spawning a new one.
  const baseUrl2 = await ensureServer();
  assert.equal(baseUrl2, baseUrl);
});
