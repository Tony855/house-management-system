-- Platform-managed machine identities for automated tenant billing writes.
-- Store only SHA-256 hashes of high-entropy deployment secrets; never store plaintext credentials.
CREATE TABLE IF NOT EXISTS platform_billing_workers (
  worker_id VARCHAR(100) NOT NULL PRIMARY KEY,
  credential_sha256 CHAR(64) NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_platform_billing_worker_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_billing_worker_scopes (
  worker_id VARCHAR(100) NOT NULL,
  app_id ENUM('rental','property') NOT NULL,
  job_type ENUM('rental_bill','property_fee') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (worker_id, app_id, job_type),
  CONSTRAINT fk_platform_billing_worker_scope_worker FOREIGN KEY (worker_id)
    REFERENCES platform_billing_workers(worker_id) ON DELETE CASCADE,
  CONSTRAINT chk_platform_billing_worker_scope_pair CHECK (
    (app_id = 'rental' AND job_type = 'rental_bill') OR
    (app_id = 'property' AND job_type = 'property_fee')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
