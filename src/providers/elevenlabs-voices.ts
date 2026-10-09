import { createHash } from 'node:crypto';
import { ElevenLabsClient, type ElevenLabs } from '@elevenlabs/elevenlabs-js';
import { createSdkFetch } from '../generation.js';
import { voiceSummarySchema, type VoiceSummary } from '../voice-contracts.js';
import {
  sanitizeVoiceError, voiceError, type ProviderVoiceCloneInput, type ProviderVoicePage,
  type ProviderVoiceQuery, type VoiceProvider,
} from '../voices.js';

export interface ElevenLabsVoiceProviderOptions {
  apiKey: string;
  /** 注入 client 的 fetch/日志生命周期由调用方负责；禁止 SDK 自动重试写操作。 */
  client?: ElevenLabsClient;
  timeoutMs?: number;
}
/** 官方 SDK 仅在后端；列表不暴露 samples、sharing 或其他账号资料。 */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly accountScope: string;
  private readonly client: ElevenLabsClient;
  private readonly timeoutMs: number;
  constructor(options: ElevenLabsVoiceProviderOptions) {
    if (!options.apiKey.trim()) throw voiceError('AUTHENTICATION');
    this.accountScope = createHash('sha256').update('elevenlabs\0' + options.apiKey).digest('hex');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw voiceError('INVALID_INPUT');
    this.client = options.client ?? new ElevenLabsClient({ apiKey: options.apiKey, fetch: createSdkFetch(), logging: { silent: true } });
  }
  async query(input: ProviderVoiceQuery, signal: AbortSignal): Promise<ProviderVoicePage> {
    try {
      if (signal.aborted) throw voiceError('CANCELED');
      const page = await this.client.voices.search({
        voiceType: input.category === 'default' ? 'default' : 'personal', pageSize: input.limit,
        includeTotalCount: false, sort: 'name', sortDirection: 'asc',
        ...(input.cursor ? { nextPageToken: input.cursor } : {}), ...(input.search ? { search: input.search } : {}),
      }, { abortSignal: signal, timeoutInSeconds: this.timeoutMs / 1000, maxRetries: 0 });
      if (signal.aborted) throw voiceError('CANCELED');
      if (page.hasMore && !page.nextPageToken) throw voiceError('INVALID_OUTPUT');
      // 默认声音的供应商 category 可为 professional/high_quality；按 voice_type 分类。
      const voices = input.category === 'default' ? page.voices : page.voices.filter(voice =>
        (voice.category === 'cloned' || voice.category === 'professional') && voice.isOwner !== false);
      return { items: voices.map(voice => summarize(voice, input.category)),
        ...(page.hasMore && page.nextPageToken ? { nextCursor: page.nextPageToken } : {}) };
    } catch (error) { throw sanitizeVoiceError(error); }
  }
  async clone(input: ProviderVoiceCloneInput, signal: AbortSignal): Promise<VoiceSummary> {
    try {
      if (signal.aborted) throw voiceError('CANCELED');
      const response = await this.client.voices.ivc.create({ name: input.name, files: [{
        data: input.bytes, filename: input.fileName, contentType: input.mimeType, contentLength: input.bytes.byteLength,
      }], removeBackgroundNoise: false }, { abortSignal: signal, timeoutInSeconds: this.timeoutMs / 1000, maxRetries: 0 });
      if (signal.aborted) throw voiceError('CANCELED');
      const result = voiceSummarySchema.safeParse({ voiceId: response.voiceId, name: input.name, category: 'cloned',
        status: response.requiresVerification ? 'verificationRequired' : 'ready',
        ...(response.requiresVerification ? { reason: '请到 ElevenLabs 完成声纹验证后再使用' } : {}) });
      if (!result.success || typeof response.requiresVerification !== 'boolean') throw voiceError('INVALID_OUTPUT');
      return result.data;
    } catch (error) { throw sanitizeVoiceError(error); }
  }
}
function summarize(voice: ElevenLabs.Voice, category: VoiceSummary['category']): VoiceSummary {
  let status: VoiceSummary['status'] = 'ready';
  let reason: string | undefined;
  if (voice.safetyControl === 'BAN' || voice.safetyControl === 'ENTERPRISE_BAN') {
    status = 'unavailable'; reason = '该声纹在 ElevenLabs 暂不可用';
  } else if (voice.voiceVerification?.requiresVerification && !voice.voiceVerification.isVerified
    || voice.safetyControl === 'CAPTCHA' || voice.safetyControl === 'ENTERPRISE_CAPTCHA') {
    status = 'verificationRequired'; reason = '请到 ElevenLabs 完成声纹验证后再使用';
  } else if (voice.category === 'professional') {
    // 仅依赖供应商明确给出的准备状态；未提供 verification/state 不等于受限。
    const states = Object.values(voice.fineTuning?.state ?? {});
    const relevant = voice.fineTuning?.state?.eleven_v4;
    let pending: string | undefined;
    if (relevant && relevant !== 'fine_tuned') pending = String(relevant);
    else if (states.length > 0 && states.every(state => state !== 'fine_tuned')) pending = String(states[0]);
    if (pending === 'not_verified') {
      status = 'verificationRequired'; reason = '请到 ElevenLabs 完成声纹验证后再使用';
    } else if (pending) {
      status = 'unavailable'; reason = pending === 'failed' ? '该声纹在 ElevenLabs 尚未准备完成，请检查账号中的处理状态'
        : '该声纹仍在 ElevenLabs 准备中，完成后请刷新列表';
    }
  }
  const result = voiceSummarySchema.safeParse({ voiceId: voice.voiceId, name: voice.name?.trim() || '未命名声纹', category, status,
    ...(reason ? { reason } : {}) });
  if (!result.success) throw voiceError('INVALID_OUTPUT');
  return result.data;
}
