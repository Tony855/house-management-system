'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantBillingJobProcessor, LEASE_SECONDS, MAX_ATTEMPTS, MAX_CHUNK_SIZE } = require('../server/tenant-billing-job-processor');
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup({ appId = 'rental', appIds = [appId], listActiveTenants = async () => ({ tenantIds: [], nextCursor: null }), scanTimeoutMs = 30000, job = null, authorizeSystem = async () => true, claimAllowed = Boolean(job), failChunk = false, chunkSize = 50, propertyRows = [] } = {}) {
 const calls=[];let fingerprint=null,idempotencyState='processing',leaseToken=null;
 const connection={
  beginTransaction:async()=>calls.push('BEGIN'),commit:async()=>calls.push('COMMIT'),rollback:async()=>calls.push('ROLLBACK'),release:()=>calls.push('RELEASE'),
  execute:async(sql,params=[])=>{
   calls.push({sql,params});
   if(sql.includes('INSERT IGNORE INTO tenant_write_idempotency')){fingerprint=params[4];return[{affectedRows:1},[]];}
   if(sql.includes('SELECT request_fingerprint, state, response_json'))return[[{request_fingerprint:fingerprint,state:idempotencyState,response_json:null}],[]];
   if(sql.includes('UPDATE tenant_write_idempotency SET state')){idempotencyState='completed';return[{affectedRows:1},[]];}
   if(sql.includes('FROM rental_bill_generation_jobs')||sql.includes('FROM property_fee_generation_jobs'))return[job?[{id:1,period_key:job.periodKey,state:'running',cursor_id:job.cursor||0,generated_count:0,skipped_count:0}]:[],[]];
   if(sql.includes('SELECT * FROM contracts')){if(failChunk)throw Object.assign(new Error('secret database detail'),{code:'BILLING_TEST_FAILURE'});return[[],[]];}
   if(sql.includes('SELECT r.id AS room_id')){if(failChunk)throw Object.assign(new Error('secret database detail'),{code:'BILLING_TEST_FAILURE'});return[propertyRows,[]];}
   return[{affectedRows:1,insertId:1},[]];
  }
 };
 const pool={
  execute:async(sql,params=[])=>{
   calls.push({sql,params});
   if(sql.startsWith('UPDATE ')&&sql.includes('lease_expires_at=DATE_ADD')){leaseToken=params[1];return[{affectedRows:claimAllowed?1:0},[]];}
   if(sql.includes('WHERE lease_token=? AND lease_owner=?'))return[job?[{id:1,period_key:job.periodKey,state:'running',cursor_id:job.cursor||0,attempt_count:job.attemptCount||0}]:[],[]];
   return[[],[]];
  },
  getConnection:async()=>connection,end:async()=>{}
 };
 const registry={findTenantById:async id=>({tenant_uuid:id,app_id:appId,lifecycle_state:'active',db_host:'db.internal',db_port:3306,db_name:'tenant_db',db_secret_ref:'secret'}),listActiveTenants};
 const processor=createTenantBillingJobProcessor({registry,secretProvider:{getDatabaseCredentials:async()=>({user:'tenant',password:'secret',version:'v1'})},tenantPoolManager:{getPool:async()=>pool},authorizeSystem,appIds,chunkSize,scanTimeoutMs,createToken:()=> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
 return{processor,calls,getLeaseToken:()=>leaseToken};
}
test('processor leaves an empty tenant job queue untouched',async()=>{const f=setup();assert.deepEqual(await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),{worked:false,appId:'rental',state:'idle'});});
test('processor atomically claims a queued job with a bounded lease before processing',async()=>{const f=setup({job:{periodKey:'2026-11-12'}});const r=await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'});assert.equal(r.state,'completed');const claim=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs')&&x.sql.includes('lease_expires_at=DATE_ADD'));assert.ok(claim.sql.includes('lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 120 SECOND)'));assert.deepEqual(claim.params,['billing-worker-01',f.getLeaseToken(),MAX_ATTEMPTS]);assert.ok(claim.sql.includes('next_attempt_at<=UTC_TIMESTAMP()'));assert.ok(claim.sql.includes('attempt_count<?'));const lock=f.calls.find(x=>typeof x==='object'&&x.sql.includes('FOR UPDATE')&&x.sql.includes('lease_token'));assert.deepEqual(lock.params,[1,f.getLeaseToken(),'billing-worker-01']);const release=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.ok(release.sql.includes('lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL'));assert.ok(release.sql.includes('attempt_count=0'));});
test('processor does not execute a job when another worker owns an unexpired lease',async()=>{const f=setup({job:{periodKey:'2026-11-12'},claimAllowed:false});assert.deepEqual(await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-02'}),{worked:false,appId:'rental',state:'idle'});assert.equal(f.calls.some(x=>x==='BEGIN'),false);});
test('processor requires explicit system authorization before opening tenant transaction',async()=>{const f=setup({job:{periodKey:'2026-11-12'},authorizeSystem:async()=>false});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/TENANT_SYSTEM_WRITE_FORBIDDEN/);assert.equal(f.calls.includes('BEGIN'),false);});
test('processor rejects apps without a supported bill generation job type',async()=>{const f=setup();await assert.rejects(f.processor.processTenant({tenantId,appId:'hotel',workerId:'billing-worker-01'}),/BILLING_PROCESSOR_APP_INVALID/);});
test('processor scans active tenants and returns idle when none have queued jobs',async()=>{const f=setup();assert.deepEqual(await f.processor.processNextBatch({workerId:'billing-worker-01'}),{worked:false,state:'idle'});});
test('rental worker commits an empty final chunk with system audit and idempotency',async()=>{const f=setup({job:{periodKey:'2026-11-12'}});const r=await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'});assert.equal(r.worked,true);assert.equal(r.state,'completed');assert.ok(f.calls.some(x=>typeof x==='object'&&x.sql.includes('UPDATE rental_bill_generation_jobs SET state=?')));assert.equal(f.calls.filter(x=>typeof x==='object'&&x.sql.includes('tenant_write_audit_events')).length,2);assert.ok(f.calls.includes('COMMIT'));});
test('property worker commits an empty final chunk with system audit and idempotency',async()=>{const f=setup({appId:'property',job:{periodKey:'2026-11'}});const r=await f.processor.processTenant({tenantId,appId:'property',workerId:'billing-worker-01'});assert.equal(r.worked,true);assert.equal(r.state,'completed');assert.ok(f.calls.some(x=>typeof x==='object'&&x.sql.includes('UPDATE property_fee_generation_jobs SET state=?')));assert.equal(f.calls.filter(x=>typeof x==='object'&&x.sql.includes('tenant_write_audit_events')).length,2);assert.ok(f.calls.includes('COMMIT'));});
test('processor validates lease configuration',()=>{assert.throws(()=>createTenantBillingJobProcessor({registry:{findTenantById(){},listActiveTenants(){}},secretProvider:{getDatabaseCredentials(){}},tenantPoolManager:{getPool(){}},authorizeSystem:async()=>true,leaseSeconds:10}),/BILLING_PROCESSOR_LEASE_CONFIG_INVALID/);assert.equal(LEASE_SECONDS,120);assert.equal(MAX_ATTEMPTS,8);assert.equal(MAX_CHUNK_SIZE,200);});

test('processor counts the first failure from zero and schedules a 30 second retry',async()=>{const f=setup({job:{periodKey:'2026-11-12',attemptCount:0},failChunk:true});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/secret database detail/);const retry=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.deepEqual(retry.params,['queued',1,0,'BILLING_TEST_FAILURE',1,f.getLeaseToken(),'billing-worker-01']);assert.ok(retry.sql.includes('INTERVAL 30 SECOND'));assert.ok(retry.sql.includes('lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL'));});
test('processor exponentially backs off subsequent consecutive failures',async()=>{const f=setup({job:{periodKey:'2026-11-12',attemptCount:1},failChunk:true});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/secret database detail/);const retry=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.deepEqual(retry.params,['queued',2,0,'BILLING_TEST_FAILURE',1,f.getLeaseToken(),'billing-worker-01']);assert.ok(retry.sql.includes('INTERVAL 60 SECOND'));});
test('processor moves the eighth consecutive failure to dead letter',async()=>{const f=setup({job:{periodKey:'2026-11-12',attemptCount:7},failChunk:true});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/secret database detail/);const retry=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.equal(retry.params[0],'dead_letter');assert.equal(retry.params[1],8);assert.equal(retry.params[2],1);});

test('processor restricts tenant scans to the configured product scope',async()=>{const seen=[];const scoped=createTenantBillingJobProcessor({registry:{findTenantById:async()=>null,listActiveTenants:async({appId})=>{seen.push(appId);return{tenantIds:[],nextCursor:null};}},secretProvider:{getDatabaseCredentials:async()=>({user:'tenant',password:'secret'})},tenantPoolManager:{getPool:async()=>({execute:async()=>[[],[]]})},authorizeSystem:async()=>true,appIds:['rental']});await scoped.processNextBatch({workerId:'rental-worker'});assert.deepEqual(seen,['rental']);assert.throws(()=>createTenantBillingJobProcessor({registry:{findTenantById(){},listActiveTenants(){}},secretProvider:{getDatabaseCredentials(){}},tenantPoolManager:{getPool(){}},authorizeSystem:async()=>true,appIds:['rental','rental']}),/BILLING_PROCESSOR_APP_SCOPE_INVALID/);});

test('processor applies a bounded configurable chunk size to database selection',async()=>{const f=setup({job:{periodKey:'2026-11-12'},chunkSize:12});await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'});const query=f.calls.find(x=>typeof x==='object'&&x.sql.includes('SELECT * FROM contracts'));assert.equal(query.params[1],13);assert.equal(f.processor.chunkSize,12);assert.throws(()=>createTenantBillingJobProcessor({registry:{findTenantById(){},listActiveTenants(){}},secretProvider:{getDatabaseCredentials(){}},tenantPoolManager:{getPool(){}},authorizeSystem:async()=>true,chunkSize:MAX_CHUNK_SIZE+1}),/BILLING_PROCESSOR_LEASE_CONFIG_INVALID/);});

test('property worker honors the configured chunk size and leaves remaining rooms for the next lease',async()=>{const propertyRows=[1,2,3].map(id=>({room_id:id,owner_id:1,property_fee:0,water_fee:0,elec_fee:0}));const f=setup({appId:'property',job:{periodKey:'2026-11'},chunkSize:2,propertyRows});const r=await f.processor.processTenant({tenantId,appId:'property',workerId:'billing-worker-01'});assert.equal(r.worked,true);assert.equal(r.state,'running');assert.equal(r.processed,2);assert.equal(r.hasMore,true);assert.equal(r.cursor,2);const query=f.calls.find(x=>typeof x==='object'&&x.sql.includes('SELECT r.id AS room_id'));assert.equal(query.params[2],3);});


test('billing processor scans one bounded tenant page per tick and rotates the shared cursor', async () => {
 const secondTenant='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const thirdTenant='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const scanCalls=[];
 const pages=[
  {tenantIds:[tenantId,secondTenant],nextCursor:secondTenant},
  {tenantIds:[thirdTenant],nextCursor:null},
  {tenantIds:[tenantId,secondTenant],nextCursor:secondTenant}
 ];
 const f=setup({
  appId:'rental',appIds:['rental'],claimAllowed:false,
  listActiveTenants:async input=>{scanCalls.push(input);return pages.shift();}
 });
 const workerId='billing-worker-scan';
 for(let i=0;i<3;i++){
  const result=await f.processor.processNextBatch({workerId,tenantScanBatchSize:2});
  assert.equal(result.worked,false);
 }
 assert.deepEqual(scanCalls.map(call=>call.afterTenantId),['',secondTenant,'']);
 assert.deepEqual(scanCalls.map(call=>call.limit),[2,2,2]);
});


test('billing processor bounds a platform tenant scan that never resolves', async () => {
 const f=setup({
  appId:'rental',appIds:['rental'],scanTimeoutMs:10,
  listActiveTenants:()=>new Promise(()=>{})
 });
 await assert.rejects(
  f.processor.processNextBatch({workerId:'billing-worker-timeout'}),
  error=>error.code==='BILLING_TENANT_SCAN_TIMEOUT'&&error.status===503
 );
});


test('billing processor rejects malformed tenant IDs and mismatched page cursors', async () => {
 const invalidId=setup({
  appId:'rental',appIds:['rental'],
  listActiveTenants:async()=>({tenantIds:['not-a-tenant-uuid'],nextCursor:null})
 });
 await assert.rejects(
  invalidId.processor.processNextBatch({workerId:'billing-worker-invalid'}),
  error=>error.code==='BILLING_TENANT_SCAN_RESULT_INVALID'
 );
 const invalidCursor=setup({
  appId:'rental',appIds:['rental'],
  listActiveTenants:async()=>({tenantIds:[tenantId],nextCursor:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})
 });
 await assert.rejects(
  invalidCursor.processor.processNextBatch({workerId:'billing-worker-invalid'}),
  error=>error.code==='BILLING_TENANT_SCAN_RESULT_INVALID'
 );
});
