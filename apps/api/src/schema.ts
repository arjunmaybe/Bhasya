import { z } from 'zod';

export const IngestSchema = z.object({ url: z.string().min(8).max(2000) });
export const ResolveAnchorSchema = z.object({
  documentVersionId: z.string().uuid(),
  selectedText: z.string().min(1).max(2000),
  passageId: z.string().uuid().optional(),
  cssHint: z.string().max(500).optional(),
});
export const CreateHighlightSchema = z.object({ anchorId: z.string().uuid(), color: z.string().max(32).optional() });
export const CreateThreadSchema = z.object({ anchorId: z.string().uuid(), title: z.string().max(200).optional() });
export const ExplainSchema = z.object({
  anchorId: z.string().uuid(),
  question: z.string().max(2000).optional(),
  threadId: z.string().uuid().optional(),
});
export const PostMessageSchema = z.object({ content: z.string().min(1).max(4000) });
