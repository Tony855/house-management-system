-- Platform control-plane schema. Apply only to a dedicated platform database.
-- Tenant business identities and records MUST NOT be stored here.
CREATE TABLE IF NOT EXISTS platform_admins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  mfa_required BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_tenants (
  tenant_uuid CHAR(36) NOT NULL PRIMARY KEY,
  app_id ENUM('rental','hotel','property') NOT NULL,
  display_label VARCHAR(120) NOT NULL,
  lifecycle_state ENUM('provisioning','provisioning_failed','active','suspended','deleting','deleted') NOT NULL DEFAULT 'provisioning',
  db_host VARCHAR(255) NOT NULL,
  db_port SMALLINT UNSIGNED NOT NULL DEFAULT 3306,
  db_name VARCHAR(64) NOT NULL,
  db_secret_ref VARCHAR(255) NOT NULL,
  schema_version VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_tenant_db_name (db_host, db_name),
  KEY idx_platform_tenant_app_state (app_id, lifecycle_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_provisioning_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_uuid CHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  outcome ENUM('started','succeeded','failed') NOT NULL,
  detail_code VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_provisioning_tenant (tenant_uuid, created_at),
  CONSTRAINT fk_platform_provisioning_tenant FOREIGN KEY (tenant_uuid)
    REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
