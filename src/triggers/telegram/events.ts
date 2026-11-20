import { z } from "zod";

export const TelegramChatSchema = z
  .object({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
    title: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

export const TelegramFromSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    username: z.string().optional(),
  })
  .passthrough();

export const TelegramEntitySchema = z
  .object({
    type: z.string(),
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * The photo sizes we care about. Telegram sends an array of sizes; the last one is the largest.
 */
export const TelegramPhotoSizeSchema = z
  .object({ file_id: z.string(), width: z.number().int(), height: z.number().int() })
  .passthrough();

export const TelegramAttachmentSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number().int().nonnegative(),
});

export const TelegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    from: TelegramFromSchema.optional(),
    chat: TelegramChatSchema,
    date: z.number().int(),
    text: z.string().optional(),
    caption: z.string().optional(),
    entities: z.array(TelegramEntitySchema).optional(),
    caption_entities: z.array(TelegramEntitySchema).optional(),
    reply_to_message: z.unknown().optional(),
    photo: z.array(TelegramPhotoSizeSchema).optional(),
    document: z
      .object({
        file_id: z.string(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
    video: z
      .object({
        file_id: z.string(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const TelegramCallbackQuerySchema = z
  .object({
    id: z.string(),
    from: TelegramFromSchema,
    message: TelegramMessageSchema.optional(),
    data: z.string().optional(),
  })
  .passthrough();

export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: TelegramMessageSchema.optional(),
    edited_message: TelegramMessageSchema.optional(),
    callback_query: TelegramCallbackQuerySchema.optional(),
  })
  .passthrough();

export type TelegramChat = z.infer<typeof TelegramChatSchema>;
export type TelegramFrom = z.infer<typeof TelegramFromSchema>;
export type TelegramEntity = z.infer<typeof TelegramEntitySchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;
export type TelegramAttachment = z.infer<typeof TelegramAttachmentSchema>;

/** One message promoted to a trigger event, independent of the raw update envelope. */
export const NormalizedTelegramMessageEventSchema = z.object({
  type: z.enum(["message", "mention"]),
  id: z.string(),
  chatId: z.string(),
  chatType: z.enum(["private", "group", "supergroup", "channel"]),
  messageId: z.number().int(),
  content: z.string(),
  author: z.object({
    id: z.string(),
    username: z.string().optional(),
    firstName: z.string(),
    isBot: z.boolean(),
  }),
  mentionedBot: z.boolean(),
  createdAt: z.string(),
  attachments: z.array(TelegramAttachmentSchema),
});

export type NormalizedTelegramMessageEvent = z.infer<typeof NormalizedTelegramMessageEventSchema>;
