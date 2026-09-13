-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CHURNED');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'TELEPHONY', 'WEB');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('NEW_ENQUIRY', 'QUALIFIED', 'PAYMENT_PENDING', 'HUMAN_TAKEOVER', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ON_HIRE', 'RESERVED', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RateBracket" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HOLD', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('AGE_BELOW_MINIMUM', 'LICENCE_TENURE_BELOW_MINIMUM', 'DOCUMENT_CHECK_FAILED', 'CUSTOM_RATE_REQUEST', 'EXPLICIT_HUMAN_REQUEST', 'PAYMENT_DISPUTE', 'LOW_CONFIDENCE', 'SLA_BREACH', 'INVENTORY_CONFLICT');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('ENQUIRY_RECEIVED', 'MESSAGE_SENT', 'QUOTE_ISSUED', 'HOLD_CREATED', 'HOLD_REJECTED', 'HOLD_EXPIRED', 'BOOKING_SECURED', 'BOOKING_CANCELLED', 'PAYMENT_CAPTURED', 'HUMAN_ESCALATION', 'AI_DISABLED', 'AI_ENABLED', 'WEBHOOK_RECEIVED', 'WEBHOOK_REJECTED', 'WEBHOOK_DUPLICATE', 'SLA_BREACH', 'CONFIG_CHANGED');

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('SYSTEM', 'AI', 'HUMAN', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "FeeModel" AS ENUM ('RETAINER', 'COMMISSION', 'HYBRID');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trading_name" TEXT NOT NULL,
    "trade_licence_number" TEXT NOT NULL,
    "trade_licence_expires_on" DATE,
    "tax_registration_number" TEXT,
    "jurisdiction" TEXT NOT NULL DEFAULT 'AE-DU',
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
    "status" "ClientStatus" NOT NULL DEFAULT 'ONBOARDING',
    "onboarded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_configurations" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "opening_hours" JSONB NOT NULL,
    "supported_languages" TEXT[] DEFAULT ARRAY['en', 'ar', 'ru']::TEXT[],
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "minimum_driver_age" INTEGER NOT NULL DEFAULT 25,
    "minimum_licence_years" INTEGER NOT NULL DEFAULT 1,
    "required_documents" TEXT[] DEFAULT ARRAY['passport', 'driving_licence']::TEXT[],
    "category_age_overrides" JSONB NOT NULL DEFAULT '{}',
    "vat_basis_points" INTEGER NOT NULL DEFAULT 500,
    "weekly_threshold_days" INTEGER NOT NULL DEFAULT 7,
    "monthly_threshold_days" INTEGER NOT NULL DEFAULT 28,
    "delivery_fee_minor" INTEGER NOT NULL DEFAULT 0,
    "free_delivery_threshold_days" INTEGER,
    "default_deposit_minor" INTEGER NOT NULL DEFAULT 0,
    "seasonal_modifiers" JSONB NOT NULL DEFAULT '[]',
    "add_on_catalogue" JSONB NOT NULL DEFAULT '[]',
    "quote_valid_minutes" INTEGER NOT NULL DEFAULT 120,
    "hold_ttl_minutes" INTEGER NOT NULL DEFAULT 30,
    "meta_app_secret_encrypted" TEXT,
    "meta_verify_token" TEXT,
    "meta_phone_number_id" TEXT,
    "meta_business_account_id" TEXT,
    "instagram_scoped_page_id" TEXT,
    "meta_access_token_encrypted" TEXT,
    "meta_graph_api_version" TEXT NOT NULL DEFAULT 'v21.0',
    "twilio_auth_token_encrypted" TEXT,
    "twilio_number" TEXT,
    "payment_access_keys" JSONB NOT NULL DEFAULT '{}',
    "escalation_targets" JSONB NOT NULL DEFAULT '[]',
    "escalation_rules" JSONB NOT NULL DEFAULT '{}',
    "agent_display_name" TEXT,
    "agent_tone_notes" TEXT,
    "system_prompt_extra" TEXT,
    "fee_model" "FeeModel" NOT NULL DEFAULT 'HYBRID',
    "retainer_minor" INTEGER NOT NULL DEFAULT 0,
    "commission_basis_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_api_keys" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['metrics:read', 'inbox:read']::TEXT[],
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "full_name" TEXT,
    "email" TEXT,
    "locale" TEXT,
    "date_of_birth" DATE,
    "licence_number" TEXT,
    "licence_country" TEXT,
    "licence_issued_on" DATE,
    "licence_expires_on" DATE,
    "documents_verified_at" TIMESTAMPTZ(3),
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blocked_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_identities" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_categories" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "body_type" TEXT,
    "seats" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "vehicle_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "trim" TEXT,
    "colour" TEXT,
    "plate_number" TEXT NOT NULL,
    "plate_emirate" TEXT,
    "vin" TEXT,
    "daily_rate_minor" INTEGER NOT NULL,
    "weekly_rate_minor" INTEGER,
    "monthly_rate_minor" INTEGER,
    "deposit_minor" INTEGER,
    "included_km_per_day" INTEGER,
    "extra_km_rate_minor" INTEGER,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "off_road_until" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'NEW_ENQUIRY',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "external_thread_id" TEXT,
    "language" TEXT,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_outbound_at" TIMESTAMPTZ(3),
    "takeover_reason" "EscalationReason",
    "takeover_at" TIMESTAMPTZ(3),
    "assigned_to_user_id" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "provider_message_id" TEXT,
    "body" TEXT NOT NULL,
    "media_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "meta" JSONB NOT NULL DEFAULT '{}',
    "latency_ms" INTEGER,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "rate_bracket" "RateBracket" NOT NULL,
    "unit_rate_minor" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "remainder_days" INTEGER NOT NULL DEFAULT 0,
    "remainder_rate_minor" INTEGER NOT NULL DEFAULT 0,
    "base_fare_minor" INTEGER NOT NULL,
    "seasonal_code" TEXT,
    "seasonal_basis_points" INTEGER NOT NULL DEFAULT 10000,
    "seasonal_adjustment_minor" INTEGER NOT NULL DEFAULT 0,
    "delivery_required" BOOLEAN NOT NULL DEFAULT false,
    "delivery_fee_minor" INTEGER NOT NULL DEFAULT 0,
    "add_ons" JSONB NOT NULL DEFAULT '[]',
    "add_ons_total_minor" INTEGER NOT NULL DEFAULT 0,
    "subtotal_minor" INTEGER NOT NULL,
    "vat_basis_points" INTEGER NOT NULL,
    "vat_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "deposit_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "breakdown" JSONB NOT NULL,
    "calc_version" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "quote_id" UUID,
    "conversation_id" UUID,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HOLD',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "delivery_required" BOOLEAN NOT NULL DEFAULT false,
    "delivery_address" TEXT,
    "delivery_latitude" DOUBLE PRECISION,
    "delivery_longitude" DOUBLE PRECISION,
    "delivery_at" TIMESTAMPTZ(3),
    "collection_address" TEXT,
    "collection_at" TIMESTAMPTZ(3),
    "total_minor" INTEGER NOT NULL,
    "vat_minor" INTEGER NOT NULL DEFAULT 0,
    "deposit_minor" INTEGER NOT NULL DEFAULT 0,
    "paid_minor" INTEGER NOT NULL DEFAULT 0,
    "deposit_held_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "payment_provider" TEXT,
    "payment_reference" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reason" "EscalationReason" NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "notified_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "event_type" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "client_id" UUID NOT NULL,
    "event_type" "AuditEventType" NOT NULL,
    "actor" "AuditActor" NOT NULL DEFAULT 'SYSTEM',
    "conversation_id" UUID,
    "customer_id" UUID,
    "vehicle_id" UUID,
    "quote_id" UUID,
    "reservation_id" UUID,
    "channel" "ChannelType",
    "revenue_minor" INTEGER,
    "kirmi_fee_minor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "idempotency_key" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_directory" (
    "client_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL,
    "trading_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "meta_phone_number_id" TEXT,
    "meta_business_account_id" TEXT,
    "instagram_scoped_page_id" TEXT,
    "twilio_number" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_directory_pkey" PRIMARY KEY ("client_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_slug_key" ON "clients"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "clients_trade_licence_number_key" ON "clients"("trade_licence_number");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tax_registration_number_key" ON "clients"("tax_registration_number");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE UNIQUE INDEX "client_configurations_client_id_key" ON "client_configurations"("client_id");

-- CreateIndex
CREATE INDEX "client_api_keys_client_id_idx" ON "client_api_keys"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_api_keys_key_prefix_key" ON "client_api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "customers_client_id_created_at_idx" ON "customers"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_identities_client_id_customer_id_idx" ON "customer_identities"("client_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identities_client_id_channel_external_id_key" ON "customer_identities"("client_id", "channel", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_categories_client_id_code_key" ON "vehicle_categories"("client_id", "code");

-- CreateIndex
CREATE INDEX "vehicles_client_id_status_active_idx" ON "vehicles"("client_id", "status", "active");

-- CreateIndex
CREATE INDEX "vehicles_client_id_category_id_idx" ON "vehicles"("client_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_client_id_plate_number_key" ON "vehicles"("client_id", "plate_number");

-- CreateIndex
CREATE INDEX "conversations_client_id_state_idx" ON "conversations"("client_id", "state");

-- CreateIndex
CREATE INDEX "conversations_client_id_ai_enabled_idx" ON "conversations"("client_id", "ai_enabled");

-- CreateIndex
CREATE INDEX "conversations_client_id_customer_id_channel_idx" ON "conversations"("client_id", "customer_id", "channel");

-- CreateIndex
CREATE INDEX "messages_client_id_conversation_id_created_at_idx" ON "messages"("client_id", "conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_client_id_channel_provider_message_id_key" ON "messages"("client_id", "channel", "provider_message_id");

-- CreateIndex
CREATE INDEX "quotes_client_id_created_at_idx" ON "quotes"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_client_id_status_idx" ON "quotes"("client_id", "status");

-- CreateIndex
CREATE INDEX "reservations_client_id_vehicle_id_start_at_end_at_idx" ON "reservations"("client_id", "vehicle_id", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "reservations_client_id_status_idx" ON "reservations"("client_id", "status");

-- CreateIndex
CREATE INDEX "reservations_status_hold_expires_at_idx" ON "reservations"("status", "hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_client_id_reference_key" ON "reservations"("client_id", "reference");

-- CreateIndex
CREATE INDEX "escalations_client_id_status_created_at_idx" ON "escalations"("client_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "webhook_events_client_id_received_at_idx" ON "webhook_events"("client_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_client_id_provider_external_event_id_key" ON "webhook_events"("client_id", "provider", "external_event_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_client_id_event_type_occurred_at_idx" ON "platform_audit_logs"("client_id", "event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_client_id_occurred_at_idx" ON "platform_audit_logs"("client_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_audit_logs_client_id_idempotency_key_key" ON "platform_audit_logs"("client_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_directory_slug_key" ON "tenant_directory"("slug");

-- CreateIndex
CREATE INDEX "tenant_directory_meta_phone_number_id_idx" ON "tenant_directory"("meta_phone_number_id");

-- CreateIndex
CREATE INDEX "tenant_directory_instagram_scoped_page_id_idx" ON "tenant_directory"("instagram_scoped_page_id");

-- CreateIndex
CREATE INDEX "tenant_directory_twilio_number_idx" ON "tenant_directory"("twilio_number");

-- AddForeignKey
ALTER TABLE "client_configurations" ADD CONSTRAINT "client_configurations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_api_keys" ADD CONSTRAINT "client_api_keys_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_categories" ADD CONSTRAINT "vehicle_categories_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "vehicle_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

