-- Operator core schema (M1–M4).
-- Money is stored as integer cents. Times are integer milliseconds since the
-- Unix epoch (UTC). Every consequential change writes a row to job_events.

-- Atomic precondition guard. A batch starts with
--   UPDATE guard SET ok = (CASE WHEN <precondition> THEN 1 ELSE 0 END) WHERE id = 1
-- If the precondition is false the CHECK fails and D1 rolls back the whole
-- batch, so optimistic-concurrency checks and the writes they protect commit
-- together or not at all.
CREATE TABLE guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ok INTEGER NOT NULL CONSTRAINT precondition_failed CHECK (ok = 1)
);
INSERT INTO guard (id, ok) VALUES (1, 1);

-- Named sequences (job references, invoice numbers).
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Key/value settings (tax configuration, etc.). JSON values.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login_email TEXT UNIQUE,
  ref_code TEXT NOT NULL UNIQUE,
  share_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (share_rate_bps BETWEEN 0 AND 10000),
  terms_status TEXT NOT NULL DEFAULT 'unagreed' CHECK (terms_status IN ('unagreed', 'agreed')),
  policy_label TEXT NOT NULL DEFAULT 'TEST POLICY — not agreed commercial terms',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES "user" ("id"),
  partner_id TEXT REFERENCES partners (id),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'needs_info', 'quoted', 'approved', 'dispatched', 'in_progress',
    'blocked', 'completed', 'invoiced', 'paid', 'cancelled', 'declined')),
  requested_outcome TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  contact_method TEXT NOT NULL,
  pickup_location TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  destination_contact TEXT NOT NULL DEFAULT '',
  requested_timing TEXT NOT NULL DEFAULT '',
  limits TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'direct',
  current_quote_id TEXT,
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_customer_idx ON jobs (customer_id, created_at);
CREATE INDEX jobs_status_idx ON jobs (status, updated_at);
CREATE INDEX jobs_partner_idx ON jobs (partner_id, created_at);

-- Append-only audit log. job_version is the job's version after the change.
CREATE TABLE job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  created_at INTEGER NOT NULL,
  actor_id TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('customer', 'operator', 'partner', 'system', 'agent')),
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  job_version INTEGER NOT NULL,
  ref_table TEXT,
  ref_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'customer'))
);
CREATE INDEX job_events_job_idx ON job_events (job_id, created_at);

CREATE TABLE job_messages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  author_id TEXT,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer', 'operator', 'agent', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'note', 'issue', 'resolution')),
  visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'customer')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX job_messages_job_idx ON job_messages (job_id, created_at);

-- Private files. Objects live in R2 under r2_key and are only served through
-- the authorizing /files/:id route.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  kind TEXT NOT NULL CHECK (kind IN ('customer_material', 'evidence', 'receipt')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_job_idx ON attachments (job_id, created_at);

CREATE TABLE availability (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (ends_at > starts_at)
);
CREATE INDEX availability_range_idx ON availability (starts_at, ends_at);

-- Versioned quotes. Customer approval binds to (quote id, content_hash).
-- Operator acceptance is recorded on the same quote version. Dispatch happens
-- only when both are present.
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  authorized_steps TEXT NOT NULL,
  service_fee_cents INTEGER NOT NULL CHECK (service_fee_cents >= 0),
  expense_ceiling_cents INTEGER NOT NULL CHECK (expense_ceiling_cents >= 0),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  terms TEXT NOT NULL,
  required_authority TEXT NOT NULL DEFAULT '',
  required_materials TEXT NOT NULL DEFAULT '',
  completion_evidence TEXT NOT NULL DEFAULT '',
  if_blocked TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'approved', 'rejected', 'superseded', 'withdrawn')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  customer_decision_by TEXT,
  customer_decision_at INTEGER,
  customer_decision_note TEXT,
  operator_accepted_by TEXT,
  operator_accepted_at INTEGER,
  UNIQUE (job_id, version),
  CHECK (window_end > window_start)
);
CREATE INDEX quotes_job_idx ON quotes (job_id, version);

