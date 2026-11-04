import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const V1_REQUIRED_CRITERIA = Object.freeze([
  'host-contract-and-package',
  'security-revocation-and-tenant',
  'pg-retention-audit',
  'pg-chaos-recovery',
  'stored-state-upgrade',
  'packed-v1-and-breaking-notes',
  'downstream-pin-policy',
  // 2026-10-31 explicit product-owner SDK v1 scope: #48 and #49
  // are mandatory as bounded SDK contracts, not third-party certificates.
  'full-explainability',
  'semantic-triage',
]);
export const V1_OPTIONAL_CRITERIA = Object.freeze([
  // Product owner waived a SECOND developer under issue #42. Never mark
  // independent external adoption verified without actual external proof.
  'embedded-host-independent',
  // Real production/deployed-host claims are separate from generic SDK correctness.
  'security-independent-review',
  'pg-scale-measured',
  'external-source-finality',
  'provider-billing-and-cancel',
  'production-host-ha-slo',
]);

// Acceptance ownership is part of the v1 contract; an otherwise valid
// evidence URL for #42 must not silently certify a #45 security requirement.
export const V1_CRITERION_ISSUES = Object.freeze({
  'embedded-host-independent':42,
  'host-contract-and-package':42,
  'security-independent-review':317,
  'security-revocation-and-tenant':45,
  'pg-retention-audit':47,
  'pg-chaos-recovery':47,
  'pg-scale-measured':376,
  'stored-state-upgrade':50,
  'packed-v1-and-breaking-notes':50,
  'downstream-pin-policy':50,
  'full-explainability':48,
  'semantic-triage':49,
  'external-source-finality':376,
  'provider-billing-and-cancel':376,
  'production-host-ha-slo':376,
});

function validSignoffDate(date) {
  if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp=Date.parse(date+'T00:00:00.000Z');
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0,10)===date &&
    date<=new Date().toISOString().slice(0,10);
}

/**
 * Evidence ledger checker, not a substitute for independent reviewer
 * judgments. A ledger "verified" line must have a concrete evidence URL and
 * reviewer record; the checker never marks anything verified automatically.
 */
export function evaluateV1Readiness(ledger, packageVersion, { expectedSourceSha } = {}) {
  const expected = new Map([
    ...V1_REQUIRED_CRITERIA.map(id=>[id,true]),
    ...V1_OPTIONAL_CRITERIA.map(id=>[id,false]),
  ]);
  const errors=[];
  // An approved record must refer to the exact source tree being published.
  // The publish/release workflows derive this SHA from the checked-out Git
  // commit and do not trust a user-supplied issue or comment as the source.
  if (expectedSourceSha !== undefined &&
      (typeof expectedSourceSha !== 'string' ||
       !/^[0-9a-f]{40}$/.test(expectedSourceSha))) {
    errors.push('Invalid exact release source SHA');
  }
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
      row.issue !== V1_CRITERION_ISSUES[row.id] ||
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
         !validSignoffDate(row.verification.date)) {
        errors.push('Verified criterion lacks independent/manual audit evidence: '+row.id);
      }
      if (expectedSourceSha !== undefined &&
          !/^[0-9a-f]{40}$/.test(row.verification?.sourceCommitSha??'')) {
        errors.push('Verified criterion lacks reviewed immutable source SHA: '+row.id);
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

/**
 * Ledger signoff changes must NOT require their own not-yet-existing commit
 * hash (a cryptographic fixed point). Each reviewer pins a *prior, reviewed*
 * source commit, and strict release checks that it is an ancestor of HEAD
 * with ZERO differences in the entire release tree except this ledger.
 * Therefore all runtime code, package identity, release notes, CI gates and
 * published files must already be frozen BEFORE signoff is recorded.
 *
 * runGit is injectable to test the guard without a local Git repository.
 * No untrusted shell interpolation, network access, source modification,
 * tag creation or package publication occurs.
 */
export function verifyV1ReviewedSource(ledger, headSha, runGit = args =>
  execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),
  trustedMainSha = headSha) {
  const errors=[];
  if (!/^[0-9a-f]{40}$/.test(headSha??'')) {
    return ['Invalid checked-out release source SHA'];
  }
  try {
    if (runGit(['rev-parse','HEAD'])!==headSha) {
      errors.push('Checked-out HEAD does not match immutable workflow source SHA');
      return errors;
    }
  } catch {
    return ['Cannot verify checked-out release Git HEAD'];
  }
  if(!/^[0-9a-f]{40}$/.test(trustedMainSha??'')){
    return ['Invalid trusted main source SHA'];
  }
  // A PR can create an unmerged source commit C and then add a ledger
  // attestation at D. C is an ancestor of D but was NEVER approved on main.
  // The protected-main baseline comes from GitHub's trusted PR event, not
  // from this PR's branch or a user-authored ledger field.
  if(trustedMainSha!==headSha){
    try {
      runGit(['merge-base','--is-ancestor',trustedMainSha,headSha]);
    } catch {
      errors.push('Trusted main source is not an ancestor of checked-out HEAD');
      return errors;
    }
  }
  const verifiedRequired=(ledger?.criteria??[]).filter(row=>
    row?.required===true && row?.status==='verified');
  for(const reviewedSha of new Set(verifiedRequired.map(row=>
    row.verification?.sourceCommitSha))) {
    if(!/^[0-9a-f]{40}$/.test(reviewedSha??'')){
      errors.push('Verified release row lacks immutable source SHA');
      continue;
    }
    try {
      runGit(['merge-base','--is-ancestor',reviewedSha,trustedMainSha]);
    } catch {
      errors.push('Reviewed release source is not on trusted main baseline: '+reviewedSha);
      continue;
    }
    try {
      // Only the attestations in THIS ledger can differ. Release notes and
      // every other path must exactly match the source actually reviewed.
      runGit(['diff','--quiet',reviewedSha,headSha,'--','.',
        ':(exclude)docs/releases/v1-readiness.json']);
    } catch {
      errors.push('Release source differs from reviewed source outside readiness ledger: '+reviewedSha);
    }
  }
  return errors;
}

