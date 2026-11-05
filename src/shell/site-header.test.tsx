import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, it } from "vitest";

import { breadcrumbsFromMatches, organizationHomePath } from "../navigation/index.js";
import { INSTANCE_ENTRY } from "./switchers.js";
import { BreadcrumbNav, breadcrumbSteps, type BreadcrumbStep } from "./site-header.js";

const root = createRootRoute();
const home = createRoute({
  getParentRoute: () => root,
  path: "/o/$organizationSlug/home",
});
const triggers = createRoute({
  getParentRoute: () => root,
  path: "/o/$organizationSlug/triggers",
});
const trigger = createRoute({
  getParentRoute: () => triggers,
  path: "$triggerId",
});
const runs = createRoute({
  getParentRoute: () => trigger,
  path: "runs",
});
const settings = createRoute({
  getParentRoute: () => root,
  path: "/o/$organizationSlug/settings",
});
const team = createRoute({
  getParentRoute: () => settings,
  path: "team",
});
const apps = createRoute({
  getParentRoute: () => root,
  path: "/apps",
});
const operator = createRoute({
  getParentRoute: () => root,
  path: "/operator",
});
const routeTree = root.addChildren([
  home,
  triggers.addChildren([trigger.addChildren([runs])]),
  settings.addChildren([team]),
  apps,
  operator,
]);
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/o/paseo-hub/triggers/nightly"] }),
});

function renderTrail(steps: readonly BreadcrumbStep[]): string {
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <BreadcrumbNav steps={steps} />
    </RouterContextProvider>,
  );
}

function anchorHrefs(markup: string): { href: string; text: string }[] {
  return [...markup.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/gu)].map((match) => {
    const attrs = match[1] ?? "";
    const href = /href="([^"]*)"/u.exec(attrs)?.[1] ?? "";
    return { href, text: match[2] ?? "" };
  });
}

describe("breadcrumb destinations", () => {
  it("sends the organization name to the home route that name already opens", () => {
    assert.equal(organizationHomePath("paseo-hub"), "/o/paseo-hub/home");
    assert.equal(INSTANCE_ENTRY, "/apps");
  });

  it("uses each ancestor route's own pathname, and keeps the open page's label", () => {
    const trail = breadcrumbsFromMatches([
      { staticData: {}, pathname: "/" },
      { staticData: { breadcrumb: "Automations" }, pathname: "/o/paseo-hub/triggers/" },
      { staticData: { breadcrumb: "Nightly digest" }, pathname: "/o/paseo-hub/triggers/nightly" },
    ]);
    const steps = breadcrumbSteps({
      scope: { label: "Paseo Hub", to: organizationHomePath("paseo-hub") },
      trail,
    });

    assert.deepEqual(steps, [
      { label: "Paseo Hub", to: "/o/paseo-hub/home" },
      { label: "Automations", to: "/o/paseo-hub/triggers" },
      { label: "Nightly digest" },
    ]);
  });

  it("links every ancestor on a page under the open automation", () => {
    const steps = breadcrumbSteps({
      scope: { label: "Paseo Hub", to: organizationHomePath("paseo-hub") },
      trail: breadcrumbsFromMatches([
        { staticData: { breadcrumb: "Automations" }, pathname: "/o/paseo-hub/triggers" },
        { staticData: { breadcrumb: "Nightly digest" }, pathname: "/o/paseo-hub/triggers/nightly" },
        { staticData: { breadcrumb: "Runs" }, pathname: "/o/paseo-hub/triggers/nightly/runs" },
      ]),
    });

    assert.deepEqual(steps, [
      { label: "Paseo Hub", to: "/o/paseo-hub/home" },
      { label: "Automations", to: "/o/paseo-hub/triggers" },
      { label: "Nightly digest", to: "/o/paseo-hub/triggers/nightly" },
      { label: "Runs" },
    ]);
  });

  it("links Settings to the settings route and leaves the open section as text", () => {
    const steps = breadcrumbSteps({
      scope: { label: "Acme", to: organizationHomePath("acme") },
      trail: breadcrumbsFromMatches([
        { staticData: { breadcrumb: "Settings" }, pathname: "/o/acme/settings" },
        { staticData: { breadcrumb: "Team" }, pathname: "/o/acme/settings/team" },
      ]),
    });

    assert.deepEqual(steps, [
      { label: "Acme", to: "/o/acme/home" },
      { label: "Settings", to: "/o/acme/settings" },
      { label: "Team" },
    ]);
  });
});

