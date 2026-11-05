/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- crumb destinations are paths the router already matched */
import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";

import { usePageContext, type PageBreadcrumb } from "../navigation/index.js";
import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarTrigger, useSidebar } from "../components/ui/sidebar.js";
import { SiteHeaderActionsTarget } from "./site-header-actions.js";

// Module scope so the link does not receive a fresh object every render. Exact matching keeps an
// ancestor from being announced as the open page; the empty active props skip the default
// "active" class, which this trail does not style.
const EXACT_CRUMB = { exact: true };
const CRUMB_ACTIVE_PROPS = {};

/** One step in the trail. `to` is absent on the open page, which is not a link to itself. */
export interface BreadcrumbStep {
  label: string;
  to?: string;
}

/**
 * Header context, not a second title. The page owns its `<h1>`; this says where that page sits,
 * which is why it leads with where you are — the same scope the sidebar header stacks — rather
 * than repeating the view. Everything but the last crumb hides on a phone, so the trail always
 * ends on the thing the reader is looking at.
 *
 * Ancestors link to the route that already owns that step. The last step is the open page, so
 * it is not a link, and the slash between steps is only a separator.
 */
export function SiteHeader({
  scope,
  scopeTo,
  project,
}: {
  scope: string;
  /** The route that `scope` already is: organization home, or Apps for Instance. */
  scopeTo: string;
  project?: string;
}) {
  const { breadcrumbs: trail } = usePageContext();
  const steps = breadcrumbSteps({
    scope: { label: scope, to: scopeTo },
    ...(project === undefined ? {} : { project }),
    trail,
  });
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <RestoringSidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <BreadcrumbNav steps={steps} />
      <SiteHeaderActionsTarget />
    </header>
  );
}

/**
 * The trail the header renders. Scope and every route crumb except the last are links.
 * A project name stays text: this Hub has no project route for it to open.
 */
export function breadcrumbSteps(input: {
  scope: { label: string; to: string };
  project?: string;
  trail: readonly PageBreadcrumb[];
}): BreadcrumbStep[] {
  const steps: BreadcrumbStep[] = [
    {
      label: input.scope.label,
      to: input.scope.to,
    },
  ];

  if (input.project !== undefined) {
    steps.push({ label: input.project });
  }

  for (const [index, crumb] of input.trail.entries()) {
    const open = index === input.trail.length - 1;

    // The open page keeps whatever label the route already gave it, including an automation's
    // own name when a route sets one. It does not link to itself.
    if (open) {
      steps.push({ label: crumb.label });
    } else {
      steps.push({
        label: crumb.label,
        to: crumb.to,
      });
    }
  }

  return steps;
}

/** The breadcrumb landmark. Steps come from `breadcrumbSteps`; this only paints them. */
export function BreadcrumbNav({ steps }: { steps: readonly BreadcrumbStep[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm"
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <Crumb
            key={step.to ?? (last ? `open:${step.label}` : `context:${step.label}`)}
            hideOnPhone={!last && index > 0}
            separator={index > 0}
            current={last && step.to === undefined}
            {...(step.to === undefined ? {} : { to: step.to })}
          >
            {step.label}
          </Crumb>
        );
      })}
    </nav>
  );
}

/**
 * One crumb, including the rule that leads into it. The separator belongs to the crumb after it
 * rather than sitting between two of them, which is what keeps a hidden crumb from leaving its
 * rule behind: on a phone the trail is one crumb, not "Paseo Hub / / API keys".
 *
 * `hideOnPhone` is a crumb that only says where the last one sits, so it is the muted one and
 * it is the one a phone drops. The separator is not part of the link.
 */
function Crumb({
  hideOnPhone = false,
  separator = true,
  current = false,
  to,
  children,
}: {
  hideOnPhone?: boolean;
  separator?: boolean;
  current?: boolean;
  to?: string;
  children: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        hideOnPhone && "hidden text-muted-foreground sm:flex",
      )}
    >
      {separator ? (
        <span aria-hidden="true" className="text-extra-muted-foreground">
          /
        </span>
      ) : null}
      {to === undefined ? (
        <span className="truncate" {...(current ? { "aria-current": "page" as const } : {})}>
          {children}
        </span>
      ) : (
        <Link
          to={to as never}
          activeOptions={EXACT_CRUMB}
          activeProps={CRUMB_ACTIVE_PROPS}
          className="min-w-0 truncate text-muted-foreground underline decoration-extra-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-current"
        >
          {children}
        </Link>
      )}
    </span>
  );
}

function RestoringSidebarTrigger() {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const { isMobile, openMobile } = useSidebar();

  useEffect(() => {
    if (isMobile && wasOpen.current && !openMobile) trigger.current?.focus();
    wasOpen.current = openMobile;
  }, [isMobile, openMobile]);

  return <SidebarTrigger ref={trigger} className="-ml-1" />;
}
