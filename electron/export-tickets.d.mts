import type { AssetData, DeepReadonly } from '../src/contracts.js';

export interface ExportWorkbench {
  mediaAsset(assetId: string): Promise<AssetData>;
  artifacts: { resolvePath(asset: DeepReadonly<AssetData>): Promise<string> };
}

export class ExportTickets {
  constructor(workbench: ExportWorkbench, currentAsset: (assetId: string) => DeepReadonly<AssetData> | undefined);
  prepare(assetId: string, senderId: number): Promise<{ ticket: string }>;
  take(ticket: string, senderId: number): string | undefined;
  /** Permanently revokes this project session, including preparations still awaiting I/O. */
  clear(): void;
}
