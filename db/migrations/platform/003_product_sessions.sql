-- Revocation-aware product sessions live in the platform control plane.
-- Subject IDs are opaque references; user profiles and credentials remain in tenant databases.
CREATE TABLE IF NOT EXISTS platform_product_sessions (
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  app_id ENUM('rental','hotel','property') NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  subject_id VARCHAR(128) NOT NULL,
  issued_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_session_tenant FOREIGN KEY (tenant_uuid)
    REFERENCES platform_tenants(tenant_uuid),
  KEY idx_product_session_lookup (session_id, app_id, tenant_uuid, subject_id, expires_at, revoked_at),
  KEY idx_product_session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
