-- Kirmi platform schema.
-- Tenant isolation is enforced by Postgres row-level security, not by application
-- discipline: every tenant-scoped table carries tenant_id and a policy that compares
-- it to app.tenant_id, set per connection checkout. A query that forgets to filter
-- returns zero rows rather than another client's data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenancy ----
CREATE TABLE IF NOT EXISTS tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('demo','production')),
  timezone      text NOT NULL DEFAULT 'Asia/Dubai',
  currency      text NOT NULL DEFAULT 'AED',
  locales       text[] NOT NULL DEFAULT ARRAY['en'],
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Tenant settings hold business rules as DATA. No rule is ever hard-coded.
-- `provenance` records how we know each value: verified / client / assumed.
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           text NOT NULL,
  value         jsonb NOT NULL,
  provenance    text NOT NULL DEFAULT 'assumed'
                  CHECK (provenance IN ('verified_public','client_provided','assumed')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ------------------------------------------------------------- operators ----
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  -- kirmi_admin sees every tenant; client_* are scoped to their memberships
  role          text NOT NULL CHECK (role IN ('kirmi_admin','client_admin','client_operator')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- integrations ----
-- The five states the brief mandates. An integration never silently "works".
CREATE TABLE IF NOT EXISTS integrations (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('whatsapp','instagram','voice','payments','inventory','llm')),
  state         text NOT NULL DEFAULT 'NOT_CONNECTED'
                  CHECK (state IN ('NOT_CONNECTED','CONFIGURING','CONNECTED','ERROR','DISCONNECTED')),
  detail        text,
  requirements  jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

-- --------------------------------------------------------------- fleet ------
CREATE TABLE IF NOT EXISTS vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  make          text NOT NULL,
  model         text NOT NULL,
  year          int,
  category      text NOT NULL DEFAULT 'standard',
  plate         text,
  -- fils (1/100 AED) everywhere money is stored; never floats
  daily_rate    bigint NOT NULL CHECK (daily_rate >= 0),
  weekly_rate   bigint,
  monthly_rate  bigint,
  deposit       bigint NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  daily_km      int,
  extra_km_rate bigint,
  min_age       int,
  min_days      int NOT NULL DEFAULT 1 CHECK (min_days >= 1),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plate)
);
CREATE INDEX IF NOT EXISTS vehicles_tenant_status_idx ON vehicles (tenant_id, status);

-- Availability is only ever asserted from an authoritative source. When a tenant has
-- no connected inventory system, `source` is 'kirmi' and quoting says "subject to
-- confirmation" — the engine reads this column to decide which wording it may use.
CREATE TABLE IF NOT EXISTS vehicle_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('booking','hold','maintenance','external')),
  source        text NOT NULL DEFAULT 'kirmi' CHECK (source IN ('kirmi','external_api','staff')),
  reference_id  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS vehicle_blocks_lookup_idx
  ON vehicle_blocks (tenant_id, vehicle_id, starts_at, ends_at);

