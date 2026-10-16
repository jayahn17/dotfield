#!/usr/bin/env node
// mcp/stdio.mjs — the stdio transport Claude Code and Claude Desktop start
// through .mcp.json ({"command": "node", "args": ["mcp/stdio.mjs"]}). It
// serves the fork at the current working directory. Without the optional
// SDK it prints the one install command and exits 2; nothing else is logged
// to stdout, which belongs to the protocol.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SDK_INSTALL, createDotfieldServer, loadSdk } from './server.mjs';

/** Start the server on stdio; returns the exit code (0 while serving, 2 without the SDK). */
export async function main({ cwd = process.cwd(), env = process.env, stderr = process.stderr } = {}) {
  const sdk = await loadSdk();
  if (!sdk.ok) {
    stderr.write(`DF_MCP_SDK_MISSING: ${sdk.check.message} Run: ${SDK_INSTALL}\n`);
    return 2;
  }
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = await createDotfieldServer({ cwd, env });
  await server.connect(new StdioServerTransport());
  return 0;
}

function invokedDirectly() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main().then((code) => { if (code !== 0) process.exit(code); }, (e) => { process.stderr.write(`${e && e.message ? e.message : String(e)}\n`); process.exit(1); });
}
