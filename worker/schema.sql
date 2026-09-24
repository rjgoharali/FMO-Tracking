CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, employee_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS duty_sessions (id TEXT PRIMARY KEY, fmo_id TEXT NOT NULL, start_time TEXT NOT NULL, expected_end_time TEXT NOT NULL, actual_end_time TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE');
CREATE UNIQUE INDEX IF NOT EXISTS active_duty_per_fmo ON duty_sessions(fmo_id) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS attendance (id TEXT PRIMARY KEY, duty_session_id TEXT UNIQUE NOT NULL, fmo_id TEXT NOT NULL, check_in_time TEXT NOT NULL, selfie_path TEXT, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL NOT NULL);
CREATE TABLE IF NOT EXISTS location_logs (id TEXT PRIMARY KEY, duty_session_id TEXT NOT NULL, fmo_id TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL NOT NULL, speed REAL, battery_level REAL, recorded_at TEXT NOT NULL, client_point_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS locations_by_session ON location_logs(duty_session_id, recorded_at);
