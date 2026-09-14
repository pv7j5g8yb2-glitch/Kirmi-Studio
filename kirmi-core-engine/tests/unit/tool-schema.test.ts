import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  CHECK_AVAILABILITY,
  CREATE_HOLD,
  SEARCH_VEHICLES,
  SEND_VEHICLE_PHOTOS,
  SYSTEM_GUARDRAILS,
} from "../../src/orchestrator/tools.schema.js";

/**
 * These tests guard the central architectural claim of the engine: the model
 * parses, the code decides.
 *
 * They are structural rather than behavioural on purpose. Prompt instructions
 * can be argued with by a sufficiently confident model; a schema that has no
 * field for a price gives it nowhere to put one. If somebody later adds a
 * `totalPrice` argument to make something convenient, this test fails and the
 * grounding guarantee is defended by CI rather than by memory.
 */
describe("agent tool schemas", () => {
  it("exposes exactly the four intended tools", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "CHECK_AVAILABILITY",
      "CREATE_HOLD",
      "SEARCH_VEHICLES",
      "SEND_VEHICLE_PHOTOS",
    ]);
  });

  it("gives the model no field through which to supply a photograph URL", () => {
    // The same boundary as prices. Photographs come from the vehicle row; if a
    // url or attachment field ever appears here, the model can send a customer
    // a picture of a car that is not in the fleet.
    for (const field of Object.keys(SEND_VEHICLE_PHOTOS.input_schema.properties)) {
      expect(/url|link|image|attachment|photoUrl/i.test(field), `SEND_VEHICLE_PHOTOS.${field}`).toBe(false);
    }
    expect(SEND_VEHICLE_PHOTOS.input_schema.required).toEqual(["vehicleId"]);
  });

  it("gives the model no field through which to supply a price", () => {
    const forbidden = /price|total|amount|cost|fee|vat|rate$|discount/i;

    for (const tool of AGENT_TOOLS) {
      for (const field of Object.keys(tool.input_schema.properties)) {
        // maxDailyRateMinor is a customer's stated budget filter, an input to a
        // search, never a figure that reaches a quote.
        if (field === "maxDailyRateMinor") continue;
        expect(forbidden.test(field), `${tool.name}.${field} looks like a price the model could invent`).toBe(false);
      }
    }
  });

  it("gives the model no field through which to assert availability", () => {
    for (const tool of AGENT_TOOLS) {
      for (const field of Object.keys(tool.input_schema.properties)) {
        expect(/available|inStock|isFree/i.test(field), `${tool.name}.${field}`).toBe(false);
      }
    }
  });

  it("rejects unknown arguments on every tool", () => {
    // Without this, a model can attach extra fields and a future handler might
    // start reading them.
    for (const tool of AGENT_TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  it("requires an explicit customer confirmation before a car can be held", () => {
    expect(CREATE_HOLD.input_schema.required).toContain("confirmedByCustomer");
  });

  it("requires both ends of the window before it will price anything", () => {
    expect(CHECK_AVAILABILITY.input_schema.required).toEqual(expect.arrayContaining(["vehicleId", "startAt", "endAt"]));
  });

  it("lets a search be completely unconstrained, since a customer may not have narrowed anything", () => {
    expect(SEARCH_VEHICLES.input_schema.required).toEqual([]);
  });

  it("states the prohibitions the model must not talk itself out of", () => {
    expect(SYSTEM_GUARDRAILS).toMatch(/Never calculate a price/);
    expect(SYSTEM_GUARDRAILS).toMatch(/Never confirm a booking/);
    expect(SYSTEM_GUARDRAILS).toMatch(/Never describe a vehicle that SEARCH_VEHICLES did not return/);
  });
});
