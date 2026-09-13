import type { TenantProfile } from "./types.js";

/**
 * ===========================================================================
 * QUALIFICATION RULES
 * ===========================================================================
 *
 * Whether a customer may rent a given car. Pure, deterministic, and explicitly
 * not a judgement call the language model is allowed to make.
 *
 * The distinction that matters here is three valued. A rule can PASS, FAIL, or
 * be UNKNOWN because nobody has asked yet. Collapsing unknown into either of
 * the other two is how systems either turn away qualified customers or promise
 * a supercar to a 22 year old. Unknown means ask; fail means fetch a human.
 */

export type QualificationCode =
  | "AGE_BELOW_MINIMUM"
  | "LICENCE_TENURE_BELOW_MINIMUM"
  | "DOCUMENT_CHECK_FAILED"
  | "CUSTOMER_BLOCKED";

export interface QualificationSubject {
  ageYears: number | null;
  licenceYears: number | null;
  documentsVerified: boolean;
  blocked: boolean;
}

export interface QualificationResult {
  /** Every hard rule satisfied. Safe to proceed to a hold. */
  passed: boolean;
  /** Rules that definitively failed. Each one is an escalation reason. */
  failures: QualificationCode[];
  /** Facts we simply do not have yet. Each one is a question to ask. */
  unknowns: Array<"AGE" | "LICENCE_TENURE" | "DOCUMENTS">;
  /** The age gate that was applied, so a reply can quote the actual number. */
  minimumAgeApplied: number;
}

/**
 * The age gate for a category, falling back to the client's general minimum.
 * Supercars commonly carry a higher bar than saloons, so this is per category
 * configuration rather than a constant.
 */
export function minimumAgeFor(tenant: TenantProfile, categoryCode: string | null): number {
  const override = categoryCode ? tenant.qualification.categoryAgeOverrides[categoryCode] : undefined;
  return override ?? tenant.qualification.minimumDriverAge;
}

export function evaluateQualification(
  tenant: TenantProfile,
  subject: QualificationSubject,
  categoryCode: string | null,
): QualificationResult {
  const failures: QualificationCode[] = [];
  const unknowns: QualificationResult["unknowns"] = [];
  const minimumAgeApplied = minimumAgeFor(tenant, categoryCode);

  if (subject.blocked) failures.push("CUSTOMER_BLOCKED");

  if (subject.ageYears === null) unknowns.push("AGE");
  else if (subject.ageYears < minimumAgeApplied) failures.push("AGE_BELOW_MINIMUM");

  const minimumLicenceYears = tenant.qualification.minimumLicenceYears;
  if (minimumLicenceYears > 0) {
    if (subject.licenceYears === null) unknowns.push("LICENCE_TENURE");
    else if (subject.licenceYears < minimumLicenceYears) failures.push("LICENCE_TENURE_BELOW_MINIMUM");
  }

  // Documents are checked before handover rather than before a quote, so an
  // unverified customer is an unknown at this stage, never a failure.
  if (tenant.qualification.requiredDocuments.length > 0 && !subject.documentsVerified) {
    unknowns.push("DOCUMENTS");
  }

  return {
    passed: failures.length === 0,
    failures,
    unknowns,
    minimumAgeApplied,
  };
}
