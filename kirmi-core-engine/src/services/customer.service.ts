import type { ChannelType, Customer } from "@prisma/client";
import type { TenantTx } from "../db/tenant-context.js";

/**
 * Identity resolution.
 *
 * One human reaches a client on WhatsApp, then again by Instagram DM, then
 * their PA calls the landline. Three handles, one customer, and the engine has
 * to know that or it quotes the same person three times and looks like it has
 * never met them.
 *
 * The unique key on customer_identities is (client_id, channel, external_id).
 * That composite is load bearing: the same phone number enquiring with two
 * different Kirmi clients is two unrelated customers, and merging them would
 * leak one client's customer history into another's.
 */
export class CustomerService {
  /**
   * Find the customer behind a channel handle, creating one on first contact.
   *
   * Upsert rather than find-then-create because two messages from the same new
   * number can arrive in the same second, and a find-then-create races itself
   * into two customer rows for one person.
   */
  async resolveByIdentity(
    tx: TenantTx,
    clientId: string,
    channel: ChannelType,
    externalId: string,
    displayName?: string,
  ): Promise<{ customer: Customer; isNew: boolean }> {
    const existing = await tx.customerIdentity.findUnique({
      where: { clientId_channel_externalId: { clientId, channel, externalId } },
      include: { customer: true },
    });

    if (existing) {
      // Display names change. Keeping the latest costs one write and saves a
      // human in the inbox seeing a phone number where a name should be.
      if (displayName && displayName !== existing.displayName) {
        await tx.customerIdentity.update({ where: { id: existing.id }, data: { displayName } });
      }
      return { customer: existing.customer, isNew: false };
    }

    const customer = await tx.customer.create({
      data: {
        clientId,
        fullName: displayName ?? null,
        identities: {
          create: { clientId, channel, externalId, displayName: displayName ?? null },
        },
      },
    });

    return { customer, isNew: true };
  }

  /**
   * Attach another handle to an existing customer, for example after a human
   * recognises that an Instagram enquiry is an existing WhatsApp client.
   */
  async linkIdentity(
    tx: TenantTx,
    clientId: string,
    customerId: string,
    channel: ChannelType,
    externalId: string,
  ): Promise<void> {
    await tx.customerIdentity.upsert({
      where: { clientId_channel_externalId: { clientId, channel, externalId } },
      create: { clientId, customerId, channel, externalId },
      update: { customerId },
    });
  }

  /**
   * Age in whole years at a given instant, or null when we have not been told.
   *
   * Null is not zero and must never be treated as "fails the age check" or as
   * "passes it". An unknown age is a question to ask, and the qualification
   * service treats it as exactly that.
   */
  ageAt(customer: Pick<Customer, "dateOfBirth">, at: Date = new Date()): number | null {
    if (!customer.dateOfBirth) return null;
    const dob = customer.dateOfBirth;
    let age = at.getUTCFullYear() - dob.getUTCFullYear();
    const monthDelta = at.getUTCMonth() - dob.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
    return age;
  }
}
