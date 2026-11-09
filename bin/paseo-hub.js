#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { configureRuntimeRoot } from "../dist/runtime-files.js";

// A loopback Hub with an explicit data directory is the embedded install.
// DATABASE_URL in the parent environment belongs to some other project; using it
// exits during Postgres setup and the embedded files are never opened.
if (usesEmbeddedDataDirectory(process.env)) {
  delete process.env.DATABASE_URL;
}

configureRuntimeRoot(fileURLToPath(new URL("..", import.meta.url)));
const { runHubCommandLine } = await import("../dist/index.js");
runHubCommandLine();

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function usesEmbeddedDataDirectory(env) {
  const dataDirectory = env.PASEO_HUB_DATA_DIR;
  if (dataDirectory === undefined || dataDirectory.trim().length === 0) return false;
  const appUrl = env.PASEO_HUB_APP_URL;
  if (appUrl === undefined) return false;
  try {
    const hostname = new URL(appUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
