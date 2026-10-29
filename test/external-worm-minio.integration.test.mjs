import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mcpArchiveGenesis } from '../scripts/lib/mcp-occurrence-archive.mjs';
import { signMcpOccurrenceArchiveWitness } from '../scripts/lib/mcp-occurrence-archive-bundle.mjs';
import { signPostgresAuditArchiveWitness } from '../scripts/lib/postgres-audit-archive-bundle.mjs';
import { publishSignedSourceAndAuditWorm } from '../scripts/evidence/postgres-external-worm-archive.mjs';

const integration=process.env.EI_WORM_MINIO_E2E==='YES_DISPOSABLE_OBJECT_LOCK'?test:test.skip;

integration('isolated S3-compatible server: five signed immutable objects, readback and delete denial', {timeout:120000},async()=>{
  // CI starts a disposable independent MinIO process; these credentials are
  // static throwaway fixture credentials, never a user production account.
  const sdk=await import('@aws-sdk/client-s3');
  const {S3Client,CreateBucketCommand,PutObjectCommand,DeleteObjectCommand,HeadObjectCommand,GetObjectCommand}=sdk;
  const client=new S3Client({
    endpoint:'http://127.0.0.1:29000',region:'us-east-1',forcePathStyle:true,
    credentials:{accessKeyId:'ei_disposable_minio',secretAccessKey:'ei_disposable_minio_password'},
    maxAttempts:1,
  });
  const bucket='ei-immutable-archive-ci';
  const scopeId='ci-disposable-scope';
  try {
    await client.send(new CreateBucketCommand({
      Bucket:bucket,ObjectLockEnabledForBucket:true,
    }));
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const privateKeyPem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
    const trustedPublicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
    const genesis=mcpArchiveGenesis(scopeId);
    const sourceCheckpoint={
      schema:'event-intelligence.mcp-occurrence-archive.v1',
      scopeId,endSequence:0,genesisHash:genesis,headHash:genesis,
    };
    const auditCheckpoint={scopeId,endSequence:-1,firstHash:null,headHash:null};
    const sourceArchiveBytes=Buffer.from(JSON.stringify({
      schema:'event-intelligence.mcp-occurrence-bundle.v1',
      checkpoint:sourceCheckpoint,pageSize:250,maxBytes:67108864,pages:[],
    })+'\n');
    const auditArchiveBytes=Buffer.from(JSON.stringify({
      schema:'event-intelligence.postgres-audit-bundle.v1',
      checkpoint:auditCheckpoint,pageSize:250,maxBytes:67108864,pages:[],
    })+'\n');
    const sourceKeyId='ci-external-worm-key';
    const auditKeyId='ci-external-worm-key';
    const sourceWitness=await signMcpOccurrenceArchiveWitness({
      archiveBytes:sourceArchiveBytes,trustedCheckpoint:sourceCheckpoint,
      privateKeyPem,keyId:sourceKeyId,
    });
    const auditWitness=await signPostgresAuditArchiveWitness({
      archiveBytes:auditArchiveBytes,trustedCheckpoint:auditCheckpoint,
      privateKeyPem,keyId:auditKeyId,
    });
    const receipt=await publishSignedSourceAndAuditWorm({
      client,commands:sdk,bucket,retainUntil:new Date(Date.now()+8*24*3600*1000),
      sourceArchiveBytes,sourceWitness,sourceCheckpoint,
      auditArchiveBytes,auditWitness,auditCheckpoint,
      trustedPublicKeyPem,sourceKeyId,auditKeyId,expectedScopeId:scopeId,
    });
    assert.equal(receipt.objects.length,4);
    assert.equal(receipt.manifest.readBackVerified,true);
    assert.equal(receipt.externalReadbackVerified,true);
    assert.equal(receipt.physicalPruneAuthorized,false);
    assert.equal(receipt.productionRetentionCertified,false);
    assert.ok(receipt.objects.every(x=>x.objectLockMode==='COMPLIANCE'));
    const protectedObject=receipt.objects[0];
    let deleteWasDenied=false;
    let outcome={kind:'unexpected-success'};
    try {
      const response=await client.send(new DeleteObjectCommand({
        Bucket:bucket,Key:protectedObject.key,VersionId:protectedObject.versionId,
      }));
      outcome={kind:'unexpected-success',statusCode:response?.$metadata?.httpStatusCode??null};
    }catch(error){
      outcome={kind:'denied',name:error?.name??null,statusCode:error?.$metadata?.httpStatusCode??null};
      deleteWasDenied=['AccessDenied','AccessDeniedException'].includes(error?.name) ||
        error?.$metadata?.httpStatusCode===403;
    }
    console.log(JSON.stringify({event:'s3-retention-delete-verdict',...outcome}));
    // MinIO's S3 implementation returns InvalidRequest/400 for a protected
    // version; AWS S3 returns AccessDenied/403. Neither is sufficient alone.
    // Prove the same caller CAN delete a non-retained disposable object,
    // then prove the original protected version is still intact.
    deleteWasDenied=deleteWasDenied ||
      (outcome.kind==='denied' && outcome.name==='InvalidRequest' &&
       outcome.statusCode===400);
    const controlKey=receipt.namespace+'/delete-control';
    const control=await client.send(new PutObjectCommand({
      Bucket:bucket,Key:controlKey,Body:Buffer.from('disposable'),
    }));
    assert.ok(control.VersionId);
    const controlDelete=await client.send(new DeleteObjectCommand({
      Bucket:bucket,Key:controlKey,VersionId:control.VersionId,
    }));
    assert.ok([200,204].includes(controlDelete.$metadata.httpStatusCode));
    const locked=await client.send(new HeadObjectCommand({
      Bucket:bucket,Key:protectedObject.key,VersionId:protectedObject.versionId,
    }));
    assert.equal(locked.ObjectLockMode,'COMPLIANCE');
    assert.equal(locked.VersionId,protectedObject.versionId);
    const restored=await client.send(new GetObjectCommand({
      Bucket:bucket,Key:protectedObject.key,VersionId:protectedObject.versionId,
    }));
    assert.deepEqual(Buffer.from(await restored.Body.transformToByteArray()),sourceArchiveBytes);
    assert.equal(deleteWasDenied,true,
      'protected COMPLIANCE version must deny deletion while ordinary version deletion works');
    console.log(JSON.stringify({
      schema:'event-intelligence.disposable-s3-object-lock-e2e.v1',
      status:'completed',objectCount:5,versioned:true,
      allObjectsComplianceLocked:true,exactReadbackVerified:true,
      retainedVersionDeletionDenied:true,
      sourceCommitSha:process.env.EI_WORM_SOURCE_SHA||null,
      actualOffHostWormCertified:false,productionRetentionCertified:false,
    }));
  }finally{
    client.destroy();
  }
});
