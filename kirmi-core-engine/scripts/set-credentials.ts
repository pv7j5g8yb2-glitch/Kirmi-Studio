import { disconnectRedis } from "../src/cache/redis.js";
import { encryptSecret } from "../src/core/crypto.js";
import { disconnectPrisma, prisma } from "../src/db/prisma.js";
import { withTenant } from "../src/db/tenant-context.js";

/**
 * ===========================================================================
 * SET A CLIENT'S CHANNEL CREDENTIALS
 * ===========================================================================
 *
 *   npm run set-credentials -- <slug> <field> <value>
 *   npm run set-credentials -- deiz meta-token EAAG...
 *   npm run set-credentials -- deiz meta-phone-id 123456789012345
 *   npm run set-credentials -- deiz --show
 *
 * Kept apart from onboarding on purpose, for three reasons.
 *
 * The onboarding file is something you edit, save, commit and re-run. A Meta
 * access token can post as the client's business; it must never end up in a
 * file that gets committed, and re-running an onboarding file must never wipe
 * a credential somebody set separately.
 *
 * Secrets are encrypted before they are written, so a database dump is not a
 * set of working credentials.
 *
 * And --show prints only whether each one is set and the last four characters,
 * never the value, because the usual reason to look is "did that save" rather
 * than "what is it".
 */

const FIELDS = {
  "meta-token": {
    column: "metaAccessTokenEncrypted",
    encrypted: true,
    what: "Meta access token. Can post as the client's business, so this is the one that matters most.",
  },
  "meta-app-secret": {
    column: "metaAppSecretEncrypted",
    encrypted: true,
    what: "Meta app secret, used to verify that an incoming webhook really came from Meta.",
  },
  "meta-verify-token": {
    column: "metaVerifyToken",
    encrypted: false,
    what: "Any string you choose. Meta echoes it back when you first subscribe the webhook.",
  },
  "meta-phone-id": {
    column: "metaPhoneNumberId",
    encrypted: false,
    what: "The WhatsApp phone number ID from Meta. Not the phone number itself.",
  },
  "meta-business-id": { column: "metaBusinessAccountId", encrypted: false, what: "WhatsApp Business Account ID." },
  "instagram-page-id": { column: "instagramScopedPageId", encrypted: false, what: "Instagram scoped page ID." },
  "twilio-sid": { column: "twilioAccountSid", encrypted: false, what: "Twilio Account SID, starts with AC." },
  "twilio-token": { column: "twilioAuthTokenEncrypted", encrypted: true, what: "Twilio auth token." },
  "twilio-number": { column: "twilioNumber", encrypted: false, what: "Twilio sending number in +971... form." },
} as const;

type Field = keyof typeof FIELDS;

async function main(): Promise<void> {
  const slug = process.argv[2];
  const field = process.argv[3] as Field | "--show" | undefined;
  const value = process.argv.slice(4).join(" ");

  if (!slug) {
    usage();
    process.exitCode = 1;
    return;
  }

  const entry = await prisma().tenantDirectory.findUnique({ where: { slug } });
  if (!entry) {
    process.stdout.write(`\nNo client with slug "${slug}". Run the onboarding first.\n\n`);
    process.exitCode = 1;
    return;
  }

  if (!field || field === "--show") {
    await show(entry.clientId, slug);
    return;
  }

  if (!(field in FIELDS)) {
    process.stdout.write(`\n"${field}" is not a field I know about.\n`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (!value) {
    process.stdout.write(`\nNo value given for ${field}.\n\n`);
    process.exitCode = 1;
    return;
  }

  const spec = FIELDS[field];

  // Catch the two pastes that go wrong most often before they are stored.
  if (field === "meta-phone-id" && !/^\d{10,20}$/.test(value)) {
    process.stdout.write(
      `\nThat does not look like a phone number ID. Meta's phone number ID is a long number, ` +
        `not the phone number itself. You are looking for the value labelled "Phone number ID" in the ` +
        `WhatsApp setup screen.\n\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (field === "twilio-sid" && !value.startsWith("AC")) {
    process.stdout.write(`\nA Twilio Account SID starts with "AC". That looks like something else.\n\n`);
    process.exitCode = 1;
    return;
  }

  await withTenant(entry.clientId, async (tx) => {
    await tx.clientConfiguration.update({
      where: { clientId: entry.clientId },
      data: { [spec.column]: spec.encrypted ? encryptSecret(value) : value },
    });
  });

  process.stdout.write(`\nSaved ${field} for ${slug}${spec.encrypted ? ", encrypted" : ""}.\n`);
  process.stdout.write(`  ends with ...${value.slice(-4)}\n\n`);
  process.stdout.write("Run `npm run doctor` to confirm the client is ready.\n\n");
}

async function show(clientId: string, slug: string): Promise<void> {
  const config = await withTenant(clientId, async (tx) =>
    tx.clientConfiguration.findUnique({
      where: { clientId },
      select: {
        metaAccessTokenEncrypted: true,
        metaAppSecretEncrypted: true,
        metaVerifyToken: true,
        metaPhoneNumberId: true,
        metaBusinessAccountId: true,
        instagramScopedPageId: true,
        twilioAccountSid: true,
        twilioAuthTokenEncrypted: true,
        twilioNumber: true,
      },
    }),
  );

  if (!config) {
    process.stdout.write(`\nNo configuration row for "${slug}".\n\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nCredentials for ${slug}\n\n`);
  for (const [name, spec] of Object.entries(FIELDS)) {
    const raw = (config as Record<string, string | null>)[spec.column];
    const state = raw ? (spec.encrypted ? "set (encrypted)" : `set, ends ...${raw.slice(-4)}`) : "not set";
    process.stdout.write(`  ${name.padEnd(20)} ${state}\n`);
  }
  process.stdout.write("\n");
}

function usage(): void {
  process.stdout.write("\nUsage:\n");
  process.stdout.write("  npm run set-credentials -- <slug> --show\n");
  process.stdout.write("  npm run set-credentials -- <slug> <field> <value>\n\n");
  process.stdout.write("Fields:\n");
  for (const [name, spec] of Object.entries(FIELDS)) {
    process.stdout.write(`  ${name.padEnd(20)} ${spec.what}\n`);
  }
  process.stdout.write("\n");
}

main()
  .catch((err: unknown) => {
    process.stdout.write(`\nFailed: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  });
