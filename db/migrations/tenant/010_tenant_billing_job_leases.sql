ALTER TABLE property_fee_generation_jobs
 ADD COLUMN lease_owner VARCHAR(100) NULL AFTER state,
 ADD COLUMN lease_token CHAR(36) NULL AFTER lease_owner,
 ADD COLUMN lease_expires_at DATETIME NULL AFTER lease_token,
 ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER skipped_count,
 ADD KEY idx_property_fee_job_lease (state,lease_expires_at,id),
 ADD UNIQUE KEY uk_property_fee_job_lease_token (lease_token);

ALTER TABLE rental_bill_generation_jobs
 ADD COLUMN lease_owner VARCHAR(100) NULL AFTER state,
 ADD COLUMN lease_token CHAR(36) NULL AFTER lease_owner,
 ADD COLUMN lease_expires_at DATETIME NULL AFTER lease_token,
 ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER skipped_count,
 ADD KEY idx_rental_bill_job_lease (state,lease_expires_at,id),
 ADD UNIQUE KEY uk_rental_bill_job_lease_token (lease_token);
