import {rm,writeFile} from 'node:fs/promises';

/**
 * Publish the only success-shaped continuous-soak artifact. Cancellation
 * during asynchronous publication must not leave a completed manifest on
 * disk. Injecting a writer is for fault-injection tests; callers cannot
 * bypass an explicit cancellation read with a default success value.
 */
export async function publishContinuousSoakManifest(
  manifestPath,manifest,{
    isInterrupted,
    write=writeFile,
    remove=rm,
  }={},
){
  if(typeof isInterrupted!=='function')
    throw new TypeError('an interrupt observer is required');
  if(isInterrupted())throw new Error('continuous PG OS soak interrupted');
  try{
    await write(manifestPath,JSON.stringify(manifest,null,2)+'\n',{
      flag:'wx',mode:0o600,
    });
    if(isInterrupted())throw new Error(
      'continuous PG OS soak interrupted during manifest publication');
  }catch(error){
    // Output directory is newly and exclusively created by the soak runner;
    // even a partial file from a failed write must not look completed.
    try{await remove(manifestPath,{force:true});}
    catch(cleanupError){throw new AggregateError(
      [error,cleanupError],'continuous manifest publication cleanup failed');}
    throw error;
  }
}
