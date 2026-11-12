CREATE TABLE IF NOT EXISTS property_collection_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  action_type ENUM('phone','sms','email','onsite','formal_notice') NOT NULL,
  outcome ENUM('reached','no_answer','promised','disputed','refused','sent') NOT NULL,
  contacted_at DATE NOT NULL,
  follow_up_date DATE NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_property_collection_request (request_id),
  KEY idx_property_collection_bill_date (bill_id, contacted_at, id),
  KEY idx_property_collection_follow_up (follow_up_date, outcome),
  CONSTRAINT fk_property_collection_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
