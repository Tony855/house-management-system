-- Fence stale tenant-migration workers even when a process restarts with the same worker ID.
ALTER TABLE platform_tenant_migration_jobs
  ADD COLUMN lease_token CHAR(36) NULL AFTER lease_owner,
  ADD UNIQUE KEY uk_tenant_migration_lease_token (lease_token);

-- Give currently running jobs their own fence before new workers renew them.
UPDATE platform_tenant_migration_jobs
SET lease_token = UUID()
WHERE state = 'running' AND lease_token IS NULL;
