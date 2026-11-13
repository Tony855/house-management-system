'use strict';
const crypto = require('node:crypto');
const {resolveTenantContext}=require('./tenant-registry');
const {createTenantRepository}=require('./tenant-repository');
const {createTenantSystemWriteService}=require('./tenant-system-write-service');
const {createMariaDbTenantWriteAuditStore}=require('./tenant-write-audit-mariadb');
const {createMariaDbTenantWriteIdempotencyStore}=require('./tenant-write-idempotency-mariadb');
const {buildNextRentalBill}=require('../services/rental-api/write-routes');
const {buildPropertyFeeBill}=require('../services/shared/property-fee-routes');
const JOBS={rental:'rental_bill',property:'property_fee'},CHUNK_SIZE=50,LEASE_SECONDS=120,MAX_ATTEMPTS=8,MAX_CHUNK_SIZE=200;
const dateOnly=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
function withTimeout(operation,timeoutMs,code){
 let timer;
 const pending=Promise.resolve().then(operation);
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(code,503)),timeoutMs);});
 return Promise.race([pending,timeout]).finally(()=>clearTimeout(timer));
}
function fail(code,status=409){return Object.assign(new Error(code),{code,status});}
function createTenantBillingJobProcessor({registry,secretProvider,tenantPoolManager,authorizeSystem,appIds=['rental','property'],leaseSeconds=LEASE_SECONDS,chunkSize=CHUNK_SIZE,scanTimeoutMs=30000,createToken=crypto.randomUUID}={}){
 if(!registry||typeof registry.findTenantById!=='function'||typeof registry.listActiveTenants!=='function')throw new TypeError('BILLING_PROCESSOR_REGISTRY_REQUIRED');
 if(!secretProvider||typeof secretProvider.getDatabaseCredentials!=='function')throw new TypeError('BILLING_PROCESSOR_SECRET_PROVIDER_REQUIRED');
 if(!tenantPoolManager||typeof tenantPoolManager.getPool!=='function')throw new TypeError('BILLING_PROCESSOR_POOL_MANAGER_REQUIRED');
 if(typeof authorizeSystem!=='function')throw new TypeError('BILLING_PROCESSOR_SYSTEM_AUTHORIZER_REQUIRED');
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600||!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>MAX_CHUNK_SIZE||!Number.isInteger(scanTimeoutMs)||scanTimeoutMs<1||scanTimeoutMs>300000||typeof createToken!=='function')throw new TypeError('BILLING_PROCESSOR_LEASE_CONFIG_INVALID');
 if(!Array.isArray(appIds)||appIds.length<1||appIds.some(app=>!Object.hasOwn(JOBS,app))||new Set(appIds).size!==appIds.length)throw new TypeError('BILLING_PROCESSOR_APP_SCOPE_INVALID');
 const systemWrite=createTenantSystemWriteService({authorizeSystem,auditWriter:createMariaDbTenantWriteAuditStore(),idempotencyStore:createMariaDbTenantWriteIdempotencyStore()});
 const scanCursors=new Map(appIds.map(appId=>[appId,'']));
 const scanQueues=new Map();
 async function nextTenantPage(appId,limit){
  const previous=scanQueues.get(appId)||Promise.resolve();
  const operation=previous.then(async()=>{
   const afterTenantId=scanCursors.get(appId)||'';
   const page=await withTimeout(()=>registry.listActiveTenants({appId,afterTenantId,limit}),scanTimeoutMs,'BILLING_TENANT_SCAN_TIMEOUT');
   if(!page||!Array.isArray(page.tenantIds)||page.tenantIds.length>limit||
      (page.nextCursor!==null&&typeof page.nextCursor!=='string')||
      page.tenantIds.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))||
      (page.nextCursor!==null&&(!page.tenantIds.length||page.nextCursor!==page.tenantIds[page.tenantIds.length-1]))){
    throw fail('BILLING_TENANT_SCAN_RESULT_INVALID',503);
   }
   if(page.nextCursor&&page.nextCursor===afterTenantId)throw fail('BILLING_TENANT_SCAN_CURSOR_STALLED',503);
   scanCursors.set(appId,page.nextCursor||'');
   return page;
  });
  scanQueues.set(appId,operation.then(()=>undefined,()=>undefined));
  return operation;
 }
 async function processTenant({tenantId,appId,workerId}){
  if(!Object.hasOwn(JOBS,appId))throw fail('BILLING_PROCESSOR_APP_INVALID',400);
  if(typeof workerId!=='string'||!/^[A-Za-z0-9._:-]{1,100}$/.test(workerId))throw fail('BILLING_PROCESSOR_WORKER_INVALID',400);
  const context=await resolveTenantContext({auth:{authenticated:true,tenantId,appId},appId,registry,secretProvider});
  const pool=await tenantPoolManager.getPool(context),repository=createTenantRepository({pool,appId});
  const table=appId==='rental'?'rental_bill_generation_jobs':'property_fee_generation_jobs';
  const dateCol=appId==='rental'?'as_of_date':'billing_month',cursorCol=appId==='rental'?'cursor_contract_id':'cursor_room_id';
  const leaseToken=createToken();
  if(typeof leaseToken!=='string'||!/^[0-9a-f-]{36}$/i.test(leaseToken))throw fail('BILLING_PROCESSOR_LEASE_TOKEN_INVALID',500);
  await pool.execute("UPDATE "+table+" SET state='dead_letter',last_error='BILLING_RETRY_LIMIT_EXCEEDED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=UTC_TIMESTAMP() WHERE attempt_count>=? AND ((state='queued') OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP())))",[MAX_ATTEMPTS]);
  const [claim]=await pool.execute(
   "UPDATE "+table+" SET state='running',lease_owner=?,lease_token=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL "+leaseSeconds+" SECOND) WHERE id=(SELECT id FROM (SELECT id FROM "+table+" WHERE attempt_count<? AND ((state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=UTC_TIMESTAMP())) OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP()))) ORDER BY id LIMIT 1) AS eligible)",
   [workerId,leaseToken,MAX_ATTEMPTS]
  );
  if(Number(claim.affectedRows)!==1)return Object.freeze({worked:false,appId,state:'idle'});
  const [found]=await pool.execute('SELECT id,'+dateCol+' AS period_key,state,'+cursorCol+' AS cursor_id,attempt_count FROM '+table+' WHERE lease_token=? AND lease_owner=? LIMIT 1',[leaseToken,workerId]);
  if(!found.length)return Object.freeze({worked:false,appId,state:'lease_lost'});
  const candidate=found[0],cursor=Number(candidate.cursor_id||0),attempt=Number(candidate.attempt_count||0),requestId='system-billing-'+tenantId+'-'+candidate.id+'-'+cursor;
  const payload={job_id:Number(candidate.id),cursor_id:cursor,__resource:table+'-worker'};
  let result;try{result=await systemWrite.execute({workerId,appId,tenantId,tenantContext:context,repository,jobType:JOBS[appId],requestId,payload,mutate:async tx=>{
   const [locked]=await tx.execute('SELECT id,'+dateCol+' AS period_key,state,'+cursorCol+' AS cursor_id,generated_count,skipped_count FROM '+table+' WHERE id=? AND lease_token=? AND lease_owner=? AND lease_expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE',[candidate.id,leaseToken,workerId]);
   if(!locked.length)throw fail('BILLING_GENERATION_JOB_LEASE_LOST');
   const job=locked[0];if(job.state==='completed')return{worked:false,state:'completed'};
   if(Number(job.cursor_id||0)!==cursor)throw fail('BILLING_GENERATION_JOB_CURSOR_CHANGED');
   let generated=0,skipped=0,processed=0,nextCursor=cursor,complete=false;
   if(appId==='rental'){
    const [rows]=await tx.execute("SELECT * FROM contracts WHERE status='active' AND id>? ORDER BY id ASC LIMIT ? FOR UPDATE",[cursor,chunkSize+1]);
    const batch=rows.slice(0,chunkSize);
    for(const c of batch){const [last]=await tx.execute('SELECT period_end FROM bills WHERE contract_id=? AND source=? ORDER BY period_end DESC LIMIT 1 FOR UPDATE',[c.id,'rental']);try{await tx.insert('bills',buildNextRentalBill(c,last.length?dateOnly(last[0].period_end):null,dateOnly(job.period_key)));generated++;}catch(e){if(['RENTAL_BILL_NOT_DUE','CONTRACT_PERIOD_FINISHED'].includes(e.code)){skipped++;continue;}throw e;}}
    processed=batch.length;nextCursor=batch.length?Number(batch[batch.length-1].id):cursor;complete=rows.length<=chunkSize;
   }else{
    
    const [rows]=await tx.execute('SELECT r.id AS room_id,r.owner_id,r.property_fee,COALESCE(m.water_fee,0) AS water_fee,COALESCE(m.elec_fee,0) AS elec_fee FROM rooms r LEFT JOIN meters m ON m.room_id=r.id AND m.month=? WHERE r.owner_id IS NOT NULL AND r.id>? ORDER BY r.id LIMIT ? FOR UPDATE',[job.period_key,cursor,chunkSize+1]);
    const batch=rows.slice(0,chunkSize);
    for(const room of batch){const bill=buildPropertyFeeBill(room,job.period_key);if(!bill){skipped++;continue;}const [exists]=await tx.execute("SELECT id FROM bills WHERE source='property' AND room_id=? AND period_start=? LIMIT 1 FOR UPDATE",[bill.room_id,bill.period_start]);if(exists.length){skipped++;continue;}await tx.insert('bills',bill);generated++;}
    processed=batch.length;nextCursor=batch.length?Number(batch[batch.length-1].room_id):cursor;complete=rows.length<=chunkSize;
   }
   const [checkpoint]=await tx.execute("UPDATE "+table+" SET state=?, "+cursorCol+"=?,generated_count=generated_count+?,skipped_count=skipped_count+?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error=NULL,attempt_count=0,completed_at=CASE WHEN ?='completed' THEN UTC_TIMESTAMP() ELSE NULL END,updated_at=UTC_TIMESTAMP() WHERE id=? AND lease_token=? AND lease_owner=? AND lease_expires_at>UTC_TIMESTAMP()",[complete?'completed':'running',nextCursor,generated,skipped,complete?'completed':'running',candidate.id,leaseToken,workerId]);
   if(Number(checkpoint.affectedRows)!==1)throw fail('BILLING_GENERATION_JOB_LEASE_LOST');
   return{worked:true,appId,state:complete?'completed':'running',jobId:Number(candidate.id),processed,generated,skipped,cursor:nextCursor,hasMore:!complete};
  }});}catch(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)?error.code:'BILLING_GENERATION_FAILED';const nextAttempt=attempt+1,dead=nextAttempt>=MAX_ATTEMPTS;const delay=Math.min(3600,30*Math.pow(2,Math.max(0,nextAttempt-1)));await pool.execute('UPDATE '+table+' SET state=?,attempt_count=?,next_attempt_at=CASE WHEN ?=1 THEN NULL ELSE DATE_ADD(UTC_TIMESTAMP(),INTERVAL '+delay+' SECOND) END,last_error=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND lease_token=? AND lease_owner=?',[dead?'dead_letter':'queued',nextAttempt,dead?1:0,code,candidate.id,leaseToken,workerId]);throw error;}
  return Object.freeze({...result,worked:Boolean(result?.worked),appId});
 }
 async function processNextBatch({workerId,tenantScanBatchSize=100}={}){
  if(!Number.isInteger(tenantScanBatchSize)||tenantScanBatchSize<1||tenantScanBatchSize>500)throw fail('BILLING_TENANT_SCAN_BATCH_INVALID',400);
  let firstError=null;
  // Process at most one page per app per lane tick. Shared per-app cursors are
  // advanced serially so concurrent lanes scan different pages instead of
  // repeatedly traversing the entire active-tenant registry on every poll.
  for(const appId of appIds){
   const page=await nextTenantPage(appId,tenantScanBatchSize);
   for(const tenantId of page.tenantIds){
    try{const r=await processTenant({tenantId,appId,workerId});if(r.worked)return Object.freeze({...r,workerId});}
    catch(e){if(!firstError)firstError=e;}
   }
  }
  if(firstError)throw firstError;
  return Object.freeze({worked:false,state:'idle'});
 }
 return Object.freeze({processTenant,processNextBatch,leaseSeconds,chunkSize,appIds:Object.freeze([...appIds])});
}
module.exports={createTenantBillingJobProcessor,CHUNK_SIZE,LEASE_SECONDS,MAX_ATTEMPTS,MAX_CHUNK_SIZE};
