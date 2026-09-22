CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_type text NOT NULL CHECK (client_type IN ('mobile', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
ALTER TABLE refresh_tokens ADD COLUMN session_id uuid REFERENCES auth_sessions(id) ON DELETE RESTRICT;
-- Any tokens from before the session-aware implementation must reauthenticate.
UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now());
CREATE INDEX refresh_session_idx ON refresh_tokens(session_id);
CREATE TABLE login_rate_limits (
  key_hash char(64) PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);

ALTER TABLE duty_sessions ADD COLUMN start_request_hash char(64);
ALTER TABLE duty_sessions ADD COLUMN end_request_hash char(64);
-- Server actual_end_time stays authoritative. This optional client report limits
-- subsequent collection and must never be represented as a verified server time.
ALTER TABLE duty_sessions ADD COLUMN reported_stop_time timestamptz;
ALTER TABLE duty_sessions ADD COLUMN end_location_failure text CHECK (end_location_failure IN ('GPS_UNAVAILABLE', 'PERMISSION_REVOKED'));
ALTER TABLE duty_sessions ADD CONSTRAINT reported_stop_window CHECK (
  reported_stop_time IS NULL OR (actual_end_time IS NOT NULL AND reported_stop_time BETWEEN start_time AND actual_end_time)
);
ALTER TABLE location_logs ADD COLUMN payload_hash char(64);
ALTER TABLE location_logs ADD COLUMN device_recorded_at timestamptz;
ALTER TABLE location_logs ADD COLUMN quality text NOT NULL DEFAULT 'UNASSESSED'
  CHECK (quality IN ('GOOD', 'ACCEPTABLE', 'POOR', 'MOCKED', 'UNASSESSED'));

CREATE TABLE camera_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_session_id uuid NOT NULL,
  fmo_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (duty_session_id, fmo_id) REFERENCES duty_sessions(id, fmo_id) ON DELETE RESTRICT
);
CREATE INDEX camera_challenges_session_idx ON camera_challenges(duty_session_id);
ALTER TABLE attendance DROP CONSTRAINT attendance_duty_session_id_key;
ALTER TABLE attendance ADD COLUMN request_hash char(64);
ALTER TABLE attendance ADD COLUMN device_recorded_at timestamptz;
ALTER TABLE attendance ADD COLUMN superseded_at timestamptz;
ALTER TABLE attendance ADD COLUMN superseded_by uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE attendance ADD COLUMN reset_reason text;
ALTER TABLE attendance ADD CONSTRAINT attendance_reset_fields CHECK (
  (superseded_at IS NULL AND superseded_by IS NULL AND reset_reason IS NULL)
  OR (superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND reset_reason IS NOT NULL AND length(reset_reason) BETWEEN 5 AND 500)
);
CREATE UNIQUE INDEX one_current_attendance_per_session ON attendance(duty_session_id) WHERE superseded_at IS NULL;

CREATE FUNCTION protect_attendance_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
    OR (to_jsonb(NEW) - ARRAY['superseded_at','superseded_by','reset_reason'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at','superseded_by','reset_reason']) THEN
    RAISE EXCEPTION 'Attendance evidence is immutable; only explicit supersession is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER attendance_evidence_immutable BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION protect_attendance_update();

CREATE OR REPLACE FUNCTION validate_location_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duty duty_sessions;
BEGIN
  SELECT * INTO duty FROM duty_sessions WHERE id = NEW.duty_session_id FOR SHARE;
  IF NOT FOUND OR duty.fmo_id <> NEW.fmo_id OR NEW.recorded_at < duty.start_time - interval '2 minutes'
    OR (duty.actual_end_time IS NOT NULL AND NEW.recorded_at > COALESCE(duty.reported_stop_time, duty.actual_end_time)) THEN
    RAISE EXCEPTION 'Location must belong to the duty collection window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION protect_duty_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED'
    OR (to_jsonb(NEW) - ARRAY['status','actual_end_time','reported_stop_time','end_request_id','end_request_hash','end_location_failure'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','actual_end_time','reported_stop_time','end_request_id','end_request_hash','end_location_failure']) THEN
    RAISE EXCEPTION 'Duty identity, timing and completion are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND (
    EXISTS (SELECT 1 FROM attendance WHERE duty_session_id = NEW.id AND check_in_time > COALESCE(NEW.reported_stop_time,NEW.actual_end_time))
    OR EXISTS (SELECT 1 FROM location_logs WHERE duty_session_id = NEW.id AND recorded_at > COALESCE(NEW.reported_stop_time,NEW.actual_end_time))) THEN
    RAISE EXCEPTION 'Duty end cannot precede recorded activity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
