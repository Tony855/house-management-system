-- Two-person approval for restoring a disabled Platform administrator.
-- A pending request is unique per target; the requester cannot approve their own request.
CREATE TABLE IF NOT EXISTS platform_admin_reenable_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  target_admin_id BIGINT UNSIGNED NOT NULL,
  requested_by_admin_id BIGINT UNSIGNED NOT NULL,
  approved_by_admin_id BIGINT UNSIGNED NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  pending_target_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN target_admin_id ELSE NULL END) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL,
  CONSTRAINT fk_platform_admin_reenable_target FOREIGN KEY (target_admin_id)
    REFERENCES platform_admins(id),
  CONSTRAINT fk_platform_admin_reenable_requester FOREIGN KEY (requested_by_admin_id)
    REFERENCES platform_admins(id),
  CONSTRAINT fk_platform_admin_reenable_approver FOREIGN KEY (approved_by_admin_id)
    REFERENCES platform_admins(id),
  UNIQUE KEY uq_platform_admin_reenable_pending_target (pending_target_id),
  KEY idx_platform_admin_reenable_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
