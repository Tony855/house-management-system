-- Security audit trail for Platform Admin authentication and MFA lifecycle.
-- No raw usernames, IP addresses, credentials, MFA codes, tokens or secret envelopes.
CREATE TABLE IF NOT EXISTS platform_admin_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT UNSIGNED NULL,
  session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('success','failure') NOT NULL,
  detail_code VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_admin_audit_admin_time (admin_id, created_at),
  KEY idx_platform_admin_audit_action_time (action, created_at),
  CONSTRAINT fk_platform_admin_audit_admin FOREIGN KEY (admin_id)
    REFERENCES platform_admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
