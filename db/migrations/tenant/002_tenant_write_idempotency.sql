-- Request replay records are tenant-local and committed atomically with domain writes.
CREATE TABLE IF NOT EXISTS tenant_write_idempotency (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id ENUM('rental','hotel','property') NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  state ENUM('processing','completed') NOT NULL,
  response_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  UNIQUE KEY uk_tenant_write_request (app_id, tenant_uuid, user_id, request_id),
  KEY idx_tenant_write_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
