import { PersistentEventStore } from '../../scripts/lib/persistent-event-store.mjs';
import { TriggerInspector } from '../../scripts/lib/trigger-inspector.mjs';

const dir = process.argv[2];
if (typeof dir !== 'string' || dir.length === 0) {
  throw Error('Persisted store directory is required');
}
const store = new PersistentEventStore(dir);
await store.init();
try {
  const inspector = new TriggerInspector({
    store, matchHistoryLimit: 2, evidenceRefLimit: 2,
  });
  const result = [];
  for (const triggerId of ['partial-replay', 'matched-replay']) {
    result.push(await inspector.inspect({ triggerId, version: '1' }));
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await store.close();
}
