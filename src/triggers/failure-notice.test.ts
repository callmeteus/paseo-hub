import assert from "node:assert/strict";
import { it } from "vitest";
import { agentFailureNotice, organizationBillingUrl } from "./failure-notice.js";
import { createMemoryDatabase } from "../db/memory.js";

it("links to the organization's billing route", async () => {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "member-1",
        role: "owner",
      },
    ],
  });
  assert.equal(
    await organizationBillingUrl(database, "https://hub.paseo.sh", "org-1"),
    "https://hub.paseo.sh/o/acme/settings/billing",
  );
});

it("uses the UTC month and next first for the execution limit", async () => {
  const reason = JSON.stringify({
    error: "entitlement_denied",
    entitlement: "executions.monthly",
    kind: "meter",
    limit: 50,
    current: 236,
  });
  const notice = await agentFailureNotice(
    reason,
    "org-1",
    async () => "https://hub.paseo.sh/o/acme/settings/billing",
    { now: new Date("2026-12-31T23:30:00Z") },
  );
  assert.equal(
    notice,
    "This org has used its 50 free runs for December. Runs reset on January 1, or upgrade to Pro under Billing: https://hub.paseo.sh/o/acme/settings/billing",
  );
});

it("keeps other entitlement denials on the existing error path", async () => {
  const reason = JSON.stringify({
    error: "entitlement_denied",
    entitlement: "seats",
    kind: "cap",
    limit: 2,
    current: 2,
  });
  assert.equal(
    await agentFailureNotice(reason, "org-1", async () => {
      throw new Error("should not need a billing URL");
    }),
    "I hit a problem and stopped before finishing. Mention me again to retry.",
  );
});

it("writes the notice in English when the trigger sets no locale", async () => {
  const expected = {
    whole_run_timeout: "I ran out of time and stopped. The case is still open in this thread.",
    idle_timeout: "I stopped after waiting too long without a reply. Mention me again to continue.",
    launch_failed: "I could not start because the machine that runs me is offline.",
    boom: "I hit a problem and stopped before finishing. Mention me again to retry.",
  };
  for (const [reason, sentence] of Object.entries(expected)) {
    assert.equal(
      await agentFailureNotice(reason, "org-1", async () => {
        throw new Error("should not need a billing URL");
      }),
      sentence,
    );
  }
});

it("explains a deadline the agent did not beat", async () => {
  const timeoutNotice = "I ran out of time and stopped. The case is still open in this thread.";
  for (const reason of ["whole_run_timeout", "step_hard_timeout", "timeout"]) {
    assert.equal(
      await agentFailureNotice(reason, "org-1", async () => {
        throw new Error("should not need a billing URL");
      }),
      timeoutNotice,
    );
  }
});

it("explains an idle wait that ended the run", async () => {
  const idleNotice =
    "I stopped after waiting too long without a reply. Mention me again to continue.";
  for (const reason of ["idle_timeout", "step_idle_timeout"]) {
    assert.equal(
      await agentFailureNotice(reason, "org-1", async () => {
        throw new Error("should not need a billing URL");
      }),
      idleNotice,
    );
  }
});

it("explains a machine that never came up", async () => {
  const machineNotice = "I could not start because the machine that runs me is offline.";
  for (const reason of ["launch_failed", "daemon_disconnected"]) {
    assert.equal(
      await agentFailureNotice(reason, "org-1", async () => {
        throw new Error("should not need a billing URL");
      }),
      machineNotice,
    );
  }
});

it("writes the notice in the trigger locale", async () => {
  const expected = {
    whole_run_timeout:
      "Não terminei a tempo e parei por aqui. O caso continua aberto nesta thread.",
    idle_timeout: "Fiquei sem resposta por muito tempo e parei. Me marque de novo para continuar.",
    launch_failed:
      "Não consegui começar agora porque a máquina que me roda está fora. Avise quem cuida do Hub.",
    boom: "Tive um problema e parei antes de terminar. Me marque de novo para tentar outra vez.",
  };
  for (const [reason, sentence] of Object.entries(expected)) {
    assert.equal(
      await agentFailureNotice(
        reason,
        "org-1",
        async () => {
          throw new Error("should not need a billing URL");
        },
        { locale: "pt-BR" },
      ),
      sentence,
    );
  }
});

it("names no person in the product text", async () => {
  for (const locale of [undefined, "en", "pt-BR"]) {
    const notice = await agentFailureNotice(
      "launch_failed",
      "org-1",
      async () => {
        throw new Error("should not need a billing URL");
      },
      { locale },
    );
    assert.equal(notice.includes("Gio"), false, `named a person for ${String(locale)}`);
  }
});

it("never leaks the raw failure reason into the notice", async () => {
  const reasons = [
    "whole_run_timeout",
    "idle_timeout",
    "timeout",
    "step_idle_timeout",
    "step_hard_timeout",
    "launch_failed",
    "daemon_disconnected",
    "session not found",
    "boom",
    "SIGKILL after 90m",
  ];
  for (const locale of [undefined, "en", "pt-BR"]) {
    for (const reason of reasons) {
      const notice = await agentFailureNotice(
        reason,
        "org-1",
        async () => {
          throw new Error("should not need a billing URL");
        },
        { locale },
      );
      assert.equal(notice.includes(reason), false, `leaked: ${reason}`);
      assert.equal(notice.startsWith("Paseo agent failed:"), false);
    }
  }
});
