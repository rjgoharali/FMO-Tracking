CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FMO');
CREATE TYPE duty_session_status AS ENUM ('ACTIVE', 'COMPLETED');

CREATE TABLE organization_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  organization_name varchar(150) NOT NULL DEFAULT 'Field Monitoring Organization',
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  duty_duration_minutes integer NOT NULL DEFAULT 480 CHECK (duty_duration_minutes BETWEEN 30 AND 1440),
  tracking_interval_seconds integer NOT NULL DEFAULT 45 CHECK (tracking_interval_seconds BETWEEN 30 AND 300),
  stale_after_seconds integer NOT NULL DEFAULT 180,
  offline_after_seconds integer NOT NULL DEFAULT 600,
  gps_accuracy_threshold_meters double precision NOT NULL DEFAULT 100 CHECK (gps_accuracy_threshold_meters BETWEEN 5 AND 1000),
  automatic_duty_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stale_after_seconds BETWEEN 60 AND 3600 AND stale_after_seconds > tracking_interval_seconds),
  CHECK (offline_after_seconds BETWEEN 120 AND 86400 AND offline_after_seconds > stale_after_seconds)
);
INSERT INTO organization_settings DEFAULT VALUES;

-- Credentials are centralized; admin users are users with an admin role.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id varchar(80) NOT NULL UNIQUE CHECK (login_id = upper(login_id) AND length(trim(login_id)) > 0),
  name varchar(150) NOT NULL CHECK (length(trim(name)) > 0),
  role user_role NOT NULL,
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$'),
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, role)
);
CREATE TABLE fmos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  user_role user_role NOT NULL DEFAULT 'FMO' CHECK (user_role = 'FMO'),
  phone varchar(40), email varchar(254),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, user_role) REFERENCES users(id, role) ON DELETE RESTRICT
);
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fmo_id uuid NOT NULL REFERENCES fmos(id) ON DELETE RESTRICT,
  installation_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ANDROID' CHECK (platform = 'ANDROID'),
  model varchar(100), os_version varchar(50), app_version varchar(50),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fmo_id, installation_id), UNIQUE (id, fmo_id)
);
CREATE TABLE duty_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fmo_id uuid NOT NULL REFERENCES fmos(id) ON DELETE RESTRICT,
  device_id uuid,
  start_request_id uuid NOT NULL,
  end_request_id uuid,
  start_time timestamptz NOT NULL DEFAULT now(),
  expected_end_time timestamptz NOT NULL,
  actual_end_time timestamptz,
  duty_duration_minutes integer NOT NULL CHECK (duty_duration_minutes BETWEEN 30 AND 1440),
  tracking_interval_seconds integer NOT NULL CHECK (tracking_interval_seconds BETWEEN 30 AND 300),
  status duty_session_status NOT NULL DEFAULT 'ACTIVE',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, fmo_id), UNIQUE (fmo_id, start_request_id),
  FOREIGN KEY (device_id, fmo_id) REFERENCES devices(id, fmo_id) ON DELETE RESTRICT,
  CHECK (expected_end_time = start_time + duty_duration_minutes * interval '1 minute'),
  CHECK ((status = 'ACTIVE' AND actual_end_time IS NULL AND end_request_id IS NULL)
    OR (status = 'COMPLETED' AND actual_end_time >= start_time AND end_request_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_duty_per_fmo ON duty_sessions(fmo_id) WHERE status = 'ACTIVE';
CREATE INDEX duty_fmo_start_idx ON duty_sessions(fmo_id, start_time DESC);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_session_id uuid NOT NULL UNIQUE,
  fmo_id uuid NOT NULL REFERENCES fmos(id) ON DELETE RESTRICT,
  check_in_request_id uuid NOT NULL UNIQUE,
  check_in_time timestamptz NOT NULL DEFAULT now(),
  selfie_storage_key text NOT NULL CHECK (length(selfie_storage_key) BETWEEN 1 AND 512 AND selfie_storage_key !~ '(^/|\.\.|://)'),
  selfie_sha256 char(64) NOT NULL CHECK (selfie_sha256 ~ '^[a-f0-9]{64}$'),
  selfie_mime_type text NOT NULL CHECK (selfie_mime_type IN ('image/jpeg', 'image/png')),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy BETWEEN 0 AND 100000),
  capture_method text NOT NULL DEFAULT 'LIVE_CAMERA' CHECK (capture_method IN ('LIVE_CAMERA', 'DEMO_FIXTURE')),
  verification_status text NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (verification_status IN ('NOT_VERIFIED', 'VERIFIED', 'REJECTED')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (duty_session_id, fmo_id) REFERENCES duty_sessions(id, fmo_id) ON DELETE RESTRICT,
  CHECK (capture_method <> 'DEMO_FIXTURE' OR is_demo)
);
CREATE INDEX attendance_fmo_time_idx ON attendance(fmo_id, check_in_time DESC);
CREATE INDEX attendance_time_idx ON attendance(check_in_time DESC);

CREATE TABLE location_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  duty_session_id uuid NOT NULL,
  fmo_id uuid NOT NULL REFERENCES fmos(id) ON DELETE RESTRICT,
  client_point_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy BETWEEN 0 AND 100000),
  speed double precision CHECK (speed BETWEEN 0 AND 1000),
  battery_level double precision CHECK (battery_level BETWEEN 0 AND 100),
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  is_mocked boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  FOREIGN KEY (duty_session_id, fmo_id) REFERENCES duty_sessions(id, fmo_id) ON DELETE RESTRICT,
  UNIQUE (duty_session_id, client_point_id),
  CHECK (recorded_at <= received_at + interval '2 minutes')
);
CREATE INDEX location_session_time_idx ON location_logs(duty_session_id, recorded_at, id);
CREATE INDEX location_fmo_time_idx ON location_logs(fmo_id, recorded_at DESC, id DESC);
CREATE INDEX location_received_idx ON location_logs(received_at);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action varchar(100) NOT NULL,
  entity_type varchar(80) NOT NULL, entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_actor_time_idx ON audit_logs(actor_user_id, created_at DESC);

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER fmos_updated BEFORE UPDATE ON fmos FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_updated BEFORE UPDATE ON organization_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION protect_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'History is append-only; use a reviewed retention migration' USING ERRCODE = '23514'; END; $$;
CREATE TRIGGER location_history_immutable BEFORE UPDATE OR DELETE ON location_logs FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER audit_history_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER duty_history_preserved BEFORE DELETE ON duty_sessions FOR EACH ROW EXECUTE FUNCTION protect_history();
CREATE TRIGGER attendance_history_preserved BEFORE DELETE ON attendance FOR EACH ROW EXECUTE FUNCTION protect_history();

