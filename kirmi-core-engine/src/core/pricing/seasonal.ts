import { BASIS_POINTS_SCALE } from "../../config/constants.js";
import type { SeasonalModifier } from "../../config/tenant-schema.js";
import { isoDateInZone } from "../time.js";

export interface SeasonalMatch {
  code: string | null;
  basisPoints: number;
}

/** No modifier in force: identity, stated explicitly so it appears in the trace. */
export const NO_SEASONAL_MODIFIER: SeasonalMatch = { code: null, basisPoints: BASIS_POINTS_SCALE };

/**
 * Which seasonal modifier applies to a rental.
 *
 * Matched on the START date, in the client's own timezone, because that is how
 * a rental desk quotes: a hire that begins on 28 December is a New Year hire
 * even though it ends in January.
 *
 * First match in configuration order wins. Overlapping windows are a
 * configuration mistake rather than something to average or compound, and a
 * deterministic "first wins" is at least reproducible and explainable to the
 * client when they ask why a quote came out the way it did.
 */
export function resolveSeasonalModifier(
  modifiers: readonly SeasonalModifier[],
  startAt: Date,
  timezone: string,
  categoryCode: string | null,
): SeasonalMatch {
  const startDate = isoDateInZone(startAt, timezone);

  for (const modifier of modifiers) {
    const inWindow = startDate >= modifier.startsOn && startDate <= modifier.endsOn;
    if (!inWindow) continue;

    const scoped = modifier.categoryCodes.length === 0 || (categoryCode !== null && modifier.categoryCodes.includes(categoryCode));
    if (!scoped) continue;

    return { code: modifier.code, basisPoints: modifier.multiplierBasisPoints };
  }

  return NO_SEASONAL_MODIFIER;
}
