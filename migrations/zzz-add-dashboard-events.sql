-- Dashboard Events / Meetings
-- Supports user-created events and meetings shown in dashboard reminders/calendar.

CREATE TABLE IF NOT EXISTS dashboard_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('event', 'meeting')),
  starts_at TIMESTAMP NOT NULL,
  notes TEXT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard_event_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES dashboard_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_events_starts_at
  ON dashboard_events(starts_at);

CREATE INDEX IF NOT EXISTS idx_dashboard_event_participants_user
  ON dashboard_event_participants(user_id);
