'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const mysql=require('mysql2/promise');
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_USER&&process.env.DB_PASSWORD&&process.env.DB_NAME);
test('MariaDB allows only one concurrent claimant and reclaims an expired lease', {skip:!enabled}, async()=>{
 const pool=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionLimit:4});
 try{
  await pool.execute("UPDATE property_fee_generation_jobs SET state='queued',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt_count=0 WHERE billing_month='2030-01'");
  const claim=async(owner,token)=>{const [r]=await pool.execute("UPDATE property_fee_generation_jobs SET state='running',lease_owner=?,lease_token=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 120 SECOND),attempt_count=attempt_count+1 WHERE id=(SELECT id FROM (SELECT id FROM property_fee_generation_jobs WHERE state='queued' OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP())) ORDER BY id LIMIT 1) AS eligible)",[owner,token]);return Number(r.affectedRows);};
  const results=await Promise.all([claim('worker-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),claim('worker-b','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')]);
  assert.equal(results.reduce((a,b)=>a+b,0),1,'exactly one concurrent worker must acquire the job');
  const [owned]=await pool.execute("SELECT lease_owner,lease_token,attempt_count FROM property_fee_generation_jobs WHERE billing_month='2030-01'");
  assert.equal(owned.length,1);assert.equal(Number(owned[0].attempt_count),1);
  await pool.execute("UPDATE property_fee_generation_jobs SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE billing_month='2030-01'");
  const reclaimed=await claim('worker-recovery','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(reclaimed,1,'expired lease must be reclaimable');
  const [recovered]=await pool.execute("SELECT lease_owner,lease_token,attempt_count,lease_expires_at>UTC_TIMESTAMP() AS live FROM property_fee_generation_jobs WHERE billing_month='2030-01'");
  assert.equal(recovered[0].lease_owner,'worker-recovery');assert.equal(recovered[0].lease_token,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');assert.equal(Number(recovered[0].attempt_count),2);assert.equal(Number(recovered[0].live),1);
 }finally{await pool.end();}
});
