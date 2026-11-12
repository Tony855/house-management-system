'use strict';
const crypto = require('node:crypto');
const {resolveTenantContext}=require('./tenant-registry');
const {createTenantRepository}=require('./tenant-repository');
const {createTenantSystemWriteService}=require('./tenant-system-write-service');
const {createMariaDbTenantWriteAuditStore}=require('./tenant-write-audit-mariadb');
const {createMariaDbTenantWriteIdempotencyStore}=require('./tenant-write-idempotency-mariadb');
const {buildNextRentalBill}=require('../services/rental-api/write-routes');
const {monthDates}=require('../services/shared/property-fee-routes');
const JOBS={rental:'rental_bill',property:'property_fee'},CHUNK_SIZE=50,LEASE_SECONDS=120;
const dateOnly=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
function fail(code,status=409){return Object.assign(new Error(code),{code,status});}
function createTenantBillingJobProcessor({registry,secretProvider,tenantPoolManager,authorizeSystem,leaseSeconds=LEASE_SECONDS,createToken=crypto.randomUUID}={}){
 if(!registry||typeof registry.findTenantById!=='function'||typeof registry.listActiveTenants!=='function')throw new TypeError('BILLING_PROCESSOR_REGISTRY_REQUIRED');
 if(!secretProvider||typeof secretProvider.getDatabaseCredentials!=='function')throw new TypeError('BILLING_PROCESSOR_SECRET_PROVIDER_REQUIRED');
 if(!tenantPoolManager||typeof tenantPoolManager.getPool!=='function')throw new TypeError('BILLING_PROCESSOR_POOL_MANAGER_REQUIRED');
 if(typeof authorizeSystem!=='function')throw new TypeError('BILLING_PROCESSOR_SYSTEM_AUTHORIZER_REQUIRED');
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600||typeof createToken!=='function')throw new TypeError('BILLING_PROCESSOR_LEASE_CONFIG_INVALID');
 const systemWrite=createTenantSystemWriteService({authorizeSystem,auditWriter:createMariaDbTenantWriteAuditStore(),idempotencyStore:createMariaDbTenantWriteIdempotencyStore()});
 async function processTenant({tenantId,appId,workerId}){
  if(!Object.hasOwn(JOBS,appId))throw fail('BILLING_PROCESSOR_APP_INVALID',400);
  if(typeof workerId!=='string'||!/^[A-Za-z0-9._:-]{1,100}$/.test(workerId))throw fail('BILLING_PROCESSOR_WORKER_INVALID',400);
  const context=await resolveTenantContext({auth:{authenticated:true,tenantId,appId},appId,registry,secretProvider});
  const pool=await tenantPoolManager.getPool(context),repository=createTenantRepository({pool,appId});
  const table=appId==='rental'?'rental_bill_generation_jobs':'property_fee_generation_jobs';
  const dateCol=appId==='rental'?'as_of_date':'billing_month',cursorCol=appId==='rental'?'cursor_contract_id':'cursor_room_id';
  const leaseToken=createToken();
  if(typeof leaseToken!=='string'||!/^[0-9a-f-]{36}$/i.test(leaseToken))throw fail('BILLING_PROCESSOR_LEASE_TOKEN_INVALID',500);
  const [claim]=await pool.execute(
   "UPDATE "+table+" SET state='running',lease_owner=?,lease_token=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL "+leaseSeconds+" SECOND),attempt_count=attempt_count+1 WHERE id=(SELECT id FROM (SELECT id FROM "+table+" WHERE state='queued' OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP())) ORDER BY id LIMIT 1) AS eligible)",
   [workerId,leaseToken]
  );
  if(Number(claim.affectedRows)!==1)return Object.freeze({worked:false,appId,state:'idle'});
  const [found]=await pool.execute('SELECT id,'+dateCol+' AS period_key,state,'+cursorCol+' AS cursor_id,attempt_count FROM '+table+' WHERE lease_token=? AND lease_owner=? LIMIT 1',[leaseToken,workerId]);
  if(!found.length)return Object.freeze({worked:false,appId,state:'lease_lost'});
  const candidate=found[0],cursor=Number(candidate.cursor_id||0),attempt=Number(candidate.attempt_count||1),requestId='system-billing-'+tenantId+'-'+candidate.id+'-'+cursor;
  const payload={job_id:Number(candidate.id),cursor_id:cursor,__resource:table+'-worker'};
  let result;try{result=await systemWrite.execute({workerId,appId,tenantId,tenantContext:context,repository,jobType:JOBS[appId],requestId,payload,mutate:async tx=>{
   const [locked]=await tx.execute('SELECT id,'+dateCol+' AS period_key,state,'+cursorCol+' AS cursor_id,generated_count,skipped_count FROM '+table+' WHERE id=? AND lease_token=? AND lease_owner=? LIMIT 1 FOR UPDATE',[candidate.id,leaseToken,workerId]);
   if(!locked.length)throw fail('BILLING_GENERATION_JOB_LEASE_LOST');
   const job=locked[0];if(job.state==='completed')return{worked:false,state:'completed'};
   if(Number(job.cursor_id||0)!==cursor)throw fail('BILLING_GENERATION_JOB_CURSOR_CHANGED');
   let generated=0,skipped=0,processed=0,nextCursor=cursor,complete=false;
   if(appId==='rental'){
    const [rows]=await tx.execute("SELECT * FROM contracts WHERE status='active' AND id>? ORDER BY id ASC LIMIT ? FOR UPDATE",[cursor,CHUNK_SIZE+1]);
    const batch=rows.slice(0,CHUNK_SIZE);
    for(const c of batch){const [last]=await tx.execute('SELECT period_end FROM bills WHERE contract_id=? AND source=? ORDER BY period_end DESC LIMIT 1 FOR UPDATE',[c.id,'rental']);try{await tx.insert('bills',buildNextRentalBill(c,last.length?dateOnly(last[0].period_end):null,dateOnly(job.period_key)));generated++;}catch(e){if(['RENTAL_BILL_NOT_DUE','CONTRACT_PERIOD_FINISHED'].includes(e.code)){skipped++;continue;}throw e;}}
    processed=batch.length;nextCursor=batch.length?Number(batch[batch.length-1].id):cursor;complete=rows.length<=CHUNK_SIZE;
   }else{
    const dates=monthDates(job.period_key);
    const [rows]=await tx.execute('SELECT r.id AS room_id,r.owner_id,r.property_fee,COALESCE(m.water_fee,0) AS water_fee,COALESCE(m.elec_fee,0) AS elec_fee FROM rooms r LEFT JOIN meters m ON m.room_id=r.id AND m.month=? WHERE r.owner_id IS NOT NULL AND r.id>? ORDER BY r.id LIMIT ? FOR UPDATE',[job.period_key,cursor,CHUNK_SIZE+1]);
    const batch=rows.slice(0,CHUNK_SIZE);
    for(const room of batch){const pf=Number(room.property_fee),wf=Number(room.water_fee),ef=Number(room.elec_fee);if(![pf,wf,ef].every(v=>Number.isFinite(v)&&v>=0))throw fail('PROPERTY_FEE_AMOUNT_INVALID');const amount=Math.round((pf+wf+ef)*100)/100;if(amount<=0){skipped++;continue;}const [exists]=await tx.execute("SELECT id FROM bills WHERE source='property' AND room_id=? AND period_start=? LIMIT 1 FOR UPDATE",[room.room_id,dates.start]);if(exists.length){skipped++;continue;}const detail=[pf>0?'物业费 '+pf.toFixed(2):'',wf>0?'水费 '+wf.toFixed(2):'',ef>0?'电费 '+ef.toFixed(2):''].filter(Boolean).join(' + ');await tx.insert('bills',{source:'property',room_id:Number(room.room_id),tenant_id:Number(room.owner_id),period_start:dates.start,period_end:dates.end,due_date:dates.due,amount,paid_amount:0,status:'unpaid',remark:'明细：'+detail});generated++;}
    processed=batch.length;nextCursor=batch.length?Number(batch[batch.length-1].room_id):cursor;complete=rows.length<=CHUNK_SIZE;
   }
   await tx.execute('UPDATE '+table+' SET state=?, '+cursorCol+'=?,generated_count=generated_count+?,skipped_count=skipped_count+?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error=NULL,completed_at=CASE WHEN ?='completed' THEN UTC_TIMESTAMP() ELSE NULL END,updated_at=UTC_TIMESTAMP() WHERE id=? AND lease_token=?',[complete?'completed':'running',nextCursor,generated,skipped,complete?'completed':'running',candidate.id,leaseToken]);
   return{worked:true,appId,state:complete?'completed':'running',jobId:Number(candidate.id),processed,generated,skipped,cursor:nextCursor,hasMore:!complete};
  }});}catch(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)?error.code:'BILLING_GENERATION_FAILED';const dead=attempt>=MAX_ATTEMPTS;const delay=Math.min(3600,30*Math.pow(2,Math.max(0,attempt-1)));await pool.execute('UPDATE '+table+' SET state=?,next_attempt_at=CASE WHEN ?=1 THEN NULL ELSE DATE_ADD(UTC_TIMESTAMP(),INTERVAL '+delay+' SECOND) END,last_error=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND lease_token=? AND lease_owner=?',[dead?'dead_letter':'queued',dead?1:0,code,candidate.id,leaseToken,workerId]);throw error;}
  return Object.freeze({...result,worked:Boolean(result?.worked),appId});
 }
 async function processNextBatch({workerId,tenantScanBatchSize=100}={}){
  if(!Number.isInteger(tenantScanBatchSize)||tenantScanBatchSize<1||tenantScanBatchSize>500)throw fail('BILLING_TENANT_SCAN_BATCH_INVALID',400);
  let firstError=null;
  for(const appId of ['rental','property']){let cursor='';for(;;){const page=await registry.listActiveTenants({appId,afterTenantId:cursor,limit:tenantScanBatchSize});for(const tenantId of page.tenantIds){try{const r=await processTenant({tenantId,appId,workerId});if(r.worked)return Object.freeze({...r,workerId});}catch(e){if(!firstError)firstError=e;}}if(!page.nextCursor)break;if(page.nextCursor===cursor)throw fail('BILLING_TENANT_SCAN_CURSOR_STALLED',500);cursor=page.nextCursor;}}
  if(firstError)throw firstError;return Object.freeze({worked:false,state:'idle'});
 }
 return Object.freeze({processTenant,processNextBatch});
}
module.exports={createTenantBillingJobProcessor,CHUNK_SIZE,LEASE_SECONDS};
