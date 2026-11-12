CREATE TABLE IF NOT EXISTS bill_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bill_transactions_request (request_id),
  KEY idx_bill_transactions_bill_date (bill_id, transaction_date, id),
  CONSTRAINT chk_bill_transactions_amount CHECK (amount > 0),
  CONSTRAINT fk_bill_transactions_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
