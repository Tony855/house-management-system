CREATE TABLE IF NOT EXISTS property_fee_generation_jobs (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 billing_month CHAR(7) NOT NULL, request_id VARCHAR(128) NOT NULL,
 state ENUM('queued','running','completed') NOT NULL DEFAULT 'queued',
 cursor_room_id INT UNSIGNED NOT NULL DEFAULT 0,
 generated_count INT UNSIGNED NOT NULL DEFAULT 0, skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
 last_error VARCHAR(96) NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 completed_at DATETIME NULL,
 UNIQUE KEY uk_property_fee_job_month (billing_month),
 UNIQUE KEY uk_property_fee_job_request (request_id),
 KEY idx_property_fee_job_state (state,updated_at),
 CONSTRAINT chk_property_fee_job_month CHECK (billing_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
