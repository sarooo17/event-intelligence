import {
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sameProducer(left, right) {
  return (
    left.triggerId === right.triggerId &&
    left.triggerVersion === right.triggerVersion
  );
}

export class DerivedContractRegistry {
  constructor({
    store,
    audit = null,
    now = () => new Date(),
  }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
  }

  async fingerprint(payloadSchema) {
    return sha256Hex(canonicalize(payloadSchema ?? {}));
  }

  list(eventName) {
    return this.store.listDerivedContracts(eventName);
  }

  get(eventName, contractVersion) {
    return this.store.getDerivedContract(eventName, contractVersion);
  }

  async assertCompatible({
    eventName,
    contractVersion,
    payloadSchema,
  }) {
    const canonicalSchema = canonicalize(payloadSchema ?? {});
    const schemaFingerprint = await this.fingerprint(canonicalSchema);
    const existing = this.get(eventName, contractVersion);
    if (
      existing &&
      existing.schemaFingerprint !== schemaFingerprint
    ) {
      const error = new Error(
        `Derived event contract conflict for ${eventName}@${contractVersion}`,
      );
      error.code = 'DERIVED_CONTRACT_SCHEMA_CONFLICT';
      error.details = {
        eventName,
        contractVersion,
        existingFingerprint: existing.schemaFingerprint,
        rejectedFingerprint: schemaFingerprint,
      };
      throw error;
    }
    return {
      payloadSchema: canonicalSchema,
      schemaFingerprint,
      existing,
    };
  }

  async registerProducer({
    eventName,
    contractVersion,
    payloadSchema,
    producer,
  }) {
    const canonicalSchema = canonicalize(payloadSchema ?? {});
    const schemaFingerprint = await this.fingerprint(canonicalSchema);
    const existing = this.get(eventName, contractVersion);

    if (
      existing &&
      existing.schemaFingerprint !== schemaFingerprint
    ) {
      await this.audit?.({
        kind: 'derived_contract.conflict',
        entityType: 'derived_contract',
        entityId: `${eventName}@${contractVersion}`,
        traceId: `derived-contract:${eventName}@${contractVersion}`,
        details: {
          eventName,
          contractVersion,
          existingFingerprint: existing.schemaFingerprint,
          rejectedFingerprint: schemaFingerprint,
          producer,
        },
      });

      const error = new Error(
        `Derived event contract conflict for ${eventName}@${contractVersion}`,
      );
      error.code = 'DERIVED_CONTRACT_SCHEMA_CONFLICT';
      error.details = {
        eventName,
        contractVersion,
        existingFingerprint: existing.schemaFingerprint,
        rejectedFingerprint: schemaFingerprint,
      };
      throw error;
    }

    const producers = existing
      ? [...existing.producers]
      : [];
    if (!producers.some((candidate) => sameProducer(candidate, producer))) {
      producers.push({
        triggerId: String(producer.triggerId),
        triggerVersion: String(producer.triggerVersion),
      });
    }

    const record = await this.store.putDerivedContract({
      eventName,
      contractVersion,
      payloadSchema: canonicalSchema,
      schemaFingerprint,
      producers,
    });

    await this.audit?.({
      kind: existing
        ? 'derived_contract.producer_registered'
        : 'derived_contract.created',
      entityType: 'derived_contract',
      entityId: `${eventName}@${contractVersion}`,
      traceId: `derived-contract:${eventName}@${contractVersion}`,
      details: {
        eventName,
        contractVersion,
        schemaFingerprint,
        producer,
        producerCount: record.producers.length,
      },
    });

    return {
      status: existing ? 'producer_registered' : 'created',
      record,
    };
  }

  resolveConsumer({
    eventName,
    contractVersion,
  }) {
    const contracts = this.list(eventName);

    if (contractVersion) {
      const contract = contracts.find(
        (candidate) =>
          candidate.contractVersion === String(contractVersion),
      );
      if (!contract) {
        const error = new Error(
          `Unknown derived event contract ${eventName}@${contractVersion}`,
        );
        error.code = 'DERIVED_CONTRACT_NOT_FOUND';
        throw error;
      }
      return contract;
    }

    if (contracts.length === 1) {
      return contracts[0];
    }

    if (contracts.length === 0) {
      const error = new Error(
        `No derived event contract registered for ${eventName}`,
      );
      error.code = 'DERIVED_CONTRACT_NOT_FOUND';
      throw error;
    }

    const error = new Error(
      `Derived event consumer is ambiguous for ${eventName}; explicit contractVersion required`,
    );
    error.code = 'DERIVED_CONTRACT_AMBIGUOUS';
    error.details = {
      eventName,
      availableVersions: contracts.map(
        (contract) => contract.contractVersion,
      ),
    };
    throw error;
  }
}