export function readV1Readiness(cwd = new URL('../../',import.meta.url), options = {}) {
  const root=typeof cwd==='string'?new URL('file://'+resolve(cwd)+'/'):cwd;
  const ledger=JSON.parse(readFileSync(new URL('docs/releases/v1-readiness.json',root)));
  const pkg=JSON.parse(readFileSync(new URL('package.json',root)));
  return evaluateV1Readiness(ledger,pkg.version,options);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2]??'--report';
  if(!['--report','--strict','--review-attestations'].includes(mode) ||
      process.argv.length>3) {
    console.error('Usage: node scripts/evidence/v1-release-readiness.mjs [--report|--strict|--review-attestations]');
    process.exitCode=2;
  } else {
    // --review-attestations is a source-provenance-only preflight for an
    // incremental ledger (e.g. 5/9 gates). It NEVER converts a blocked
    // release into an eligible one. --strict additionally requires 9/9.
    const reviewSource=mode!=='--report';
    const expectedSha=process.env.EI_RELEASE_SOURCE_SHA??'';
    const report=readV1Readiness(new URL('../../',import.meta.url),
      reviewSource ? {expectedSourceSha:expectedSha} : {});
    let released=report;
    if(reviewSource && !report.errors.length &&
       (mode==='--review-attestations' ||
        report.status==='eligible-for-manual-review')){
      const ledger=JSON.parse(readFileSync(new URL(
        '../../docs/releases/v1-readiness.json',import.meta.url)));
      // On PRs GitHub supplies a trusted BASE SHA; this value is not
      // derived from the untrusted PR or ledger contents.
      // --strict runs on source-frozen main; its trusted baseline is HEAD.
      const trustedMain=mode==='--review-attestations'
        ? (process.env.EI_RELEASE_REVIEWED_MAIN_SHA??null)
        : expectedSha;
      const provenanceErrors=verifyV1ReviewedSource(
        ledger,expectedSha,undefined,trustedMain);
      if(provenanceErrors.length){
        released={...report,status:'blocked',autoPublish:false,
          blocked:[...report.blocked,'reviewed-source-code-drift'],
          errors:[...report.errors,...provenanceErrors]};
      }
    }
    console.log(JSON.stringify(released,null,2));
    if(released.errors.length ||
       (mode==='--strict' && released.status!=='eligible-for-manual-review')){
      process.exitCode=1;
    }
  }
}