-- One work order per approved+accepted quote version: duplicate dispatch
-- events cannot create a second assignment.
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes (id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  quote_id TEXT NOT NULL REFERENCES quotes (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT NOT NULL,
  receipt_attachment_id TEXT NOT NULL REFERENCES attachments (id),
  reported_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX expenses_job_idx ON expenses (job_id);

CREATE TABLE completions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs (id),
  quote_id TEXT NOT NULL REFERENCES quotes (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'completed_with_exception')),
  summary TEXT NOT NULL,
  unresolved_items TEXT NOT NULL DEFAULT '',
  exception_resolved_at INTEGER,
  exception_resolved_by TEXT,
  confirmed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  event_key TEXT NOT NULL UNIQUE
);

-- Invoices. A number is allocated when the draft is created and is never
-- reused; corrections create a new revision of the same number and keep the
-- earlier revision as 'void'. At most one draft and one issued revision per job.
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  customer_id TEXT NOT NULL,
  quote_id TEXT NOT NULL REFERENCES quotes (id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'void')),
  is_test INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  service_fee_cents INTEGER NOT NULL,
  reimbursable_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  tax_label TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  supersedes_id TEXT REFERENCES invoices (id),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  issued_at INTEGER,
  issued_by TEXT,
  voided_at INTEGER,
  voided_by TEXT,
  void_reason TEXT,
  UNIQUE (number, revision),
  CHECK (total_cents = service_fee_cents + reimbursable_cents + tax_cents)
);
CREATE UNIQUE INDEX invoices_one_draft_per_job ON invoices (job_id) WHERE status = 'draft';
CREATE UNIQUE INDEX invoices_one_issued_per_job ON invoices (job_id) WHERE status = 'issued';

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  sort INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('service', 'reimbursement', 'tax')),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  expense_id TEXT REFERENCES expenses (id)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, sort);

-- Payment records are separate from invoices. 'manual_confirmation' requires a
-- recorded reference; no payment provider is connected yet.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('manual_confirmation')),
  reference TEXT NOT NULL,
  is_test INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

-- Partner reconciliation, kept apart from the customer invoice. Basis is the
-- service fee only; reimbursements are never included.
CREATE TABLE partner_ledger (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners (id),
  job_id TEXT NOT NULL REFERENCES jobs (id),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('accrual', 'reversal')),
  basis_cents INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_collection', 'earned', 'reversed')),
  policy_label TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX partner_ledger_partner_idx ON partner_ledger (partner_id, created_at);

-- Notification outbox. Rows are written in the same batch as the state change
-- they announce, then delivered by the background runner with retries.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs (id),
  recipient_user_id TEXT,
  recipient_email TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  link_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'simulated', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  provider TEXT,
  provider_message_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX notifications_due_idx ON notifications (status, next_attempt_at);
CREATE INDEX notifications_job_idx ON notifications (job_id);
CREATE INDEX notifications_ack_idx ON notifications (requires_ack, acknowledged_at);

-- Local development only: the 'dev' email provider writes here instead of
-- sending. Production refuses to start with EMAIL_PROVIDER=dev.
CREATE TABLE dev_mailbox (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX dev_mailbox_recipient_idx ON dev_mailbox (recipient, created_at);

-- Catherine runtime. Each run records the exact spec version/hash, provider
-- and model. Output is a proposal; nothing executes without operator approval.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('plan')),
  spec_id TEXT NOT NULL,
  spec_version TEXT NOT NULL,
  spec_sha256 TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  job_version INTEGER NOT NULL,
  input_sha256 TEXT,
  output TEXT,
  last_error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_microusd INTEGER,
  requested_by TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX agent_runs_due_idx ON agent_runs (status, next_attempt_at);
CREATE INDEX agent_runs_job_idx ON agent_runs (job_id, created_at);
CREATE INDEX agent_runs_month_idx ON agent_runs (created_at);

CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs (id),
  job_id TEXT NOT NULL REFERENCES jobs (id),
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'rejected', 'executed', 'failed', 'invalid')),
  validation_error TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  result TEXT,
  error TEXT,
  UNIQUE (run_id, seq)
);
CREATE INDEX agent_actions_job_idx ON agent_actions (job_id, status);
