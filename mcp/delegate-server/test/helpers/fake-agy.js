#!/usr/bin/env node
// Stand-in for the agy binary, selected through DELEGATE_AGY_BIN. Behaviour comes from
// FAKE_AGY_MODE; FAKE_AGY_ARGV_FILE receives the argv it was called with.
import { writeFileSync } from "node:fs";

if (process.env.FAKE_AGY_ARGV_FILE) writeFileSync(process.env.FAKE_AGY_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (process.argv[2] === "--version") {
  console.log("agy 0.0.0-fake");
  process.exit(0);
}

const mode = process.env.FAKE_AGY_MODE || "success";
const base = {
  conversation_id: "conv-1",
  status: "SUCCESS",
  response: "ok",
  duration_seconds: 1.5,
  num_turns: 2,
  usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 },
  denied_actions: null,
  structured_output: {
    findings: [{ path: "a.txt", line: 1, quote: "hello", claim: "greets" }],
    unknowns: ["nothing else"],
  },
};

if (mode === "exit3") {
  console.error("AGY_ERROR: not signed in");
  process.exit(3);
}
if (mode === "denied") {
  console.log(JSON.stringify({ ...base, response: "", denied_actions: [{ action: "run_command", display_name: "Run Command" }] }));
} else if (mode === "failed") {
  console.log(JSON.stringify({ ...base, status: "FAILED" }));
} else if (mode === "nostructured") {
  const { structured_output, ...rest } = base;
  console.log(JSON.stringify(rest));
} else {
  console.log(JSON.stringify(base));
}
