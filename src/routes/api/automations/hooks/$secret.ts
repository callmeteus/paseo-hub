import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/automations/hooks/$secret")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJsonBody(request);
        const result = await (
          await getApplication()
        ).operations.handleAutomationWebhook({
          secret: secretFromRequest(request),
          body,
        });
        if (result.status === "accepted") return Response.json({ ok: true });
        if (result.status === "ambiguous") {
          return Response.json({ ok: false }, { status: 409 });
        }
        if (result.status === "unavailable") {
          return Response.json({ ok: false }, { status: 503 });
        }
        if (result.status === "rejected") {
          return Response.json({ ok: false }, { status: 422 });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    },
  },
});

function secretFromRequest(request: Request): string {
  const segment = new URL(request.url).pathname.split("/").at(-1) ?? "";
  return decodeURIComponent(segment);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
