-- Exact host-to-tenant mapping for product login. Only platform operators may manage this table.
-- No wildcard or request-supplied tenant IDs are accepted by the login service.
CREATE TABLE IF NOT EXISTS platform_tenant_login_hosts (
  hostname VARCHAR(253) NOT NULL PRIMARY KEY,
  app_id ENUM('rental','hotel','property') NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_login_host_app (hostname, app_id),
  KEY idx_tenant_login_host_tenant (tenant_uuid, app_id, status),
  CONSTRAINT fk_tenant_login_host_tenant FOREIGN KEY (tenant_uuid)
    REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