describe("breadcrumb links", () => {
  it("renders an href for each ancestor and leaves the open automation as the current page", () => {
    const markup = renderTrail(
      breadcrumbSteps({
        scope: { label: "Paseo Hub", to: organizationHomePath("paseo-hub") },
        trail: breadcrumbsFromMatches([
          { staticData: { breadcrumb: "Automations" }, pathname: "/o/paseo-hub/triggers" },
          { staticData: { breadcrumb: "Automation" }, pathname: "/o/paseo-hub/triggers/trig_1" },
        ]),
      }),
    );

    assert.deepEqual(anchorHrefs(markup), [
      { href: "/o/paseo-hub/home", text: "Paseo Hub" },
      { href: "/o/paseo-hub/triggers", text: "Automations" },
    ]);
    assert.match(markup, /aria-current="page"[^>]*>Automation</u);
    assert.doesNotMatch(markup, /<a\b[^>]*>[^<]*\/[^<]*<\/a>/u);
    assert.match(markup, /aria-hidden="true"[^>]*>\/</u);
    for (const anchor of markup.match(/<a\b[^>]*>/gu) ?? []) {
      assert.doesNotMatch(anchor, /tabindex="-1"/u);
    }
  });

  it("keeps a real automation name on the open step, and still links the ancestors", () => {
    const markup = renderTrail(
      breadcrumbSteps({
        scope: { label: "Paseo Hub", to: organizationHomePath("paseo-hub") },
        trail: [
          { label: "Automations", to: "/o/paseo-hub/triggers" },
          { label: "Nightly digest", to: "/o/paseo-hub/triggers/nightly" },
          { label: "Runs", to: "/o/paseo-hub/triggers/nightly/runs" },
        ],
      }),
    );

    assert.deepEqual(anchorHrefs(markup), [
      { href: "/o/paseo-hub/home", text: "Paseo Hub" },
      { href: "/o/paseo-hub/triggers", text: "Automations" },
      { href: "/o/paseo-hub/triggers/nightly", text: "Nightly digest" },
    ]);
    assert.match(markup, /aria-current="page"[^>]*>Runs</u);
    assert.doesNotMatch(markup, /<a\b[^>]*>Runs<\/a>/u);
  });

  it("links the organization on its home page, and does not link Home to itself", () => {
    const markup = renderTrail(
      breadcrumbSteps({
        scope: { label: "Paseo Hub", to: organizationHomePath("paseo-hub") },
        trail: [{ label: "Home", to: "/o/paseo-hub/home" }],
      }),
    );

    assert.deepEqual(anchorHrefs(markup), [{ href: "/o/paseo-hub/home", text: "Paseo Hub" }]);
    assert.match(markup, /aria-current="page"[^>]*>Home</u);
    assert.doesNotMatch(markup, /<a\b[^>]*>Home<\/a>/u);
  });

  it("links Instance to Apps and leaves the open instance page as text", () => {
    const markup = renderTrail(
      breadcrumbSteps({
        scope: { label: "Instance", to: INSTANCE_ENTRY },
        trail: [{ label: "Operator", to: "/operator" }],
      }),
    );

    assert.deepEqual(anchorHrefs(markup), [{ href: "/apps", text: "Instance" }]);
    assert.match(markup, /aria-current="page"[^>]*>Operator</u);
    assert.doesNotMatch(markup, /<a\b[^>]*>Operator<\/a>/u);
  });
});
