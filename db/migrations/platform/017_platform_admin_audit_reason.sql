-- Persist the operator's justification for sensitive administrator disable actions.
ALTER TABLE platform_admin_audit_events
  ADD COLUMN IF NOT EXISTS reason VARCHAR(500) NULL AFTER detail_code;
