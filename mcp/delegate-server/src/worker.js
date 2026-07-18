import { pathToFileURL } from "node:url";

import * as opencode from "./opencode.js";

// A worker driver is the backend that actually executes a delegated task. Every driver
// exports the same contract:
//   WORKER_CONFIG_FILENAME, parseModel, writeWorkerConfig, run, abortRun,
//   exportSession, checkInstalled
export const DEFAULT_WORKER = "opencode";

const drivers = new Map([[DEFAULT_WORKER, opencode]]);

// The server runs as a stdio subprocess, so an env var is the only injection seam a
// caller has. Tests point this at a fake driver; nothing in production sets it.
const overrideModule = process.env.DELEGATE_WORKER_MODULE;
if (overrideModule) {
  const name = process.env.DELEGATE_WORKER_NAME || DEFAULT_WORKER;
  drivers.set(name, await import(pathToFileURL(overrideModule).href));
}

/** Looks up a worker driver by name. Throws listing the available drivers if there's no match. */
export function resolveWorker(name = DEFAULT_WORKER) {
  const driver = drivers.get(name ?? DEFAULT_WORKER);
  if (!driver) {
    throw new Error(`Unknown worker "${name}". Available workers: ${[...drivers.keys()].join(", ")}.`);
  }
  return driver;
}
