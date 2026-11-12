'use strict';
function createTenantBillingJobWorker({workerId,processNextBatch,pollIntervalMs=5000,concurrency=4,onError=()=>{}}={}) {
 if(typeof workerId!=='string'||!/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new TypeError('TENANT_BILLING_WORKER_ID_INVALID');
 if(typeof processNextBatch!=='function') throw new TypeError('TENANT_BILLING_PROCESSOR_REQUIRED');
 if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<250||pollIntervalMs>3600000||!Number.isInteger(concurrency)||concurrency<1||concurrency>32||typeof onError!=='function') throw new TypeError('TENANT_BILLING_WORKER_CONFIG_INVALID');
 let timer=null,stopping=false,activeTick=null;
 function report(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)?error.code:'TENANT_BILLING_WORKER_FAILED';try{onError(Object.freeze({code,workerId}));}catch(_){}}
 async function lane(){try{const r=await processNextBatch({workerId});if(!r||typeof r!=='object'||typeof r.worked!=='boolean')throw Object.assign(new Error('TENANT_BILLING_PROCESSOR_RESULT_INVALID'),{code:'TENANT_BILLING_PROCESSOR_RESULT_INVALID'});return Object.freeze({worked:r.worked,appId:r.appId||null,state:r.state||null});}catch(e){report(e);return Object.freeze({worked:false,errorCode:typeof e?.code==='string'?e.code:'TENANT_BILLING_WORKER_FAILED'});}}
 async function tick(){if(stopping||activeTick)return Object.freeze({skipped:true});const current=(async()=>{const results=await Promise.all(Array.from({length:concurrency},()=>lane()));return Object.freeze({concurrency,worked:results.filter(x=>x.worked).length,idle:results.filter(x=>!x.worked&&!x.errorCode).length,failed:results.filter(x=>x.errorCode).length,results});})();activeTick=current;try{return await current;}finally{if(activeTick===current)activeTick=null;}}
 function start(){if(stopping)throw new Error('TENANT_BILLING_WORKER_STOPPED');if(timer)return false;timer=setInterval(()=>{void tick();},pollIntervalMs);if(typeof timer.unref==='function')timer.unref();void tick();return true;}
 async function stop(){stopping=true;if(timer)clearInterval(timer);timer=null;if(activeTick)await activeTick;}
 return Object.freeze({start,tick,stop,isRunning:()=>Boolean(timer)&&!stopping});
}
module.exports={createTenantBillingJobWorker};
