import { z } from "zod";

export const ContinuationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("conversation"),
      // Default keeps today's behaviour: restoring an archived agent carries
      // its conversation forward. false starts a new agent instead.
      restoreArchived: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("key"),
      key: z
        .string()
        .min(1)
        .max(512)
        .refine((key) => key.trim().length > 0, "Continuation key must not be blank"),
      restoreArchived: z.boolean().optional(),
    })
    .strict(),
  z.object({ mode: z.literal("new") }).strict(),
]);
export type Continuation = z.infer<typeof ContinuationSchema>;
export interface Conversation {
  key: string;
  label: string;
  url?: string;
}

export function continuationKey(
  policy: Continuation,
  conversation: Conversation | null,
  render: (template: string) => unknown,
): string | null {
  if (policy.mode === "new") return null;
  if (policy.mode === "conversation") return conversation?.key ?? null;
  const key = render(policy.key);
  if (typeof key !== "string" || key.trim().length === 0 || key.length > 512) {
    throw new Error(
      "Continuation key must resolve to a non-empty string of at most 512 characters",
    );
  }
  return `custom:${key}`;
}
