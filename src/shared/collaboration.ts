import { z } from "zod";
import { collaborationMessageDraftSchema } from "./execution";

export const collaborationMessageSchema = collaborationMessageDraftSchema.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  senderNodeId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;
