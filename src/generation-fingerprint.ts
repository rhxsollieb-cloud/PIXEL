import { createHash } from 'node:crypto';
import type { DeepReadonly, GenerationRequest } from './contracts.js';

export function generationInputFingerprint(request: DeepReadonly<GenerationRequest>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  return createHash('sha256').update(canonical({
    providerId: request.providerId, providerVersion: request.providerVersion, modelId: request.modelId,
    params: request.params, settings: request.settings, context: request.context,
    durationMs: request.durationMs, references: request.references.map(reference => {
      const metadata = { ...reference.metadata }; delete metadata.storage;
      return { ...reference, metadata };
    }),
  })).digest('hex');
}