-- ------------------------------------------------------- customers / conv ----
CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name  text,
  phone_e164    text,
  instagram_id  text,
  locale        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164),
  UNIQUE (tenant_id, instagram_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('whatsapp','instagram','voice','web')),
  state         text NOT NULL DEFAULT 'ai_active'
                  CHECK (state IN ('ai_active','human_active','closed')),
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- WhatsApp only permits free-form replies inside 24h of the last inbound message.
  last_inbound_at  timestamptz,
  last_message_at  timestamptz,
  locale        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_tenant_state_idx ON conversations (tenant_id, state, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel       text NOT NULL,
  body          text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- provider_message_id is the idempotency key for inbound webhook replays
  provider_message_id text,
  status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','queued','sent','delivered','read','failed')),
  author        text NOT NULL DEFAULT 'customer'
                  CHECK (author IN ('customer','ai','operator','system')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_dedupe_idx
  ON messages (tenant_id, channel, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

-- Raw webhook receipts: the dedupe ledger, kept separately so a replay is cheap
-- to detect even before we parse the body.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL,
  provider_event_id text NOT NULL,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, provider_event_id)
);

-- ------------------------------------------------------------- commerce -----
CREATE TABLE IF NOT EXISTS enquiries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  vehicle_hint  text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','qualified','quoted','converted','lost')),
  qualification jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiries_tenant_status_idx ON enquiries (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enquiry_id    uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  days          int NOT NULL CHECK (days >= 1),
  currency      text NOT NULL DEFAULT 'AED',
  rate_applied  text NOT NULL CHECK (rate_applied IN ('daily','weekly','monthly')),
  subtotal      bigint NOT NULL,
  delivery_fee  bigint NOT NULL DEFAULT 0,
  extras        bigint NOT NULL DEFAULT 0,
  vat           bigint NOT NULL DEFAULT 0,
  total         bigint NOT NULL,
  deposit       bigint NOT NULL DEFAULT 0,
  -- true only when availability came from an authoritative source
  availability_confirmed boolean NOT NULL DEFAULT false,
  breakdown     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id      uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  -- A reservation only reaches 'confirmed' on an authoritative signal.
  state         text NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','held','documents_pending','payment_pending',
                                   'confirmed','cancelled','expired','completed')),
  hold_expires_at timestamptz,
  confirmed_at  timestamptz,
  confirmation_source text
                  CHECK (confirmation_source IN ('payment_provider','staff','external_system')),
  confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  total         bigint NOT NULL,
  currency      text NOT NULL DEFAULT 'AED',
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservations_tenant_state_idx ON reservations (tenant_id, state, starts_at);

CREATE TABLE IF NOT EXISTS reservation_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  from_state    text,
  to_state      text NOT NULL,
  reason        text,
  actor         text NOT NULL DEFAULT 'system',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('passport','driving_licence','international_permit','visa','other')),
  status        text NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','received','verified','rejected')),
  -- media stays with the provider; we hold a reference, never the document bytes
  media_ref     text,
  note          text,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  amount        bigint NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'AED',
  method        text NOT NULL CHECK (method IN ('card','cash','crypto','bank_transfer')),
  provider      text,
  provider_ref  text,
  -- cash/crypto can only ever reach 'confirmed_by_staff'; never a provider webhook
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','authorized','paid','confirmed_by_staff','failed','refunded')),
  confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_ref)
);

-- --------------------------------------------------- follow-up / recovery ----
CREATE TABLE IF NOT EXISTS followups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  enquiry_id    uuid REFERENCES enquiries(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('quote_followup','reactivation','document_chase','pickup_reminder','dropoff_reminder')),
  due_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','sent','cancelled','failed','skipped')),
  attempt       int NOT NULL DEFAULT 0,
  -- outside WhatsApp's 24h window a template is required; recorded here
  requires_template boolean NOT NULL DEFAULT false,
  template_name text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followups_due_idx ON followups (status, due_at);

-- Outbound send queue with retry/backoff, so a provider outage never loses a reply.
CREATE TABLE IF NOT EXISTS outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  message_id    uuid REFERENCES messages(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  to_address    text NOT NULL,
  body          text,
  template      jsonb,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','failed','dead')),
  attempt       int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  -- caller-supplied key makes enqueue itself idempotent
  idempotency_key text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox (status, next_attempt_at);

-- ------------------------------------------------------------- auditing -----
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor         text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity        text,
  entity_id     text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_log (tenant_id, created_at DESC);

-- ---------------------------------------------------------------- RLS -------
-- app.tenant_id is set per checked-out connection. app.bypass_rls is reserved for
-- migrations and the Kirmi-admin cross-tenant views.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings','integrations','vehicles','vehicle_blocks','customers',
    'conversations','messages','enquiries','quotes','reservations',
    'reservation_events','documents','payments','followups','outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )$f$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------- application role ----
-- RLS is not applied to superusers or to roles with BYPASSRLS, so the application
-- must never connect as the owner. Migrations run as the owner; the app runs as
-- kirmi_app, which is subject to every policy above.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_app') THEN
    CREATE ROLE kirmi_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO kirmi_app;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO kirmi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kirmi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO kirmi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kirmi_app;
