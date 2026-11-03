import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One canonical version parser BEFORE routing npm dist-tags or MCP Registry.
// npm may normalize build metadata (e.g. 1.0.0+build-foo -> 1.0.0);
// it must never bypass the stable-v1 readiness gate via a literal hyphen.
// Treat unknown future stable-major policy as fail-closed, not as approved.
export function classifySafeReleaseVersion(version) {
  if(typeof version!=='string' || !version ||
     version.includes('+') || version.length>96) {
    const error=new Error('Unsupported npm version or build metadata');
    error.code='EI_RELEASE_VERSION_NOT_CANONICAL';
    throw error;
  }
  const match=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if(!match) {
    const error=new Error('Unsupported noncanonical npm semver');
    error.code='EI_RELEASE_VERSION_NOT_CANONICAL';
    throw error;
  }
  const prerelease=match[4]??null;
  if(prerelease!==null) {
    const fields=prerelease.split('.');
    if(fields.some(v=>!v||(/^\d+$/.test(v)&&v.length>1&&v.startsWith('0')))) {
      const error=new Error('Unsupported noncanonical npm prerelease version');
      error.code='EI_RELEASE_VERSION_NOT_CANONICAL';
      throw error;
    }
    return Object.freeze({tag:'next',stableV1:false});
  }
  if(Number(match[1])>=1 && version!=='1.0.0') {
    // This dossier is specifically scoped to the FIRST stable 1.0.0
    // release. Subsequent stable versions require a new reviewed readiness
    // policy (and must never silently inherit old release authorizations).
    const error=new Error('Future stable version requires explicit reviewed release policy');
    error.code='EI_FUTURE_STABLE_POLICY_REQUIRED';
    throw error;
  }
  return Object.freeze({tag:'latest',stableV1:version==='1.0.0'});
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3)throw Error('Expected one exact npm version');
    const result=classifySafeReleaseVersion(process.argv[2]);
    process.stdout.write(result.tag+'\n');
  }catch(error){
    console.error(error.code??'EI_RELEASE_VERSION_NOT_CANONICAL');
    process.exitCode=1;
  }
}
