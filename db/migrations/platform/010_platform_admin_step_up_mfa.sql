-- Keep initial login MFA and explicit sensitive-operation step-up separate.
ALTER TABLE platform_admin_sessions
  ADD COLUMN last_step_up_at DATETIME NULL AFTER last_mfa_verified_at;
