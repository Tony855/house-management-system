-- Extend the shared throttle namespace for the independent Super Admin login.
-- Existing product rows remain valid; only the allowed app_id enum is widened.
ALTER TABLE platform_login_attempts
  MODIFY COLUMN app_id ENUM('rental','hotel','property','platform') NOT NULL;
