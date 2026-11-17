import { decodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { Database } from "../db/types.js";
import { message, type MessageKey } from "../i18n/messages.js";

export function isExecutionLimitDenial(reason: string): boolean {
  const denial = decodeEntitlementDenialFailureReason(reason);
  return (
    denial?.entitlement === "executions.monthly" && denial.kind === "meter" && denial.limit !== null
  );
}

export function missingBillingUrl(): Promise<string> {
  throw new Error("billing URL unavailable");
}

const TIMEOUT_FAILURE_REASONS = new Set(["whole_run_timeout", "step_hard_timeout", "timeout"]);
const IDLE_FAILURE_REASONS = new Set(["idle_timeout", "step_idle_timeout"]);
const MACHINE_FAILURE_REASONS = new Set(["launch_failed", "daemon_disconnected"]);

const TIMEOUT_NOTICE: MessageKey = "failure.timeout";
const IDLE_NOTICE: MessageKey = "failure.idle";
const MACHINE_NOTICE: MessageKey = "failure.machine";
const UNKNOWN_NOTICE: MessageKey = "failure.unknown";

/**
 * The key of the sentence a person reads when an agent run did not finish.
 *
 * The raw reason is an internal deadline or lifecycle name. It never reaches the
 * conversation, so an unrecognized reason falls back to the generic sentence.
 *
 * @param reason - Failure reason recorded on the run
 * @returns The catalog key of the notice to post
 */
function agentFailureMessageKey(reason: string): MessageKey {
  if (TIMEOUT_FAILURE_REASONS.has(reason)) return TIMEOUT_NOTICE;
  if (IDLE_FAILURE_REASONS.has(reason)) return IDLE_NOTICE;
  if (MACHINE_FAILURE_REASONS.has(reason)) return MACHINE_NOTICE;
  return UNKNOWN_NOTICE;
}

/**
 * The notice a person reads when an agent run did not finish.
 *
 * @param reason - Failure reason recorded on the run
 * @param organizationId - Organization that owns the run
 * @param billingUrlForOrganization - Resolves the billing page for the denial notice
 * @param options - Clock for the month and reset day, and the trigger locale
 * @returns The notice to post
 */
export async function agentFailureNotice(
  reason: string,
  organizationId: string,
  billingUrlForOrganization: (organizationId: string) => Promise<string>,
  options: { now?: Date; locale?: string | undefined } = {},
): Promise<string> {
  if (!isExecutionLimitDenial(reason))
    return message(options.locale, agentFailureMessageKey(reason));
  const denial = decodeEntitlementDenialFailureReason(reason)!;
  const now = options.now ?? new Date();
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(now);
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetDay = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(reset);
  const billingUrl = await billingUrlForOrganization(organizationId);
  return `This org has used its ${denial.limit} free runs for ${month}. Runs reset on ${resetDay}, or upgrade to Pro under Billing: ${billingUrl}`;
}

export async function organizationBillingUrl(
  database: Database,
  publicBaseUrl: string,
  organizationId: string,
): Promise<string> {
  const slug = await database.findOrganizationSlugById(organizationId);
  if (slug === undefined) throw new Error(`organization not found: ${organizationId}`);
  return new URL(`/o/${encodeURIComponent(slug)}/settings/billing`, publicBaseUrl).toString();
}
