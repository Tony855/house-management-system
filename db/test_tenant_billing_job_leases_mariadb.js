'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const mysql=require('mysql2/promise');
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_USER&&process.env.DB_PASSWORD&&process.env.DB_NAME);
test('MariaDB enforces single-owner leases, retry scheduling, terminal cutoff and stale-token fencing', {skip:!enabled}, async()=>{
 const pool=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionLimit:4});
 const month='2030-01';
 const tokenA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',tokenB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',tokenC='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 try{
  await pool.execute("UPDATE property_fee_generation_jobs SET state='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt_count=0,next_attempt_at=NULL,last_error=NULL WHERE billing_month=?",[month]);
  const claim=async(owner,token)=>{const [r]=await pool.execute("UPDATE property_fee_generation_jobs SET state='running',lease_owner=?,lease_token=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 120 SECOND) WHERE id=(SELECT id FROM (SELECT id FROM property_fee_generation_jobs WHERE attempt_count<8 AND ((state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=UTC_TIMESTAMP())) OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP()))) ORDER BY id LIMIT 1) AS eligible)",[owner,token]);return Number(r.affectedRows);};
  const results=await Promise.all([claim('worker-a',tokenA),claim('worker-b',tokenB)]);
  assert.equal(results.reduce((a,b)=>a+b,0),1,'exactly one concurrent worker must acquire the job');
  const [owned]=await pool.execute("SELECT lease_owner,lease_token,attempt_count FROM property_fee_generation_jobs WHERE billing_month=?",[month]);
  assert.equal(owned.length,1);assert.equal(Number(owned[0].attempt_count),0,'claiming must not count as a failed attempt');
  const oldToken=owned[0].lease_token,oldOwner=owned[0].lease_owner;
  await pool.execute("UPDATE property_fee_generation_jobs SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE billing_month=?",[month]);
  const reclaimed=await claim('worker-recovery',tokenC);
  assert.equal(reclaimed,1,'expired lease must be reclaimable');
  const [recovered]=await pool.execute("SELECT lease_owner,lease_token,attempt_count,lease_expires_at>UTC_TIMESTAMP() AS live FROM property_fee_generation_jobs WHERE billing_month=?",[month]);
  assert.equal(recovered[0].lease_owner,'worker-recovery');assert.equal(recovered[0].lease_token,tokenC);assert.equal(Number(recovered[0].attempt_count),0);assert.equal(Number(recovered[0].live),1);
  const [stale]=await pool.execute("UPDATE property_fee_generation_jobs SET state='completed' WHERE billing_month=? AND lease_token=? AND lease_owner=?",[month,oldToken,oldOwner]);
  assert.equal(Number(stale.affectedRows),0,'a stale worker token must not complete a reclaimed job');
  await pool.execute("UPDATE property_fee_generation_jobs SET state='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 60 SECOND) WHERE billing_month=?",[month]);
  assert.equal(await claim('too-early',tokenA),0,'a future retry must not be claimed early');
  await pool.execute("UPDATE property_fee_generation_jobs SET next_attempt_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE billing_month=?",[month]);
  assert.equal(await claim('retry-due',tokenB),1,'a due retry must be claimable');
  await pool.execute("UPDATE property_fee_generation_jobs SET state='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt_count=7,next_attempt_at=NULL WHERE billing_month=?",[month]);
  const [finalFailure]=await pool.execute("UPDATE property_fee_generation_jobs SET attempt_count=8,last_error='BILLING_TEST_FAILURE' WHERE billing_month=?",[month]);
  assert.equal(Number(finalFailure.affectedRows),1);
  await pool.execute("UPDATE property_fee_generation_jobs SET state='dead_letter',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE billing_month=? AND attempt_count>=8 AND state='queued'",[month]);
  const [dead]=await pool.execute("SELECT state,attempt_count,last_error FROM property_fee_generation_jobs WHERE billing_month=?",[month]);
  assert.equal(dead[0].state,'dead_letter');assert.equal(Number(dead[0].attempt_count),8);assert.equal(dead[0].last_error,'BILLING_TEST_FAILURE');
 }finally{await pool.end();}
});
