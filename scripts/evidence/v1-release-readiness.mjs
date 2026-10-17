import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const V1_REQUIRED_CRITERIA = Object.freeze([
  'embedded-host-independent',
  'host-contract-and-package',
  'security-independent-review',
  'security-revocation-and-tenant',
  'pg-retention-audit',
  'pg-chaos-recovery',
  'pg-scale-measured',
  'stored-state-upgrade',
  'packed-v1-and-breaking-notes',
  'downstream-pin-policy',
]);
export const V1_OPTIONAL_CRITERIA = Object.freeze([
  'full-explainability',
  'semantic-triage',
]);

/**
 * Evidence ledger checker, not a substitute for independent reviewer
 * judgments. A ledger "verified" line must have a concrete evidence URL and
 * reviewer record; the checker never marks anything verified automatically.
 */
export function evaluateV1Readiness(ledger, packageVersion) {
  const expected = new Map([
    ...V1_REQUIRED_CRITERIA.map(id=>[id,true]),
    ...V1_OPTIONAL_CRITERIA.map(id=>[id,false]),
  ]);
  const errors=[];
  if (ledger?.schema !== 'event-intelligence.v1-readiness.v1' ||
      ledger?.targetVersion !== '1.0.0' ||
      ledger?.policy !== 'fail-closed-no-automatic-merge-or-publish' ||
      !Array.isArray(ledger?.criteria)) {
    errors.push('Invalid v1 readiness manifest shape/version/policy');
  }

  const seen=new Set();
  for(const row of Array.isArray(ledger?.criteria)?ledger.criteria:[]) {
    if(!row || typeof row!=='object' || typeof row.id!=='string' ||
       !expected.has(row.id) || seen.has(row.id)) {
      errors.push('Unknown/duplicate readiness criterion');
      continue;
    }
    seen.add(row.id);
    if(row.required!==expected.get(row.id) ||
      !Number.isInteger(row.issue) || ![42,45,47,48,49,50].includes(row.issue) ||
      !['blocked','verified'].includes(row.status) ||
      typeof row.note!=='string' || !row.note.trim() ||
      !Array.isArray(row.evidence)) {
      errors.push('Invalid criterion shape: '+row.id);
      continue;
    }
    if(row.status==='verified') {
      // No unverifiable green flags: manual signoff + concrete links required.
      if(!row.evidence.length ||
         !row.evidence.every(e=>typeof e==='string' &&
           /^https:\/\/[a-z0-9.-]+\/[^\s]+$/i.test(e)) ||
         !row.verification || typeof row.verification.reviewer!=='string' ||
         !row.verification.reviewer.trim() ||
         typeof row.verification.procedure!=='string' ||
         !row.verification.procedure.trim() ||
         !/^\d{4}-\d\d-\d\d$/.test(row.verification.date)) {
        errors.push('Verified criterion lacks independent/manual audit evidence: '+row.id);
      }
    }
  }
  for(const id of expected.keys()) if(!seen.has(id))errors.push('Missing criterion: '+id);

  const rows=Array.isArray(ledger?.criteria)?ledger.criteria.filter(row=>
    row && typeof row.id==='string' && expected.has(row.id)): [];
  const blocked=rows.filter(row=>row.required && row.status!=='verified')
    .map(row=>row.id);
  if(packageVersion!=='1.0.0')blocked.push('package-version-not-1.0.0');
  if(errors.length) blocked.push('malformed-evidence-ledger');

  return Object.freeze({
    schema:'event-intelligence.v1-readiness-report.v1',
    targetVersion:'1.0.0',
    candidateVersion:packageVersion,
    status:blocked.length ? 'blocked':'eligible-for-manual-review',
    // "eligible" is NOT proof of a safe release, nor an instruction to publish.
    autoPublish:false,
    requiredCount:V1_REQUIRED_CRITERIA.length,
    optionalCount:V1_OPTIONAL_CRITERIA.length,
    blocked:Object.freeze(blocked),
    errors:Object.freeze(errors),
  });
}

export function readV1Readiness(cwd = new URL('../../',import.meta.url)) {
  const root=typeof cwd==='string'?new URL('file://'+resolve(cwd)+'/'):cwd;
  const ledger=JSON.parse(readFileSync(new URL('docs/releases/v1-readiness.json',root)));
  const pkg=JSON.parse(readFileSync(new URL('package.json',root)));
  return evaluateV1Readiness(ledger,pkg.version);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2]??'--report';
  if(!['--report','--strict'].includes(mode) || process.argv.length>3) {
    console.error('Usage: node scripts/evidence/v1-release-readiness.mjs [--report|--strict]');
    process.exitCode=2;
  } else {
    const report=readV1Readiness();
    console.log(JSON.stringify(report,null,2));
    if(report.errors.length || mode==='--strict' && report.status!=='eligible-for-manual-review'){
      process.exitCode=1;
    }
  }
}
