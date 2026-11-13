-- Platform-admin authentication state belongs only to platform_control.
ALTER TABLE platform_admins
  ADD COLUMN permissions_json JSON NULL AFTER mfa_required;

CREATE TABLE IF NOT EXISTS platform_admin_login_challenges (
  challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  admin_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_platform_admin_challenge_admin FOREIGN KEY (admin_id)
    REFERENCES platform_admins(id),
  KEY idx_platform_admin_challenge_expiry (expires_at, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  admin_id BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  last_mfa_verified_at DATETIME NOT NULL,
  permissions_json JSON NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_platform_admin_session_admin FOREIGN KEY (admin_id)
    REFERENCES platform_admins(id),
  KEY idx_platform_admin_session_active (admin_id, expires_at, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
