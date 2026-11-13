-- Platform-level idempotent dispatch queue. Tenant business rows remain in tenant databases.
CREATE TABLE IF NOT EXISTS platform_recurring_billing_dispatch (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_uuid CHAR(36) NOT NULL,
  app_id ENUM('rental','property') NOT NULL,
  job_type ENUM('rental_bill','property_fee') NOT NULL,
  period_key VARCHAR(10) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  state ENUM('queued','dispatching','dispatched','failed') NOT NULL DEFAULT 'queued',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner VARCHAR(100) NULL,
  lease_expires_at DATETIME NULL,
  error_code VARCHAR(96) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_recurring_billing_period (tenant_uuid, job_type, period_key),
  UNIQUE KEY uk_recurring_billing_request (request_id),
  KEY idx_recurring_billing_claim (state, available_at, lease_expires_at, id),
  KEY idx_recurring_billing_tenant (tenant_uuid, app_id),
  CONSTRAINT fk_recurring_billing_tenant FOREIGN KEY (tenant_uuid)
    REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
