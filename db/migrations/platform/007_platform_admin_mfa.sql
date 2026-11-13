-- Platform administrator MFA factors are stored only in the control-plane database.
-- encrypted_secret is an opaque envelope produced by the deployment KMS adapter.
CREATE TABLE IF NOT EXISTS platform_admin_mfa_enrollments (
  admin_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  encrypted_secret JSON NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_mfa_enrollment_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_admin_mfa_factors (
  admin_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  encrypted_secret JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_totp_counter BIGINT UNSIGNED NOT NULL,
  enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_platform_mfa_enabled (enabled, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_admin_mfa_recovery_codes (
  admin_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id, code_hash),
  KEY idx_platform_mfa_recovery_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
