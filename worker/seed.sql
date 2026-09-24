INSERT OR IGNORE INTO users (id,employee_code,name,role,password_hash,is_active,created_at) VALUES
('admin-001','ADMIN-001','Admin User','ADMIN','pbkdf2$100000$a8601e80fa6691d7315f2954786077ca$93c36c38e7f2be1500e6ecc9d81d53572ced5985b5861908f554c3c8d7055d5b',1,datetime('now')),
('fmo-001','CHK-FMO-001','Kaleem Arif','FMO','pbkdf2$120000$fe2093c606ed211a5fd3dd9c982ac883$74b0a0ec14b7e671e5fb26e23ee335289b1d8716b71d39575b777f39a3ee82ee',1,datetime('now')),
('fmo-002','CHK-FMO-002','Anthony Munir','FMO','pbkdf2$120000$c4cb508b16397d9a98b2b7157ef66fd8$582800470fb3ef279e459b09c50304588bb23f38a6eec6bb72d6a20e42d8a6c6',1,datetime('now'));
