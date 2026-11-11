-- Persistent, privacy-preserving login failure throttling in the platform control plane.
-- Identity values are HMAC digests; raw usernames and hostnames are never stored.
CREATE TABLE IF NOT EXISTS platform_login_attempts (
  app_id ENUM('rental','hotel','property','platform') NOT NULL,
  identity_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_started_at DATETIME NOT NULL,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  blocked_until DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (app_id, identity_hash),
  KEY idx_platform_login_blocked (blocked_until),
  KEY idx_platform_login_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
