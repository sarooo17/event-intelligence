import { createServer } from 'node:http';
import {
  EVENT_INTELLIGENCE_COMPATIBILITY,
  EVENT_INTELLIGENCE_PROTOCOL_VERSION,
  EVENT_INTELLIGENCE_SCHEMA_VERSION,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  TypeSafeJevEvaluator,
} from '../dist/src/semantic/typesafeJevEvaluator.js';
import {
  CompositeTriggerEngine,
} from '../dist/src/composite/engine.js';
import {
  ExperimentalMcpEventsServer,
} from '../dist/src/mcpEvents/server.js';
import { EventProcessor } from './lib/event-processor.mjs';
import {
  githubEventPassesStructuredFilter,
  translateGitHubWebhook,
  verifyGitHubWebhookSignature,
} from './lib/github-webhook.mjs';
import { createHttpWakeDeliverer } from './lib/http-wake-deliverer.mjs';
import {
  CompositeWakeCoordinator,
} from './lib/composite-wake-coordinator.mjs';
import {
  buildGenericRuntimeWakePacket,
  createSignedRuntimeWakeDeliverer,
  readRuntimeWakeTargets,
} from './lib/generic-runtime-wake.mjs';
import {
  CompositeEventConsumer,
} from './lib/composite-event-consumer.mjs';
import {
  DerivedEventCoordinator,
} from './lib/derived-event-coordinator.mjs';
import {
  TriggerControlPlane,
} from './lib/trigger-control-plane.mjs';
import {
  ingestGitHubMcpEvent,
  registerGitHubMcpEvents,
} from './lib/github-mcp-events-adapter.mjs';
import { PersistentEventStore } from './lib/persistent-event-store.mjs';
import {
  TriggerInspector,
  simulateTrigger,
} from './lib/trigger-inspector.mjs';
import {
  TemporalDeadlineScheduler,
} from './lib/temporal-deadline-scheduler.mjs';

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? './data';
const environmentId = process.env.ENVIRONMENT_ID ?? 'local';
const authToken = process.env.SERVICE_AUTH_TOKEN ?? '';

const store = new PersistentEventStore(dataDir);
const counts = await store.init();

const evaluator = process.env.TYPESAFE_API_KEY
  ? TypeSafeJevEvaluator.fromEnvironment(process.env)
  : null;

const wakeDeliverer = createHttpWakeDeliverer(
  process.env.RUNTIME_WAKE_URL ?? '',
);

const processor = new EventProcessor({
  store,
  evaluator,
  wakeDeliverer,
});
const compositeTriggers = new CompositeTriggerEngine(store, evaluator);
const runtimeWakeTargets = readRuntimeWakeTargets(
  process.env.RUNTIME_WAKE_TARGETS_JSON,
);
const wakeCoordinators = new Map(
  [...runtimeWakeTargets].map(([runtime, target]) => [
    runtime,
    new CompositeWakeCoordinator({
      store,
      triggerEngine: compositeTriggers,
      deliverer: createSignedRuntimeWakeDeliverer(target),
      packetBuilder: buildGenericRuntimeWakePacket,
    }),
  ]),
);
const derivedEventCoordinator = new DerivedEventCoordinator({ store });
const compositeEventConsumer = new CompositeEventConsumer({
  store,
  triggerEngine: compositeTriggers,
  wakeCoordinators,
  derivedEventCoordinator,
  processor,
  maxDerivedDepth: Number(process.env.MAX_DERIVED_EVENT_DEPTH ?? 16),
});
const temporalScheduler = new TemporalDeadlineScheduler({
  store,
  compositeEventConsumer,
  intervalMs: Number(process.env.TEMPORAL_TICK_MS ?? 1000),
});
temporalScheduler.start();

const triggerControl = new TriggerControlPlane({
  store,
  triggerEngine: compositeTriggers,
});
const triggerInspector = new TriggerInspector({ store });
const mcpEventsServer = new ExperimentalMcpEventsServer(store);
registerGitHubMcpEvents(mcpEventsServer);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readRawBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function requireBearer(request, response) {
  if (!authToken) {
    sendJson(response, 503, {
      error: 'SERVICE_AUTH_TOKEN_NOT_CONFIGURED',
    });
    return false;
  }

  if (request.headers.authorization !== `Bearer ${authToken}`) {
    sendJson(response, 401, { error: 'UNAUTHORIZED' });
    return false;
  }

  return true;
}

