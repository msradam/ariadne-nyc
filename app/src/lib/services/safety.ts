import type { ComfortFeature, ComfortCategory } from '../domain/poi';
import { SAFETY_CRITICAL } from '../domain/poi';

export type SafetyError =
  | { kind: 'category-mismatch'; requested: ComfortCategory; got: string[] }
  | { kind: 'closed'; name: string };

export type SafetyResult = { ok: true } | { ok: false; error: SafetyError };

// Hard check: for safety-critical categories (cooling/warming/shelter), verify
// the picked POI actually has the requested category. The LLM selects by proximity;
// this ensures it can't silently route to the wrong type of resource.
export function validateSafetyDestination(
  poi: ComfortFeature,
  requestedTypes: ComfortCategory[]
): SafetyResult {
  const critical = requestedTypes.filter((t) => SAFETY_CRITICAL.has(t));
  if (!critical.length) return { ok: true };

  const hasMatch = critical.some((t) => poi.properties.resource_types.includes(t));
  if (!hasMatch) {
    return {
      ok: false,
      error: { kind: 'category-mismatch', requested: critical[0], got: poi.properties.resource_types },
    };
  }

  if (poi.properties.is_temporarily_closed) {
    return { ok: false, error: { kind: 'closed', name: poi.properties.name } };
  }

  return { ok: true };
}

export function safetySummary(error: SafetyError): string {
  if (error.kind === 'category-mismatch') {
    return `The nearest location does not provide ${error.requested}. ` +
      `It provides: ${error.got.join(', ')}. No route was computed.`;
  }
  if (error.kind === 'closed') {
    return `${error.name} is temporarily closed. No route was computed.`;
  }
  return 'Safety check failed.';
}
