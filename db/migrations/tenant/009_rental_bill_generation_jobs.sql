CREATE TABLE IF NOT EXISTS rental_bill_generation_jobs (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 as_of_date DATE NOT NULL,
 request_id VARCHAR(128) NOT NULL,
 state ENUM('queued','running','completed') NOT NULL DEFAULT 'queued',
 cursor_contract_id INT UNSIGNED NOT NULL DEFAULT 0,
 generated_count INT UNSIGNED NOT NULL DEFAULT 0,
 skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 completed_at DATETIME NULL,
 UNIQUE KEY uk_rental_bill_job_as_of (as_of_date),
 UNIQUE KEY uk_rental_bill_job_request (request_id),
 KEY idx_rental_bill_job_state (state,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
