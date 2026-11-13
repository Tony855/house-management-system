-- Tenant-local identity schema. Apply only to a newly provisioned tenant DB.
-- Never copy legacy sessions; users must sign in again after cutover.
CREATE TABLE IF NOT EXISTS roles (
  id INT NOT NULL PRIMARY KEY, code VARCHAR(30) NOT NULL, name VARCHAR(50) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '', level ENUM('super','admin','staff','manager') NOT NULL DEFAULT 'staff',
  is_system TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_role_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL PRIMARY KEY, username VARCHAR(50) NOT NULL, password VARCHAR(255) NOT NULL,
  real_name VARCHAR(50) NOT NULL DEFAULT '', role VARCHAR(30) NOT NULL DEFAULT 'staff',
  mode ENUM('rental','hotel','property') NOT NULL, company_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uk_tenant_username (username), KEY idx_tenant_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS settings (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1 PRIMARY KEY, currency ENUM('CNY','USD') NOT NULL DEFAULT 'USD',
  rate DECIMAL(10,4) NOT NULL DEFAULT 7.2000, net_price_per_mb DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  water_price DECIMAL(10,2) NOT NULL DEFAULT 4.50, elec_price DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  item_lib LONGTEXT NULL, remind_enable TINYINT NOT NULL DEFAULT 1, remind_days INT NOT NULL DEFAULT 3
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS user_permissions (
  id INT NOT NULL PRIMARY KEY, user_id INT NOT NULL, page VARCHAR(30) NOT NULL,
  UNIQUE KEY uk_tenant_user_page (user_id, page), KEY idx_tenant_user_permissions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS role_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, role_id INT NOT NULL, page VARCHAR(30) NOT NULL,
  UNIQUE KEY uk_tenant_role_page (role_id, page), CONSTRAINT fk_tenant_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
