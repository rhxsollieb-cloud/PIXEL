import { z } from 'zod';

/** 声纹是账号资源；这些契约可由浏览器导入，不包含 SDK、密钥或文件系统路径。 */
export const voiceCategorySchema = z.enum(['default', 'cloned']);
export const voiceStatusSchema = z.enum(['ready', 'verificationRequired', 'unavailable']);
export const voiceSummarySchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  category: voiceCategorySchema,
  status: voiceStatusSchema,
  reason: z.string().max(300).optional(),
}).strict();
export type VoiceSummary = z.infer<typeof voiceSummarySchema>;
export const voiceQuerySchema = z.object({
  category: voiceCategorySchema,
  limit: z.number().int().min(1).max(20).default(5),
  cursor: z.string().min(1).max(2048).optional(),
  search: z.string().trim().max(100).optional(),
}).strict();
export type VoiceQuery = z.input<typeof voiceQuerySchema>;
export const voicePageSchema = z.object({
  items: z.array(voiceSummarySchema).max(20),
  nextCursor: z.string().min(1).max(2048).optional(),
}).strict();
export type VoicePage = z.infer<typeof voicePageSchema>;

export const MAX_VOICE_SAMPLE_BYTES = 25 * 1024 * 1024;
const resourceIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const voiceCloneMetadataSchema = z.object({
  requestId: resourceIdSchema,
  projectId: resourceIdSchema,
  timelineId: resourceIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(100),
  mimeType: z.enum(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']),
  fileName: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+\.(?:mp3|wav)$/i),
}).strict().superRefine((input, context) => {
  if ((input.mimeType === 'audio/mpeg') !== /\.mp3$/i.test(input.fileName)) {
    context.addIssue({ code: 'custom', path: ['fileName'], message: '文件名与音频类型不一致' });
  }
});
export const voiceCloneInputSchema = voiceCloneMetadataSchema.extend({
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= MAX_VOICE_SAMPLE_BYTES,
    '请上传不超过 25 MiB 的 MP3 或 WAV 音频'),
});
// HTTP/宿主尚未验证的 MIME 保持 string；运行时 schema 执行白名单与文件名一致性检查。
export type VoiceCloneInput = Omit<z.infer<typeof voiceCloneInputSchema>, 'bytes' | 'mimeType'> & {
  bytes: Uint8Array;
  mimeType: string;
};
/** 外部账号资源命令，不属于 ProjectDocument 编辑或 GenerationJob。 */
export const voiceCloneCommandSchema = z.object({
  type: z.literal('voice.clone'),
  input: voiceCloneInputSchema,
}).strict();
export type VoiceCloneCommand = z.infer<typeof voiceCloneCommandSchema>;
export const voiceCloneResultSchema = z.object({
  requestId: resourceIdSchema,
  voice: voiceSummarySchema,
}).strict();
export type VoiceCloneResult = z.infer<typeof voiceCloneResultSchema>;
export type VoiceErrorCode = 'INVALID_INPUT' | 'AUTHENTICATION' | 'FORBIDDEN' | 'RATE_LIMITED'
  | 'UPSTREAM' | 'TIMEOUT' | 'CANCELED' | 'OUTCOME_UNKNOWN' | 'REQUEST_ID_REUSED'
  | 'CLOSED' | 'INVALID_OUTPUT';
