-- Distinguish machine actors from human users in tenant write audit history.
ALTER TABLE tenant_write_audit_events
  MODIFY COLUMN event_type ENUM(
    'tenant_write_started','tenant_write_replayed','tenant_write_committed',
    'tenant_system_write_started','tenant_system_write_replayed','tenant_system_write_committed'
  ) NOT NULL,
  ADD COLUMN actor_type ENUM('user','system') NOT NULL DEFAULT 'user' AFTER tenant_uuid,
  ADD COLUMN system_id VARCHAR(100) NULL AFTER actor_type,
  ADD KEY idx_tenant_write_audit_system_actor (actor_type, system_id, created_at);
