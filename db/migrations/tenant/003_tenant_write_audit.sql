-- Tenant-local, payload-free audit for privileged product-domain writes.
CREATE TABLE IF NOT EXISTS tenant_write_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id ENUM('rental','hotel','property') NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  operation ENUM('create','update','delete') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  event_type ENUM('tenant_write_started','tenant_write_replayed','tenant_write_committed') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_write_audit_actor_time (user_id, created_at),
  KEY idx_tenant_write_audit_request (request_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