function githubSemanticCondition() {
  const instruction = process.env.SEMANTIC_INSTRUCTION;
  if (!instruction) return undefined;

  return {
    type: 'semantic_boolean',
    instruction,
    input: ['data.title', 'data.bodyPreview', 'data.labels'],
    matchThreshold: Number(process.env.SEMANTIC_MATCH_THRESHOLD ?? 0.8),
    rejectThreshold: Number(process.env.SEMANTIC_REJECT_THRESHOLD ?? 0.2),
    uncertain: process.env.SEMANTIC_UNCERTAIN_POLICY ?? 'escalate',
  };
}

function logProcessingResult(result) {
  console.log(
    JSON.stringify({
      message: 'event_intelligence_result',
      traceId: result.traceId,
      sourceEventId: result.sourceEventId,
      status: result.status,
      decisionId: result.decision?.decisionId ?? null,
      outcome: result.decision?.outcome ?? null,
      probability: result.decision?.probability ?? null,
      evaluator: result.decision?.evaluator ?? null,
      providerEvidence: result.decision?.providerEvidence ?? null,
      wakeId: result.wake?.wakeId ?? null,
      wakeStatus: result.wake?.status ?? null,
    }),
  );
}

function githubContext() {
  const targetId = process.env.RUNTIME_TARGET_ID;
  if (!targetId) {
    throw new Error('RUNTIME_TARGET_ID is required for GitHub webhook delivery');
  }

  return {
    environmentId,
    subscriptionId:
      process.env.GITHUB_SUBSCRIPTION_ID ?? 'github-issues-default',
    serverId: process.env.GITHUB_SERVER_ID ?? 'github-webhook-adapter',
    transport: 'webhook',
    provider: 'github',
    target: {
      runtime: process.env.RUNTIME_TARGET_RUNTIME ?? 'agent-runtime',
      kind: process.env.RUNTIME_TARGET_KIND ?? 'session',
      id: targetId,
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`,
    );

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(response, 200, {
        status: 'ok',
        protocolVersion: EVENT_INTELLIGENCE_PROTOCOL_VERSION,
        schemaVersion: EVENT_INTELLIGENCE_SCHEMA_VERSION,
      });
    }

    if (request.method === 'GET' && url.pathname === '/readyz') {
      const auditValid = await store.verifyAudit();
      const semanticRequired = Boolean(process.env.SEMANTIC_INSTRUCTION);
      const evaluatorConfigured = Boolean(evaluator);
      const ready =
        auditValid &&
        (!semanticRequired || evaluatorConfigured);

      return sendJson(response, ready ? 200 : 503, {
        status: ready
          ? 'ready'
          : !auditValid
            ? 'audit_invalid'
            : 'semantic_evaluator_unavailable',
        auditValid,
        semanticRequired,
        evaluatorConfigured,
        wakeCallbackConfigured: Boolean(wakeDeliverer),
        genericRuntimeWakeTargets: [...runtimeWakeTargets.keys()],
        eventSources: store.listEventSources().length,
        pendingTemporalDeadlines:
          store.listTemporalDeadlines({ status: 'pending' }).length,
        derivedEvents: store.listDerivedEvents().length,
        derivedContracts: store.listDerivedContracts().length,
      });
    }

    if (request.method === 'POST' && url.pathname === '/v1/providers/github/webhook') {
      const raw = await readRawBody(request);
      const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
      const signature = request.headers['x-hub-signature-256'];

      if (
        !verifyGitHubWebhookSignature(
          raw,
          typeof signature === 'string' ? signature : '',
          secret,
        )
      ) {
        return sendJson(response, 401, { error: 'INVALID_GITHUB_SIGNATURE' });
      }

      const payload = JSON.parse(raw.toString('utf8'));
      const translated = translateGitHubWebhook({
        eventName: String(request.headers['x-github-event'] ?? ''),
        deliveryId: String(request.headers['x-github-delivery'] ?? ''),
        payload,
      });

      if (translated.kind === 'ping') {
        return sendJson(response, 200, { status: 'pong' });
      }

      if (translated.kind === 'ignored') {
        return sendJson(response, 202, {
          status: 'ignored',
          reason: translated.reason,
        });
      }

      const mcpReceipt = await ingestGitHubMcpEvent(
        store,
        translated.event,
      );

      console.log(JSON.stringify({
        message: 'mcp_event_ingested',
        serverId: 'github-mcp-events',
        eventId: translated.event.eventId,
        eventName: translated.event.name,
        accepted: mcpReceipt.accepted,
        sequence: mcpReceipt.sequence,
      }));

      let composite = null;
      if (mcpReceipt.accepted) {
        composite = await compositeEventConsumer.ingestMcpOccurrence({
          event: translated.event,
          serverId: 'github-mcp-events',
          provider: 'github',
          traceId: `mcp:github:${translated.event.eventId}`,
        });

        console.log(JSON.stringify({
          message: 'mcp_composite_result',
          eventId: translated.event.eventId,
          eventName: translated.event.name,
          results: composite.results.map((result) => ({
            triggerId: result.triggerId,
            matchId: result.match?.matchId ?? null,
            status: result.match?.status ?? null,
            matched: result.matched,
            fired: result.fired,
          })),
          deliveries: composite.deliveries,
          derivedEvents: composite.derivedEvents?.map((item) => ({
            eventId: item.eventId,
            eventName: item.eventName,
            status: item.status,
          })) ?? [],
        }));
      }

      if (
        !githubEventPassesStructuredFilter(translated.event, {
          repository: process.env.GITHUB_REPOSITORY,
          label: process.env.GITHUB_LABEL,
        })
      ) {
        return sendJson(response, 202, {
          status: 'filtered_structured',
        });
      }

      const result = await processor.ingest({
        event: translated.event,
        context: githubContext(),
        semanticCondition: githubSemanticCondition(),
        wakeOnEscalation:
          process.env.WAKE_ON_ESCALATION === 'true',
      });

      logProcessingResult(result);
      return sendJson(response, 202, result);
    }

    if (request.method === 'POST' && url.pathname === '/mcp') {
      if (!requireBearer(request, response)) return;

      const protocolVersion = request.headers['mcp-protocol-version'];
      if (
        typeof protocolVersion === 'string' &&
        protocolVersion !== '2026-07-28'
      ) {
        return sendJson(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32022,
            message: 'Unsupported MCP protocol version',
            data: { supported: ['2026-07-28'] },
          },
        });
      }

      const raw = await readRawBody(request);
      const rpc = JSON.parse(raw.toString('utf8'));
      if (
        rpc?.jsonrpc !== '2.0' ||
        (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') ||
        typeof rpc.method !== 'string'
      ) {
        return sendJson(response, 400, {
          jsonrpc: '2.0',
          id: rpc?.id ?? null,
          error: { code: -32600, message: 'Invalid Request' },
        });
      }

      const methodHeader = request.headers['mcp-method'];
      if (
        typeof methodHeader === 'string' &&
        methodHeader !== rpc.method
      ) {
        return sendJson(response, 400, {
          jsonrpc: '2.0',
          id: rpc.id,
          error: {
            code: -32600,
            message: 'Mcp-Method header does not match JSON-RPC method',
          },
        });
      }

      const result = await mcpEventsServer.handleRequest(rpc);
      return sendJson(response, 200, result);
    }

    if (url.pathname.startsWith('/v1/') && !requireBearer(request, response)) {
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/v1/derived-contracts'
    ) {
      return sendJson(response, 200, {
        contracts: store.listDerivedContracts(
          url.searchParams.get('eventName') ?? undefined,
        ),
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/v1/derived-events'
    ) {
      return sendJson(response, 200, {
        events: store.listDerivedEvents({
          ...(url.searchParams.get('triggerId')
            ? { triggerId: url.searchParams.get('triggerId') }
            : {}),
          ...(url.searchParams.get('matchId')
            ? { matchId: url.searchParams.get('matchId') }
            : {}),
          ...(url.searchParams.get('name')
            ? { name: url.searchParams.get('name') }
            : {}),
        }),
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/v1/inspector/triggers/')
    ) {
      const triggerId = decodeURIComponent(
        url.pathname.slice('/v1/inspector/triggers/'.length),
      );
      return sendJson(response, 200, triggerInspector.inspect({
        triggerId,
        version: url.searchParams.get('version') ?? undefined,
        matchId: url.searchParams.get('matchId') ?? undefined,
      }));
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/inspector/simulate'
    ) {
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const result = await simulateTrigger({
        definition: body.definition,
        events: body.events,
        until: body.until,
        order: body.order,
      });
      return sendJson(response, 200, result);
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/v1/temporal/deadlines'
    ) {
      return sendJson(response, 200, {
        deadlines: store.listTemporalDeadlines({
          ...(url.searchParams.get('triggerId')
            ? { triggerId: url.searchParams.get('triggerId') }
            : {}),
          ...(url.searchParams.get('matchId')
            ? { matchId: url.searchParams.get('matchId') }
            : {}),
          ...(url.searchParams.get('status')
            ? { status: url.searchParams.get('status') }
            : {}),
        }),
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/temporal/deadlines/run-due'
    ) {
      return sendJson(response, 200, {
        outcomes: await temporalScheduler.runDue(),
      });
    }

    if (request.method === 'GET' && url.pathname === '/v1/event-sources') {
      const connectionIds = url.searchParams.getAll('connectionId');
      return sendJson(response, 200, {
        eventSources: triggerControl.listEventSources({
          ...(connectionIds.length ? { connectionIds } : {}),
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/v1/event-sources') {
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const source = await triggerControl.registerEventSource(
        body.source,
        body.actor,
      );
      return sendJson(response, 201, { source });
    }

    if (request.method === 'GET' && url.pathname === '/v1/control/triggers') {
      const ownerType = url.searchParams.get('ownerType');
      const ownerId = url.searchParams.get('ownerId');
      const tenantId = url.searchParams.get('tenantId');
      return sendJson(response, 200, {
        triggers: triggerControl.listTriggers({
          ...(ownerType && ownerId
            ? {
              owner: {
                type: ownerType,
                principal_id: ownerId,
                ...(tenantId ? { tenant_id: tenantId } : {}),
              },
            }
            : {}),
        }),
      });
    }

    if (
      request.method === 'PATCH' &&
      url.pathname.startsWith('/v1/control/triggers/') &&
      !url.pathname.endsWith('/pause') &&
      !url.pathname.endsWith('/resume')
    ) {
      const triggerId = decodeURIComponent(
        url.pathname.slice('/v1/control/triggers/'.length),
      );
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const result = await triggerControl.updateTrigger({
        triggerId,
        expectedVersion: String(body.expectedVersion || ''),
        definition: body.definition,
        connectionIds: body.connectionIds,
        actor: body.actor,
        owner: body.owner,
        confirmationId: body.confirmationId,
      });
      return sendJson(response, 200, result);
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/control/triggers/')
    ) {
      const triggerId = decodeURIComponent(
        url.pathname.slice('/v1/control/triggers/'.length),
      );
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const result = await triggerControl.deleteTrigger({
        triggerId,
        version: String(body.version || ''),
        actor: body.actor,
        owner: body.owner,
        confirmationId: body.confirmationId,
      });
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/v1/control/triggers') {
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const result = await triggerControl.createTrigger({
        definition: body.definition,
        connectionIds: body.connectionIds,
        actor: body.actor,
        owner: body.owner,
        confirmationId: body.confirmationId,
      });
      return sendJson(response, 201, result);
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/control/triggers/') &&
      (url.pathname.endsWith('/pause') || url.pathname.endsWith('/resume'))
    ) {
      const action = url.pathname.endsWith('/pause') ? 'pause' : 'resume';
      const suffix = action === 'pause' ? '/pause' : '/resume';
      const triggerId = decodeURIComponent(
        url.pathname.slice('/v1/control/triggers/'.length, -suffix.length),
      );
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const input = {
        triggerId,
        version: String(body.version || ''),
        actor: body.actor,
        owner: body.owner,
        confirmationId: body.confirmationId,
      };
      const result = action === 'pause'
        ? await triggerControl.pauseTrigger(input)
        : await triggerControl.resumeTrigger(input);
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/v1/triggers') {
      const raw = await readRawBody(request);
      const parsed = JSON.parse(raw.toString('utf8'));
      await triggerControl.assertDerivedOutputContract(parsed);
      const definition = await compositeTriggers.register(parsed);
      await triggerControl.registerDerivedOutputSource(definition);
      return sendJson(response, 201, definition);
    }

    if (request.method === 'GET' && url.pathname === '/v1/triggers') {
      return sendJson(response, 200, {
        triggers: store.listTriggers(),
      });
    }

    if (request.method === 'GET' && url.pathname === '/v1/trigger-matches') {
      const triggerId = url.searchParams.get('triggerId') ?? undefined;
      return sendJson(response, 200, {
        matches: store.listTriggerMatches(triggerId),
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/composite/events/ingest'
    ) {
      const raw = await readRawBody(request);
      const composite = await compositeEventConsumer.ingestCorrelatable(
        JSON.parse(raw.toString('utf8')),
      );
      const { results, deliveries } = composite;

      console.log(JSON.stringify({
        message: 'composite_trigger_result',
        results: results.map((result) => ({
          triggerId: result.triggerId,
          matchId: result.match?.matchId ?? null,
          status: result.match?.status ?? null,
          matched: result.matched,
          fired: result.fired,
          sourceEventIds:
            result.match?.sourceEvents.map((event) => event.sourceEventId) ?? [],
        })),
        deliveries,
        derivedEvents: composite.derivedEvents?.map((item) => ({
          eventId: item.eventId,
          eventName: item.eventName,
          status: item.status,
        })) ?? [],
      }));
      return sendJson(response, 202, { results, deliveries });
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/trigger-matches/') &&
      url.pathname.endsWith('/fire')
    ) {
      const matchId = decodeURIComponent(
        url.pathname.slice(
          '/v1/trigger-matches/'.length,
          -'/fire'.length,
        ),
      );
      const raw = await readRawBody(request);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      if (typeof body.wakeId !== 'string' || !body.wakeId) {
        return sendJson(response, 400, { error: 'wakeId is required' });
      }
      const fired = await compositeTriggers.markFired(matchId, body.wakeId);
      return sendJson(response, 200, fired);
    }

    if (request.method === 'GET' && url.pathname === '/v1/protocol') {
      return sendJson(response, 200, {
        protocolVersion: EVENT_INTELLIGENCE_PROTOCOL_VERSION,
        schemaVersion: EVENT_INTELLIGENCE_SCHEMA_VERSION,
        compatibility: EVENT_INTELLIGENCE_COMPATIBILITY,
        environmentId,
      });
    }

    if (request.method === 'POST' && url.pathname === '/v1/events/ingest') {
      const raw = await readRawBody(request);
      const body = JSON.parse(raw.toString('utf8'));
      const result = await processor.ingest(body);
      logProcessingResult(result);
      return sendJson(response, 202, result);
    }

    if (request.method === 'GET' && url.pathname === '/v1/audit') {
      const afterSequence = Number(url.searchParams.get('afterSequence') ?? -1);
      const traceId = url.searchParams.get('traceId') ?? undefined;
      return sendJson(response, 200, {
        records: store.listAudit({ traceId, afterSequence }),
        verified: await store.verifyAudit(),
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/v1/traces/')
    ) {
      const traceId = decodeURIComponent(
        url.pathname.slice('/v1/traces/'.length),
      );
      return sendJson(response, 200, store.trace(traceId));
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/wakes/') &&
      url.pathname.endsWith('/ack')
    ) {
      const wakeId = decodeURIComponent(
        url.pathname.slice('/v1/wakes/'.length, -'/ack'.length),
      );
      const raw = await readRawBody(request);
      const body = raw.length
        ? JSON.parse(raw.toString('utf8'))
        : {};
      const handled = await processor.acknowledgeWake(
        wakeId,
        typeof body.runtimeReceiptId === 'string'
          ? body.runtimeReceiptId
          : undefined,
      );
      return sendJson(response, 200, handled);
    }

    return sendJson(response, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error(error);
    return sendJson(response, 400, {
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      message: 'mcp-event-intelligence service ready',
      port,
      dataDir,
      environmentId,
      restored: counts,
      protocolVersion: EVENT_INTELLIGENCE_PROTOCOL_VERSION,
      schemaVersion: EVENT_INTELLIGENCE_SCHEMA_VERSION,
    }),
  );
});
