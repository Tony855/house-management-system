'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantBillingJobProcessor, LEASE_SECONDS } = require('../server/tenant-billing-job-processor');
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup({ appId = 'rental', job = null, authorizeSystem = async () => true, claimAllowed = Boolean(job), failChunk = false } = {}) {
 const calls=[];let fingerprint=null,idempotencyState='processing',leaseToken=null;
 const connection={
  beginTransaction:async()=>calls.push('BEGIN'),commit:async()=>calls.push('COMMIT'),rollback:async()=>calls.push('ROLLBACK'),release:()=>calls.push('RELEASE'),
  execute:async(sql,params=[])=>{
   calls.push({sql,params});
   if(sql.includes('INSERT IGNORE INTO tenant_write_idempotency')){fingerprint=params[4];return[{affectedRows:1},[]];}
   if(sql.includes('SELECT request_fingerprint, state, response_json'))return[[{request_fingerprint:fingerprint,state:idempotencyState,response_json:null}],[]];
   if(sql.includes('UPDATE tenant_write_idempotency SET state')){idempotencyState='completed';return[{affectedRows:1},[]];}
   if(sql.includes('FROM rental_bill_generation_jobs')||sql.includes('FROM property_fee_generation_jobs'))return[job?[{id:1,period_key:job.periodKey,state:'running',cursor_id:job.cursor||0,generated_count:0,skipped_count:0}]:[],[]];
   if(sql.includes('SELECT * FROM contracts')||sql.includes('SELECT r.id AS room_id')){if(failChunk)throw Object.assign(new Error('secret database detail'),{code:'BILLING_TEST_FAILURE'});return[[],[]];}
   return[{affectedRows:1,insertId:1},[]];
  }
 };
 const pool={
  execute:async(sql,params=[])=>{
   calls.push({sql,params});
   if(sql.startsWith('UPDATE ')&&sql.includes('lease_token')){leaseToken=params[1];return[{affectedRows:claimAllowed?1:0},[]];}
   if(sql.includes('WHERE lease_token=? AND lease_owner=?'))return[job?[{id:1,period_key:job.periodKey,state:'running',cursor_id:job.cursor||0,attempt_count:job.attemptCount||1}]:[],[]];
   return[[],[]];
  },
  getConnection:async()=>connection,end:async()=>{}
 };
 const registry={findTenantById:async id=>({tenant_uuid:id,app_id:appId,lifecycle_state:'active',db_host:'db.internal',db_port:3306,db_name:'tenant_db',db_secret_ref:'secret'}),listActiveTenants:async()=>({tenantIds:[],nextCursor:null})};
 const processor=createTenantBillingJobProcessor({registry,secretProvider:{getDatabaseCredentials:async()=>({user:'tenant',password:'secret',version:'v1'})},tenantPoolManager:{getPool:async()=>pool},authorizeSystem,createToken:()=> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
 return{processor,calls,getLeaseToken:()=>leaseToken};
}
test('processor leaves an empty tenant job queue untouched',async()=>{const f=setup();assert.deepEqual(await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),{worked:false,appId:'rental',state:'idle'});});
test('processor atomically claims a queued job with a bounded lease before processing',async()=>{const f=setup({job:{periodKey:'2026-11-12'}});const r=await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'});assert.equal(r.state,'completed');const claim=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs'));assert.ok(claim.sql.includes('lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 120 SECOND)'));assert.deepEqual(claim.params,['billing-worker-01',f.getLeaseToken()]);const lock=f.calls.find(x=>typeof x==='object'&&x.sql.includes('FOR UPDATE')&&x.sql.includes('lease_token'));assert.deepEqual(lock.params,[1,f.getLeaseToken(),'billing-worker-01']);const release=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.ok(release.sql.includes('lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL'));});
test('processor does not execute a job when another worker owns an unexpired lease',async()=>{const f=setup({job:{periodKey:'2026-11-12'},claimAllowed:false});assert.deepEqual(await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-02'}),{worked:false,appId:'rental',state:'idle'});assert.equal(f.calls.some(x=>x==='BEGIN'),false);});
test('processor requires explicit system authorization before opening tenant transaction',async()=>{const f=setup({job:{periodKey:'2026-11-12'},authorizeSystem:async()=>false});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/TENANT_SYSTEM_WRITE_FORBIDDEN/);assert.equal(f.calls.includes('BEGIN'),false);});
test('processor rejects apps without a supported bill generation job type',async()=>{const f=setup();await assert.rejects(f.processor.processTenant({tenantId,appId:'hotel',workerId:'billing-worker-01'}),/BILLING_PROCESSOR_APP_INVALID/);});
test('processor scans active tenants and returns idle when none have queued jobs',async()=>{const f=setup();assert.deepEqual(await f.processor.processNextBatch({workerId:'billing-worker-01'}),{worked:false,state:'idle'});});
test('rental worker commits an empty final chunk with system audit and idempotency',async()=>{const f=setup({job:{periodKey:'2026-11-12'}});const r=await f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'});assert.equal(r.worked,true);assert.equal(r.state,'completed');assert.ok(f.calls.some(x=>typeof x==='object'&&x.sql.includes('UPDATE rental_bill_generation_jobs SET state=?')));assert.equal(f.calls.filter(x=>typeof x==='object'&&x.sql.includes('tenant_write_audit_events')).length,2);assert.ok(f.calls.includes('COMMIT'));});
test('property worker commits an empty final chunk with system audit and idempotency',async()=>{const f=setup({appId:'property',job:{periodKey:'2026-11'}});const r=await f.processor.processTenant({tenantId,appId:'property',workerId:'billing-worker-01'});assert.equal(r.worked,true);assert.equal(r.state,'completed');assert.ok(f.calls.some(x=>typeof x==='object'&&x.sql.includes('UPDATE property_fee_generation_jobs SET state=?')));assert.equal(f.calls.filter(x=>typeof x==='object'&&x.sql.includes('tenant_write_audit_events')).length,2);assert.ok(f.calls.includes('COMMIT'));});
test('processor validates lease configuration',()=>{assert.throws(()=>createTenantBillingJobProcessor({registry:{findTenantById(){},listActiveTenants(){}},secretProvider:{getDatabaseCredentials(){}},tenantPoolManager:{getPool(){}},authorizeSystem:async()=>true,leaseSeconds:10}),/BILLING_PROCESSOR_LEASE_CONFIG_INVALID/);assert.equal(LEASE_SECONDS,120);});

test('processor schedules exponential retry and releases the lease after a failed chunk',async()=>{const f=setup({job:{periodKey:'2026-11-12',attemptCount:2},failChunk:true});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/secret database detail/);const retry=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.deepEqual(retry.params,['queued',0,'BILLING_TEST_FAILURE',1,f.getLeaseToken(),'billing-worker-01']);assert.ok(retry.sql.includes('INTERVAL 60 SECOND'));assert.ok(retry.sql.includes('lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL'));});
test('processor moves a repeatedly failing job to dead letter after eight attempts',async()=>{const f=setup({job:{periodKey:'2026-11-12',attemptCount:8},failChunk:true});await assert.rejects(f.processor.processTenant({tenantId,appId:'rental',workerId:'billing-worker-01'}),/secret database detail/);const retry=f.calls.find(x=>typeof x==='object'&&x.sql.startsWith('UPDATE rental_bill_generation_jobs SET state=?'));assert.equal(retry.params[0],'dead_letter');assert.equal(retry.params[1],1);});
