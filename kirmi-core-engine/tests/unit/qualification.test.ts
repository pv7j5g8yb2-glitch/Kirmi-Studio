import { describe, expect, it } from "vitest";
import { evaluateQualification, minimumAgeFor } from "../../src/core/qualification.js";
import { tenantFixture } from "../helpers/fixtures.js";

/**
 * The rules that decide whether a human is needed. The three valued outcome
 * matters: an unknown age is a question, never a refusal and never a pass.
 */
describe("qualification rules", () => {
  const tenant = tenantFixture();
  const verified = { ageYears: 34, licenceYears: 10, documentsVerified: true, blocked: false };

  it("passes a qualified driver", () => {
    const result = evaluateQualification(tenant, verified, "LUXURY_SUV");
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unknowns).toEqual([]);
  });

  it("fails a driver under the client's minimum age", () => {
    const result = evaluateQualification(tenant, { ...verified, ageYears: 23 }, "LUXURY_SUV");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("AGE_BELOW_MINIMUM");
  });

  it("applies a stricter per-category age gate where one is configured", () => {
    expect(minimumAgeFor(tenant, "SUPERCAR")).toBe(30);
    expect(minimumAgeFor(tenant, "LUXURY_SUV")).toBe(25);

    const driver = { ...verified, ageYears: 27 };
    expect(evaluateQualification(tenant, driver, "LUXURY_SUV").passed).toBe(true);
    expect(evaluateQualification(tenant, driver, "SUPERCAR").failures).toContain("AGE_BELOW_MINIMUM");
  });

  it("treats an unknown age as a question, not as a failure and not as a pass", () => {
    const result = evaluateQualification(tenant, { ...verified, ageYears: null }, "LUXURY_SUV");
    expect(result.failures).not.toContain("AGE_BELOW_MINIMUM");
    expect(result.unknowns).toContain("AGE");
    expect(result.passed).toBe(true); // no hard rule broken, but there is a question outstanding
  });

  it("fails a driver whose licence is too new", () => {
    const result = evaluateQualification(tenant, { ...verified, licenceYears: 0 }, "LUXURY_SUV");
    expect(result.failures).toContain("LICENCE_TENURE_BELOW_MINIMUM");
  });

  it("fails a blocked customer outright", () => {
    const result = evaluateQualification(tenant, { ...verified, blocked: true }, "LUXURY_SUV");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("CUSTOMER_BLOCKED");
  });

  it("treats unverified documents as outstanding, not as a refusal", () => {
    const result = evaluateQualification(tenant, { ...verified, documentsVerified: false }, "LUXURY_SUV");
    expect(result.unknowns).toContain("DOCUMENTS");
    expect(result.failures).toEqual([]);
  });
});
