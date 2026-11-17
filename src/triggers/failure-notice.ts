import { decodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { Database } from "../db/types.js";

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

const TIMEOUT_NOTICE =
  "Não terminei a tempo e parei por aqui. O caso continua aberto nesta thread.";
const IDLE_NOTICE =
  "Fiquei sem resposta por muito tempo e parei. Me marque de novo para continuar.";
const MACHINE_NOTICE =
  "Não consegui começar agora porque a máquina que me roda está fora. Avise a Gio.";
const UNKNOWN_NOTICE =
  "Tive um problema e parei antes de terminar. Me marque de novo para tentar outra vez.";

/**
 * The sentence a person reads when an agent run did not finish.
 *
 * The raw reason is an internal deadline or lifecycle name. It never reaches the
 * conversation, so an unrecognized reason falls back to the generic sentence.
 *
 * @param reason - Failure reason recorded on the run
 * @returns The notice to post, in Portuguese
 */
function agentFailureSentence(reason: string): string {
  if (TIMEOUT_FAILURE_REASONS.has(reason)) return TIMEOUT_NOTICE;
  if (IDLE_FAILURE_REASONS.has(reason)) return IDLE_NOTICE;
  if (MACHINE_FAILURE_REASONS.has(reason)) return MACHINE_NOTICE;
  return UNKNOWN_NOTICE;
}

export async function agentFailureNotice(
  reason: string,
  organizationId: string,
  billingUrlForOrganization: (organizationId: string) => Promise<string>,
  now = new Date(),
): Promise<string> {
  if (!isExecutionLimitDenial(reason)) return agentFailureSentence(reason);
  const denial = decodeEntitlementDenialFailureReason(reason)!;
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
