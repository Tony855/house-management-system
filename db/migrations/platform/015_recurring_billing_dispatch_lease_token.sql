-- Fence stale dispatch workers, including process restarts that reuse a worker ID.
ALTER TABLE platform_recurring_billing_dispatch
  ADD COLUMN lease_token CHAR(36) NULL AFTER lease_owner,
  ADD UNIQUE KEY uk_recurring_billing_lease_token (lease_token);
