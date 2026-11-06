import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppsPanel } from "../../provider-applications/panel.js";

const appsSearchSchema = z.object({
  provider: z.enum(["github", "slack", "discord", "linear"]).optional(),
  edit: z.literal("credentials").optional(),
});

export const Route = createFileRoute("/_shell/apps")({
  staticData: { breadcrumb: "Apps", instance: true },
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = appsSearchSchema.safeParse({
      provider: search["provider"],
      edit: search["edit"],
    });
    return parsed.success ? parsed.data : {};
  },
  component: AppsRoute,
});

function AppsRoute() {
  const { provider, edit } = Route.useSearch();
  const credentialEditor = edit === "credentials" ? provider : undefined;
  return <AppsPanel {...(credentialEditor === undefined ? {} : { credentialEditor })} />;
}
