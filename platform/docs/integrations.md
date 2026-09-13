# Integrations

Every integration reports one of five states, stored per tenant in `integrations`:

`NOT_CONNECTED` · `CONFIGURING` · `CONNECTED` · `ERROR` · `DISCONNECTED`

**BUILT is not CONNECTED.** Everything below is implemented and tested against mocks and
signed fixtures. None of it is connected to a real DEIZ account, because that needs
credentials nobody has yet.

---

## WhatsApp — Meta Cloud API · `NOT_CONNECTED`

**Built:** webhook verification (GET challenge), HMAC-SHA256 signature check over raw
bytes, envelope parser (text, interactive replies, button replies, delivery statuses),
customer identification, conversation routing, outbound text and template sends, delivery
status write-back, the 24-hour service window, and idempotency at three layers.

**Endpoint:** `POST /webhooks/whatsapp` · verification `GET /webhooks/whatsapp`

**Required to connect**

| Item | Where it comes from |
|---|---|
| Meta Business Manager + WhatsApp Business Account | Kirmi or DEIZ creates it |
| A phone number **not** registered on the WhatsApp or WhatsApp Business app | DEIZ decides which number |
| `WHATSAPP_ACCESS_TOKEN` (system user, `whatsapp_business_messaging`) | Meta console |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta console |
| `WHATSAPP_APP_SECRET` | Meta app settings |
| `WHATSAPP_VERIFY_TOKEN` | any random string, entered in both places |
| Public HTTPS URL for the webhook | deployment |
| Approved message templates | Meta review, needed only for outside-window follow-ups |

**The migration problem.** A number live on the WhatsApp Business *app* cannot serve the
API. Moving it means deregistering it, which changes how the team works day to day.
Discover this before promising a date. A Kirmi-owned test number avoids it entirely for
demonstrations.

**Routing:** set `channel:whatsapp` = `{"accountId":"<phone_number_id>"}` in
`tenant_settings`. This is what makes the webhook multi-tenant rather than DEIZ-only.

---

## Instagram — Messaging API · `NOT_CONNECTED`

**Built:** shared webhook verification, envelope parser with echo suppression (so the
engine cannot answer its own sends), unified customer/conversation model, outbound send.

**Endpoint:** `POST /webhooks/instagram`

**Required to connect:** Instagram Professional account linked to a Facebook Page;
`instagram_manage_messages` granted through App Review; Page access token; app secret.

App Review is a queue, not a switch. Budget for it.

---

## Missed calls — telephony · `NOT_CONNECTED`

**Built:** signed webhook (`x-kirmi-signature`, HMAC-SHA256 over the raw body), call
deduplication, and conversion of a missed call into an outbound WhatsApp opener.

**Endpoint:** `POST /webhooks/voice/missed-call`

```json
{ "callId": "unique", "from": "9715xxxxxxx", "to": "<tracked number>", "status": "no-answer" }
```

**The hard part is not the code.** A mobile SIM emits no webhook. This needs either a
CPaaS/VoIP number that customers dial, or carrier conditional forwarding to one. **UAE
regulates VoIP tightly — confirm provider availability under TDRA rules before designing
around it.** This is why it sits fourth in the priority order.

---

## Payments · `NOT_CONNECTED`

**Built:** provider interface, Stripe Checkout adapter, signed webhook with timestamp
tolerance (replay protection), and the staff-confirmation path.

**Endpoint:** `POST /webhooks/payments/stripe`

**Deliberate asymmetry:** card and bank transfer can reach `paid` via a provider webhook.
**Cash and crypto cannot** — they stop at `confirmed_by_staff` and record which operator
vouched for the money. DEIZ advertises all three, so this distinction is not academic.

---

## Inventory · `NOT_CONNECTED`

**Built:** availability engine over `vehicle_blocks`, with `source` marking authoritative
rows, and a tenant rule that forces "subject to confirmation" wording when no
authoritative source exists.

**Required:** the name of DEIZ's rental-management system and whether it exposes an API.
If it does not, the honest options are (a) Kirmi becomes the source of truth, or (b) every
quote stays subject to confirmation. Never assert live availability we cannot see.

---

## Conversation model · `CONNECTED` (deterministic)

The engine is a deterministic domain NLU plus a tool layer: slot filling for vehicle and
dates in English and Arabic, tiered pricing, availability, rules lookup. It is fast, free,
testable, and cannot hallucinate a price.

Set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` to add model-assisted phrasing for
messages the deterministic layer cannot parse. The tool layer remains the only source of
facts either way.
