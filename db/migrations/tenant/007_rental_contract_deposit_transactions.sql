CREATE TABLE IF NOT EXISTS rental_contract_deposit_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_id INT NOT NULL,
  transaction_type ENUM('receipt','refund','deduction') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rental_deposit_request (request_id),
  KEY idx_rental_deposit_contract_date (contract_id, transaction_date, id),
  CONSTRAINT chk_rental_deposit_amount CHECK (amount > 0),
  CONSTRAINT fk_rental_deposit_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
