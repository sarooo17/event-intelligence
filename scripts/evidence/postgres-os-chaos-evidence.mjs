import assert from 'node:assert/strict';

/**
 * Validate every raw, per-round OS process/receipt proof. Summary totals
 * alone are not a valid durable-chaos claim: incomplete or malformed rows
 * must prevent any successful artifact from being published.
 */
export function validateRoundEvidence(data,rounds) {
  assert.equal(data.evidence?.length,rounds);
  const matches=new Set(),wakes=new Set();
  for(let round=0;round<rounds;round++) {
    const row=data.evidence[round];
    assert.equal(row?.round,round,'missing/reordered crash recovery round');
    assert.equal(row.signal,'SIGKILL');
    assert.ok(Number.isSafeInteger(row.killedPid)&&row.killedPid>0);
    assert.ok(Array.isArray(row.successorPids) &&
      row.successorPids.length===2 &&
      row.successorPids.every(x=>Number.isSafeInteger(x)&&x>0) &&
      new Set(row.successorPids).size===2 &&
      !row.successorPids.includes(row.killedPid));
    assert.equal(row.attempts,1);
    assert.equal(row.effects,1);
    assert.equal(row.deliveryGeneration,1);
    assert.ok(typeof row.matchId==='string'&&row.matchId.length>0);
    assert.ok(typeof row.wakeId==='string'&&row.wakeId.length>0);
    assert.equal(row.receiptId,'fixture-external:'+row.wakeId);
    assert.equal(matches.has(row.matchId),false,'replayed logical match');
    assert.equal(wakes.has(row.wakeId),false,'replayed wake id');
    matches.add(row.matchId);
    wakes.add(row.wakeId);
  }
  return true;
}
