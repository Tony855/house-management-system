-- Platform subscription billing. Apply only after 001_platform_tenant_registry.sql.
-- Amounts are stored in minor currency units (e.g. USD cents, KHR riel).
-- This schema contains platform subscription charges only, never tenant customer invoices.
CREATE TABLE IF NOT EXISTS platform_billing_accounts (
  tenant_uuid CHAR(36) NOT NULL PRIMARY KEY,
  billing_name VARCHAR(160) NOT NULL,
  billing_email VARCHAR(254) NULL,
  billing_country CHAR(2) NULL,
  tax_reference VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_platform_billing_account_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_products (
  product_code VARCHAR(40) NOT NULL PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  status ENUM('active','retired') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(40) NOT NULL,
  plan_code VARCHAR(60) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  billing_interval ENUM('month','year','once') NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  trial_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  limits_json JSON NULL,
  features_json JSON NULL,
  status ENUM('draft','active','retired') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_plan_product_code (product_code, plan_code),
  KEY idx_platform_plan_status (status, product_code),
  CONSTRAINT fk_platform_plan_product FOREIGN KEY (product_code) REFERENCES platform_products(product_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_uuid CHAR(36) NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  status ENUM('trialing','active','past_due','paused','cancel_at_period_end','canceled','incomplete') NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  currency CHAR(3) NOT NULL,
  unit_amount_minor BIGINT UNSIGNED NOT NULL,
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  trial_ends_at DATETIME NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_platform_subscription_tenant (tenant_uuid, status),
  KEY idx_platform_subscription_due (status, current_period_end),
  CONSTRAINT fk_platform_subscription_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid),
  CONSTRAINT fk_platform_subscription_plan FOREIGN KEY (plan_id) REFERENCES platform_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_no VARCHAR(40) NOT NULL,
  tenant_uuid CHAR(36) NOT NULL,
  subscription_id BIGINT UNSIGNED NULL,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  currency CHAR(3) NOT NULL,
  subtotal_minor BIGINT UNSIGNED NOT NULL,
  discount_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tax_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_minor BIGINT UNSIGNED NOT NULL,
  status ENUM('draft','open','paid','void','uncollectible') NOT NULL DEFAULT 'draft',
  issued_at DATETIME NULL,
  due_at DATETIME NULL,
  paid_at DATETIME NULL,
  voided_at DATETIME NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_invoice_no (invoice_no),
  UNIQUE KEY uk_platform_invoice_idempotency (idempotency_key),
  UNIQUE KEY uk_platform_invoice_subscription_period (subscription_id, billing_period_start, billing_period_end),
  KEY idx_platform_invoice_tenant_status (tenant_uuid, status, due_at),
  CONSTRAINT fk_platform_invoice_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid),
  CONSTRAINT fk_platform_invoice_subscription FOREIGN KEY (subscription_id) REFERENCES platform_subscriptions(id),
  CONSTRAINT chk_platform_invoice_total CHECK (total_minor = subtotal_minor - discount_minor + tax_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_invoice_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_id BIGINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_amount_minor BIGINT UNSIGNED NOT NULL,
  line_total_minor BIGINT UNSIGNED NOT NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_invoice_line_invoice (invoice_id),
  CONSTRAINT fk_platform_invoice_line_invoice FOREIGN KEY (invoice_id) REFERENCES platform_invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_payment_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_uuid CHAR(36) NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL,
  provider_transaction_id VARCHAR(160) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  status ENUM('pending','succeeded','failed','partially_refunded','refunded') NOT NULL,
  provider_payload_hash CHAR(64) NULL,
  succeeded_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_payment_idempotency (provider, idempotency_key),
  UNIQUE KEY uk_platform_payment_provider_tx (provider, provider_transaction_id),
  KEY idx_platform_payment_invoice (invoice_id, status),
  CONSTRAINT fk_platform_payment_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid),
  CONSTRAINT fk_platform_payment_invoice FOREIGN KEY (invoice_id) REFERENCES platform_invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_payment_webhook_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  provider_event_id VARCHAR(160) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  processing_status ENUM('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  UNIQUE KEY uk_platform_webhook_provider_event (provider, provider_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT UNSIGNED NOT NULL,
  provider_refund_id VARCHAR(160) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('pending','succeeded','failed') NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_refund_idempotency (idempotency_key),
  UNIQUE KEY uk_platform_refund_provider_id (provider_refund_id),
  KEY idx_platform_refund_payment (payment_id, status),
  CONSTRAINT fk_platform_refund_payment FOREIGN KEY (payment_id) REFERENCES platform_payment_transactions(id),
  CONSTRAINT fk_platform_refund_admin FOREIGN KEY (created_by) REFERENCES platform_admins(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_uuid CHAR(36) NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  payment_id BIGINT UNSIGNED NULL,
  refund_id BIGINT UNSIGNED NULL,
  entry_type ENUM('invoice_issued','payment_received','refund_issued','credit_adjustment','debit_adjustment') NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  reference_key VARCHAR(160) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_ledger_reference (reference_key),
  KEY idx_platform_ledger_tenant_time (tenant_uuid, created_at),
  CONSTRAINT fk_platform_ledger_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid),
  CONSTRAINT fk_platform_ledger_invoice FOREIGN KEY (invoice_id) REFERENCES platform_invoices(id),
  CONSTRAINT fk_platform_ledger_payment FOREIGN KEY (payment_id) REFERENCES platform_payment_transactions(id),
  CONSTRAINT fk_platform_ledger_refund FOREIGN KEY (refund_id) REFERENCES platform_refunds(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS platform_billing_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT UNSIGNED NULL,
  tenant_uuid CHAR(36) NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(60) NOT NULL,
  target_id VARCHAR(100) NOT NULL,
  reason VARCHAR(500) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  request_id VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_billing_audit_tenant_time (tenant_uuid, created_at),
  KEY idx_platform_billing_audit_admin_time (admin_id, created_at),
  CONSTRAINT fk_platform_billing_audit_admin FOREIGN KEY (admin_id) REFERENCES platform_admins(id),
  CONSTRAINT fk_platform_billing_audit_tenant FOREIGN KEY (tenant_uuid) REFERENCES platform_tenants(tenant_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
