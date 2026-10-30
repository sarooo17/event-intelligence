import {performance} from 'node:perf_hooks';

// Bounded diagnostics only. This measures observed host callback duration
// including any I/O, NOT independent production runtime SLO or pure EI core
// overhead. No metrics are fed into authorization or runtime admission.
export async function measureHostBoundary({
  operation,label,samples=100,warmup=10,clock=()=>performance.now(),
}={}){
  if(typeof operation!=='function'||typeof label!=='string'||!label||
     !Number.isSafeInteger(samples)||samples<20||samples>1000||
     !Number.isSafeInteger(warmup)||warmup<0||warmup>100||
     typeof clock!=='function')
    throw new TypeError('Bounded host boundary benchmark requires valid inputs');
  for(let i=0;i<warmup;i++)await operation();
  const values=[];
  for(let i=0;i<samples;i++){
    const begin=clock();
    await operation();
    const elapsed=clock()-begin;
    if(!Number.isFinite(elapsed)||elapsed<0)
      throw new Error('HOST_BOUNDARY_CLOCK_INVALID');
    values.push(elapsed);
  }
  values.sort((a,b)=>a-b);
  const round=n=>Math.round(n*1000)/1000;
  const percentile=p=>round(values[Math.max(0,Math.ceil(p*values.length)-1)]);
  return Object.freeze({
    schema:'ei.host-boundary-diagnostic.v1',
    label,samples,warmup,
    durationUnit:'ms',
    p50:percentile(0.50),
    p95:percentile(0.95),
    p99:percentile(0.99),
    max:round(values.at(-1)),
    measurement:'local adapter call plus host callbacks and any DB roundtrips',
    eiCoreOverheadIsolated:false,
    representativeExternalHostMeasured:false,
    productionSloCertified:false,
    costOrInvoiceCertified:false,
  });
}
