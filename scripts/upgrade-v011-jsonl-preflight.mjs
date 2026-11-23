#!/usr/bin/env node
import { inspectLegacyJsonlStore } from './lib/v011-jsonl-upgrade-preflight.mjs';

// Operator preflight ONLY: no output file, no state reset, no marker repair.
const usage = 'node scripts/upgrade-v011-jsonl-preflight.mjs --dir <quiesced-jsonl-store> --source-version 0.11.0';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else {
  const dirAt = args.indexOf('--dir');
  const versionAt = args.indexOf('--source-version');
  if (args.length !== 4 || dirAt === -1 || versionAt === -1 ||
      dirAt + 1 >= args.length || versionAt + 1 >= args.length ||
      !args[dirAt + 1] || !args[versionAt + 1] ||
      args[dirAt + 1].startsWith('--') || args[versionAt + 1].startsWith('--')) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      const report = await inspectLegacyJsonlStore(args[dirAt + 1], {
        declaredVersion: args[versionAt + 1],
      });
      console.log(JSON.stringify(report, null, 2));
      // A read-only inventory cannot clear a CRITICAL migration gate.
      process.exitCode = 2;
    } catch (error) {
      console.error(JSON.stringify({
        schema: 'ei-legacy-jsonl-preflight.v1',
        status: 'refused',
        errorCode: error?.code ?? 'PREFLIGHT_FAILED',
        sourceReadOnly: true,
        migrationPerformed: false,
      }));
      process.exitCode = 2;
    }
  }
}
