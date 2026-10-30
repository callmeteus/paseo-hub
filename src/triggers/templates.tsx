/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-object-as-prop -- each template link carries its own search */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express a template query on a dynamic path */
import { Link } from "@tanstack/react-router";
import {
  AUTOMATION_TEMPLATE_IDS,
  isAutomationTemplateId,
  type AutomationTemplateId,
} from "./configuration/editor.js";

const COPY = {
  "slack-mention": {
    title: "Slack mention",
    description: "When someone mentions the bot.",
  },
  "slack-message": {
    title: "New channel message",
    description: "When a message is posted in a channel.",
  },
  "github-pull-request": {
    title: "GitHub pull request opened",
    description: "When a pull request is opened.",
  },
  schedule: {
    title: "Schedule",
    description: "Run on a schedule.",
  },
  webhook: {
    title: "Webhook",
    description: "Run when a request arrives.",
  },
} as const satisfies Record<AutomationTemplateId, { title: string; description: string }>;

export function AutomationTemplates({ to }: { to: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {AUTOMATION_TEMPLATE_IDS.map((id) => (
        <Link
          key={id}
          to={to as never}
          search={{ template: id } as never}
          className="rounded-xl border bg-card p-4 text-left hover:bg-muted"
        >
          <span className="block font-medium">{COPY[id].title}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{COPY[id].description}</span>
        </Link>
      ))}
    </div>
  );
}

export function automationTemplateFromLocation(): AutomationTemplateId | null {
  if (typeof window === "undefined") return null;
  const template = new URLSearchParams(window.location.search).get("template");
  return isAutomationTemplateId(template) ? template : null;
}
