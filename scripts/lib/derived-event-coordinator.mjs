import {
  parseDerivedEventRecord,
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';

export const DERIVED_EVENT_SERVER_ID = 'event-intelligence:derived';
export const DERIVED_EVENT_CONNECTION_ID = 'event-intelligence:derived';

function getByPath(source, path) {
  let current = source;
  for (const part of String(path).split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) return undefined;
    current = current[part];
  }
  return current;
}

function evidenceRef(source) {
  return {
    serverId: source.serverId ?? null,
    eventName: source.eventName,
    sourceEventId: source.sourceEventId,
    traceId: source.traceId,
    occurredAt: source.occurredAt,
    payloadHash: source.payloadHash ?? null,
    contractVersion:
      source.data?._derived?.contractVersion ?? null,
    schemaFingerprint:
      source.data?._derived?.schemaFingerprint ?? null,
  };
}

function dedupeEvidence(refs) {
  const seen = new Set();
  const result = [];
  for (const ref of refs) {
    const key =
      `${ref.serverId ?? ''}::${ref.eventName}::${ref.sourceEventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result.sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) ||
    a.eventName.localeCompare(b.eventName) ||
    a.sourceEventId.localeCompare(b.sourceEventId)
  );
}

function latestForClause(match, clauseId) {
  return match.sourceEvents
    .filter((event) => event.clauseId === clauseId)
    .sort((a, b) =>
      Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
      b.sourceEventId.localeCompare(a.sourceEventId)
    )[0] ?? null;
}

export class DerivedEventCoordinator {
  constructor({
    store,
    now = () => new Date(),
  }) {
    this.store = store;
    this.now = now;
  }

  async emitMatched(match, definition) {
    const spec = definition?.derivedEvent;
    if (!spec || !match || match.status !== 'matched') {
      return {
        status: 'not_applicable',
        accepted: false,
        record: null,
      };
    }

    const eventId = `derived_${(
      await sha256Hex({
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
        matchId: match.matchId,
        eventName: spec.name,
        contractVersion: spec.contractVersion,
      })
    ).slice(0, 24)}`;

    const existing = this.store.getDerivedEvent(
      eventId,
      DERIVED_EVENT_SERVER_ID,
    );
    if (existing) {
      await this.audit(existing, 'derived_event.replayed', {
        reason: 'stable_event_id_already_persisted',
      });
      return {
        status: 'replayed',
        accepted: false,
        record: existing,
      };
    }

    const directParents = dedupeEvidence(
      match.sourceEvents.map(evidenceRef),
    );
    const rootEvidence = [];
    for (const source of match.sourceEvents) {
      if (source.serverId === DERIVED_EVENT_SERVER_ID) {
        const parent = this.store.getDerivedEvent(
          source.sourceEventId,
          DERIVED_EVENT_SERVER_ID,
        );
        if (parent) {
          rootEvidence.push(...parent.rootEvidence);
          continue;
        }
      }
      rootEvidence.push(evidenceRef(source));
    }

    const projected = {};
    for (const projection of spec.projections ?? []) {
      const source = latestForClause(match, projection.ref);
      if (!source) {
        throw new Error(
          `Derived event projection source missing: ${projection.ref}`,
        );
      }
      const value = getByPath(source.data, projection.path);
      if (
        value !== undefined &&
        (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        )
      ) {
        projected[projection.key] = value;
      } else if (value !== undefined) {
        throw new Error(
          `Derived event projection must resolve to scalar: ${projection.ref}.${projection.path}`,
        );
      }
    }

    const contract = this.store.getDerivedContract(
      spec.name,
      spec.contractVersion,
    );
    if (!contract) {
      const error = new Error(
        `Derived contract missing for ${spec.name}@${spec.contractVersion}`,
      );
      error.code = 'DERIVED_CONTRACT_NOT_FOUND';
      throw error;
    }

    const data = {
      ...(spec.constants ?? {}),
      ...projected,
      _derived: {
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
        matchId: match.matchId,
        correlationKey: match.correlationKey,
        contractVersion: spec.contractVersion,
        schemaFingerprint: contract.schemaFingerprint,
      },
    };
    const payloadHash = await sha256Hex(data);
    const event = {
      traceId: `derived:${eventId}`,
      sourceEventId: eventId,
      name: spec.name,
      occurredAt: match.updatedAt,
      provider: 'event-intelligence',
      serverId: DERIVED_EVENT_SERVER_ID,
      payloadHash,
      data,
    };
    const record = parseDerivedEventRecord({
      event,
      triggerId: definition.triggerId,
      triggerVersion: definition.version,
      matchId: match.matchId,
      directParents,
      rootEvidence: dedupeEvidence(rootEvidence),
      createdAt: this.now().toISOString(),
    });

    const receipt = await this.store.appendDerivedEvent(record);
    if (!receipt.accepted) {
      await this.audit(receipt.record, 'derived_event.replayed', {
        reason: 'store_dedup',
      });
      return {
        status: 'replayed',
        accepted: false,
        record: receipt.record,
      };
    }

    await this.audit(record, 'derived_event.created', {
      parentCount: record.directParents.length,
      rootEvidenceCount: record.rootEvidence.length,
    });

    return {
      status: 'created',
      accepted: true,
      record,
    };
  }

  async audit(record, kind, details) {
    await this.store.appendAudit({
      auditId: `audit_${(
        await sha256Hex({
          kind,
          sourceEventId: record.event.sourceEventId,
          sequence: this.store.auditLength(),
        })
      ).slice(0, 24)}`,
      traceId: record.event.traceId,
      timestamp: this.now().toISOString(),
      kind,
      entityType: 'derived_event',
      entityId: record.event.sourceEventId,
      details: {
        triggerId: record.triggerId,
        triggerVersion: record.triggerVersion,
        matchId: record.matchId,
        eventName: record.event.name,
        ...details,
      },
    });
  }
}
