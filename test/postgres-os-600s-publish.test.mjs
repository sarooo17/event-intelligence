import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {publishContinuousSoakManifest} from '../scripts/evidence/postgres-os-600s-publish.mjs';

test('completed manifest is published only without a cancellation race',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-soak-publish-'));
  const target=join(dir,'manifest.json');
  try{
    await publishContinuousSoakManifest(target,{status:'completed'},{
      isInterrupted:()=>false,
    });
    assert.equal(JSON.parse(await readFile(target,'utf8')).status,'completed');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('cancel during awaited manifest writer removes its success-shaped file',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-soak-publish-'));
  const target=join(dir,'manifest.json');
  let cancelled=false;
  try{
    await assert.rejects(publishContinuousSoakManifest(
      target,{status:'completed'},{
        isInterrupted:()=>cancelled,
        async write(path,bytes,options){
          const {writeFile}=await import('node:fs/promises');
          await writeFile(path,bytes,options);
          cancelled=true; // SIGTERM observed while outer await is pending
        },
      },
    ),/interrupted during manifest publication/);
    await assert.rejects(readFile(target),e=>e?.code==='ENOENT');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed partial write is scrubbed, never promoted to a completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-soak-publish-'));
  const target=join(dir,'manifest.json');
  try{
    await assert.rejects(publishContinuousSoakManifest(
      target,{status:'completed'},{
        isInterrupted:()=>false,
        async write(path,bytes,options){
          const {writeFile}=await import('node:fs/promises');
          await writeFile(path,bytes.slice(0,23),options);
          throw new Error('filesystem aborted mid-write');
        },
      },
    ),/filesystem aborted mid-write/);
    await assert.rejects(readFile(target),e=>e?.code==='ENOENT');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('already cancelled and missing interrupt observer fail closed',async()=>{
  let writes=0;
  await assert.rejects(publishContinuousSoakManifest('/no/manifest',{},{
    isInterrupted:()=>true,
    async write(){writes++},
  }),/interrupted/);
  assert.equal(writes,0);
  await assert.rejects(publishContinuousSoakManifest('/no/manifest',{}),
    /interrupt observer is required/);
});
