-- Durable, lease-based queue for tenant data migration operations.
CREATE TABLE IF NOT EXISTS platform_tenant_migration_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  app_id ENUM('rental','hotel','property') NOT NULL,
  source_org_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('dry-run','copy') NOT NULL DEFAULT 'dry-run',
  state ENUM('queued','running','failed','completed','cancelled') NOT NULL DEFAULT 'queued',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  lease_owner VARCHAR(100) NULL,
  lease_expires_at DATETIME NULL,
  checkpoint_json LONGTEXT NULL,
  error_code VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_migration_idempotency (idempotency_key),
  KEY idx_tenant_migration_claim (state, lease_expires_at, id),
  KEY idx_tenant_migration_tenant (tenant_uuid, created_at),
  CONSTRAINT fk_tenant_migration_job_tenant FOREIGN KEY (tenant_uuid)
    REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
