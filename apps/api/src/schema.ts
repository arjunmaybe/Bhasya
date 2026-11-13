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
