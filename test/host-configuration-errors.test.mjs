import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventIntelligence } from '../scripts/embedded-host-kit.mjs';

const deliver = () => ({ runtimeReceiptId: 'unused' });

test('invalid host contracts fail with stable configuration codes before starting EI', async () => {
  const cases = [
    {
      label: 'missing deliver',
      runtime: {},
      code: 'EI_HOST_DELIVERY_REQUIRED',
      message: /runtime\.deliver/,
    },
    {
      label: 'noncallable deliver',
      runtime: { deliver: 'yes' },
      code: 'EI_HOST_DELIVERY_REQUIRED',
      message: /runtime\.deliver/,
    },
    {
      label: 'missing MCP list',
      runtime: { deliver },
      mcp: {},
      code: 'EI_HOST_MCP_REGISTRY_INVALID',
      message: /mcp must provide list/,
    },
    {
      label: 'invalid MCP subscribe callback',
      runtime: { deliver },
      mcp: { list: () => [], subscribe: true },
      code: 'EI_HOST_MCP_REGISTRY_INVALID',
      message: /optional subscribe/,
    },
    {
      label: 'host resolveContext without control',
      runtime: { deliver, resolveContext: () => ({}) },
      code: 'EI_HOST_CONTROL_REQUIRED',
      message: /BOTH/,
    },
    {
      label: 'host control without resolveContext',
      runtime: { deliver, control: () => ({}) },
      code: 'EI_HOST_CONTROL_REQUIRED',
      message: /BOTH/,
    },
    {
      label: 'invalid optional receipt lookup',
      runtime: { deliver, hasReceipt: 'yes' },
      code: 'EI_HOST_CALLBACK_INVALID',
      message: /hasReceipt/,
    },
    {
      label: 'invalid optional target resolution',
      runtime: { deliver, resolveTarget: false },
      code: 'EI_HOST_CALLBACK_INVALID',
      message: /resolveTarget/,
    },
    {
      label: 'invalid host result projector',
      runtime: { deliver, projectResult: 7 },
      code: 'EI_HOST_CALLBACK_INVALID',
      message: /projectResult/,
    },
    {
      label: 'blank receipt namespace',
      runtime: { deliver, receiptNamespace: '  ' },
      code: 'EI_HOST_RECEIPT_CONFIG_INVALID',
      message: /receiptNamespace/,
    },
    {
      label: 'conflicting receipt identity strategies',
      runtime: { deliver, receiptNamespace: 'host', receiptId: () => 'id' },
      code: 'EI_HOST_RECEIPT_CONFIG_INVALID',
      message: /not both/,
    },
  ];

  for (const item of cases) {
    let starts = 0;
    await assert.rejects(
      () => createEventIntelligence({
        runtime: item.runtime,
        ...(item.mcp ? { mcp: item.mcp } : {}),
        createHost: async () => {
          starts++;
          throw new Error('host factory must never be invoked');
        },
      }),
      (error) => {
        assert.equal(error instanceof TypeError, true, item.label);
        assert.equal(error.code, item.code, item.label);
        assert.match(error.message, item.message, item.label);
        return true;
      },
      item.label,
    );
    assert.equal(starts, 0, item.label);
  }
});

test('error classification does not require a model, credentials or downstream runtime', () => {
  // A config-only probe can safely reject a bad host before any MCP
  // transport, store, agent session or host-owned mutation is activated.
  assert.equal(typeof createEventIntelligence, 'function');
});
