import { z } from 'zod';

export const IngestSchema = z.object({ url: z.string().min(8).max(2000) });
export const ResolveAnchorSchema = z.object({
  documentVersionId: z.guid(),
  selectedText: z.string().min(1).max(2000),
  passageId: z.guid().optional(),
  cssHint: z.string().max(500).optional(),
});
export const CreateHighlightSchema = z.object({ anchorId: z.guid(), color: z.string().max(32).optional() });
export const CreateThreadSchema = z.object({ anchorId: z.guid(), title: z.string().max(200).optional() });
export const ExplainSchema = z.object({
  anchorId: z.guid(),
  question: z.string().max(2000).optional(),
  threadId: z.guid().optional(),
});
export const PostMessageSchema = z.object({ content: z.string().min(1).max(4000) });

/**
 * Reader progress save payload. Strict: unknown fields are rejected so the
 * client can never smuggle a user/workspace selector. The passage/version
 * match and the authenticated user are resolved server-side, never from here.
 *
 * `instanceId` + `sequence` are the per-reader-instance ordering guard: the
 * server ignores a write from the same instance whose sequence is older than
 * the stored one, so out-of-order requests cannot regress the position.
 */
export const ReadingProgressSchema = z.strictObject({
  passageId: z.guid(),
  offsetRatio: z.number().min(0).max(1),
  instanceId: z.guid(),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
