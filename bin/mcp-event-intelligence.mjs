#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const packageVersion = String(packageJson.version || '').trim();

const args = process.argv.slice(2);
const flags = new Set(args);

if (flags.has('--version') || flags.has('-v')) {
  console.log(packageVersion);
  process.exit(0);
}

if (flags.has('--help') || flags.has('-h')) {
  console.log(`MCP Event Intelligence v${packageVersion}

MCP-native complex event processing for durable agents.

Usage:
  mcp-event-intelligence          Start the HTTP reference service
  mcp-event-intelligence mcp      Start the standard MCP stdio control plane
  mcp-event-intelligence --mcp    Same as "mcp"
  mcp-event-intelligence doctor   Read-only offline integration configuration checks
  mcp-event-intelligence doctor --json   Machine-readable offline check output

MCP stdio mode:
  DATA_DIR=./data
  MCP_WRITE_ENABLED=false         Read-only by default
  MCP_OWNER_ID=local-user
  MCP_ACTOR_ID=mcp-agent
  RUNTIME_WAKE_TARGETS_JSON='{}'

HTTP service:
  SERVICE_AUTH_TOKEN=<random secret>
  PORT=3000
  DATA_DIR=./data

Optional integrations:
  TYPESAFE_API_KEY=<key>          Optional TypeSafe Jev semantic evaluator
  GITHUB_WEBHOOK_SECRET=<secret>  GitHub webhook verification
  RUNTIME_WAKE_TARGETS_JSON='{}'  Signed standalone runtime callbacks

Embedded hosts:
  import { createEventIntelligenceHost } from 'mcp-event-intelligence/host'
  Pass the harness MCP registry once; EI discovers Events-capable clients automatically.

Provider runtimes:
  import { createMcpEventsProvider } from 'mcp-event-intelligence/provider'
  Keep domain events, auth, data access and opaque cursors provider-owned.

Important:
  stdout is reserved for MCP JSON-RPC in stdio mode.
`);
  process.exit(0);
}

if (args[0] === 'doctor') {
  const unrecognized = args.slice(1).filter((arg) => arg !== '--json');
  if (unrecognized.length) {
    console.error(`Unknown doctor option: ${unrecognized[0]}`);
    process.exitCode = 2;
  } else {
    const {
      diagnoseEnvironment,
      formatDoctorReport,
    } = await import('../scripts/lib/integration-doctor.mjs');
    const result = diagnoseEnvironment();
    console.log(flags.has('--json')
      ? JSON.stringify(result, null, 2)
      : formatDoctorReport(result));
    if (result.status === 'fail') process.exitCode = 1;
  }
} else if (args[0] === 'mcp' || flags.has('--mcp')) {
  await import('../scripts/mcp-stdio.mjs');
} else {
  await import('../scripts/service.mjs');
}