CREATE FUNCTION validate_attendance_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duty duty_sessions;
BEGIN
  SELECT * INTO duty FROM duty_sessions WHERE id = NEW.duty_session_id FOR UPDATE;
  IF NOT FOUND OR duty.fmo_id <> NEW.fmo_id OR duty.status <> 'ACTIVE'
    OR NEW.check_in_time < duty.start_time OR NEW.check_in_time > now() + interval '2 minutes' THEN
    RAISE EXCEPTION 'Attendance requires an owned active duty and valid time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER attendance_session_guard BEFORE INSERT ON attendance FOR EACH ROW EXECUTE FUNCTION validate_attendance_session();

CREATE FUNCTION validate_location_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duty duty_sessions;
BEGIN
  SELECT * INTO duty FROM duty_sessions WHERE id = NEW.duty_session_id FOR SHARE;
  IF NOT FOUND OR duty.fmo_id <> NEW.fmo_id OR NEW.recorded_at < duty.start_time - interval '2 minutes'
    OR (duty.actual_end_time IS NOT NULL AND NEW.recorded_at > duty.actual_end_time) THEN
    RAISE EXCEPTION 'Location must belong to the duty collection window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER location_session_guard BEFORE INSERT ON location_logs FOR EACH ROW EXECUTE FUNCTION validate_location_session();

CREATE FUNCTION protect_duty_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' OR NEW.fmo_id <> OLD.fmo_id OR NEW.start_time <> OLD.start_time
    OR NEW.expected_end_time <> OLD.expected_end_time OR NEW.start_request_id <> OLD.start_request_id
    OR NEW.duty_duration_minutes <> OLD.duty_duration_minutes OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'Duty identity, timing and completion are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND (
    EXISTS (SELECT 1 FROM attendance WHERE duty_session_id = NEW.id AND check_in_time > NEW.actual_end_time)
    OR EXISTS (SELECT 1 FROM location_logs WHERE duty_session_id = NEW.id AND recorded_at > NEW.actual_end_time)) THEN
    RAISE EXCEPTION 'Duty end cannot precede recorded activity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER duty_transition_guard BEFORE UPDATE ON duty_sessions FOR EACH ROW EXECUTE FUNCTION protect_duty_transition();
