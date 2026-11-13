ALTER TABLE property_fee_generation_jobs
 MODIFY COLUMN state ENUM('queued','running','completed','dead_letter') NOT NULL DEFAULT 'queued',
 ADD COLUMN next_attempt_at DATETIME NULL AFTER attempt_count,
 ADD KEY idx_property_fee_job_retry (state,next_attempt_at,id);

ALTER TABLE rental_bill_generation_jobs
 MODIFY COLUMN state ENUM('queued','running','completed','dead_letter') NOT NULL DEFAULT 'queued',
 ADD COLUMN last_error VARCHAR(96) NULL AFTER attempt_count,
 ADD COLUMN next_attempt_at DATETIME NULL AFTER last_error,
 ADD KEY idx_rental_bill_job_retry (state,next_attempt_at,id);
