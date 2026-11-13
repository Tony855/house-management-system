CREATE TABLE IF NOT EXISTS hotel_order_deposit_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  transaction_type ENUM('receipt','refund') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  pay_method VARCHAR(30) NOT NULL DEFAULT '',
  external_reference VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_hotel_deposit_request (request_id),
  KEY idx_hotel_deposit_order_date (order_id, transaction_date, id),
  CONSTRAINT chk_hotel_deposit_amount CHECK (amount > 0),
  CONSTRAINT fk_hotel_deposit_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
