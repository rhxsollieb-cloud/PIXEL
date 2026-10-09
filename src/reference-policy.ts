import type { JsonValue, ReadonlyJsonObject } from './contracts.js';

/** Current image-reference reader and model declarations share this exact per-file limit. */
export const MAX_IMAGE_REFERENCE_BYTES = 25 * 1024 * 1024;

export interface ReferencePolicy {
  maxReferences: number;
  referenceMaxBytes?: number;
  referenceLimits?: readonly { field: string; equals: JsonValue; maximum: number; minimum?: number }[];
}
/** Missing historical byte metadata is unknown; the provider's controlled reader must still verify real bytes. */
export function referenceExceedsByteLimit(declaration: Pick<ReferencePolicy, 'referenceMaxBytes'>, byteLength: unknown): boolean {
  return declaration.referenceMaxBytes !== undefined && typeof byteLength === 'number' && byteLength > declaration.referenceMaxBytes;
}
/** One declarative policy for capability hints, reference placement and SDK preparation. */
export function referenceLimit(declaration: ReferencePolicy, params: ReadonlyJsonObject): number {
  return (declaration.referenceLimits ?? []).reduce((maximum, rule) =>
    JSON.stringify(params[rule.field]) === JSON.stringify(rule.equals) ? Math.min(maximum, rule.maximum) : maximum, declaration.maxReferences);
}
export function referenceMinimum(declaration: Pick<ReferencePolicy, 'referenceLimits'>, params: ReadonlyJsonObject): number {
  return (declaration.referenceLimits ?? []).reduce((minimum, rule) =>
    JSON.stringify(params[rule.field]) === JSON.stringify(rule.equals) ? Math.max(minimum, rule.minimum ?? 0) : minimum, 0);
}
