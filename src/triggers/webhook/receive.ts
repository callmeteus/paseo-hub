import { timingSafeEqual } from "node:crypto";
import { parseTriggerDocument } from "../configuration/index.js";
import type { Database } from "../../db/types.js";
import type { ManualTriggerInput } from "../manual/schema.js";

export type AutomationWebhookResult =
  | { status: "accepted" }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "unavailable" }
  | { status: "rejected" };

export async function receiveAutomationWebhook(options: {
  database: Pick<Database, "listEnabledTriggerDocuments">;
  dispatch: (input: ManualTriggerInput) => Promise<unknown>;
  secret: string;
  body: unknown;
}): Promise<AutomationWebhookResult> {
  const documents = await options.database.listEnabledTriggerDocuments();
  const matches = documents.flatMap((document) => {
    const triggerName = webhookTriggerName(document.yaml, options.secret);
    return triggerName === undefined ? [] : [{ document, triggerName }];
  });
  const [match] = matches;
  if (match === undefined) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous" };

  try {
    await options.dispatch({
      organizationId: match.document.organizationId,
      projectId: match.document.projectId,
      source: "webhook.received",
      deliveryId: `webhook-${crypto.randomUUID()}`,
      receivedAt: new Date(),
      payload: { trigger: match.triggerName, body: options.body },
    });
  } catch {
    return { status: "rejected" };
  }
  return { status: "accepted" };
}

function webhookTriggerName(yaml: string, secret: string): string | undefined {
  try {
    const document = parseTriggerDocument(yaml);
    const expected = document.on["webhook.received"]?.filters?.webhook_secret;
    if (expected === undefined || !secretsMatch(expected, secret)) return undefined;
    return document.name;
  } catch {
    return undefined;
  }
}

function secretsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
