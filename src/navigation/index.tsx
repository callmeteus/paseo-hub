import { trimPathRight, useMatches } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    breadcrumb?: string;
    instance?: boolean;
    tabs?: boolean;
    projectSection?: "overview" | "configuration" | "activity" | "settings";
  }
}

/** One step the route tree already named, and the pathname that step is. */
export interface PageBreadcrumb {
  label: string;
  to: string;
}

/**
 * Crumbs in the order the router is presenting them. A route that does not name a step is
 * skipped, so layout and index routes do not invent a label. The pathname is the one TanStack
 * already matched, params filled in, so a later page can link back to it.
 */
export function breadcrumbsFromMatches(
  matches: readonly { staticData: { breadcrumb?: string }; pathname: string }[],
): PageBreadcrumb[] {
  return matches.flatMap((match) => {
    const label = match.staticData.breadcrumb;

    if (label === undefined) {
      return [];
    }

    return [{ label, to: trimPathRight(match.pathname) }];
  });
}

/** Where the Hub already opens an organization: the home route, not a new one. */
export function organizationHomePath(organizationSlug: string): string {
  return `/o/${organizationSlug}/home`;
}

/** Shared layout context comes from the routes TanStack is presenting, including pending UI. */
export function usePageContext() {
  return useMatches({
    select: (matches) => ({
      breadcrumbs: breadcrumbsFromMatches(matches),
      instance: matches.some(({ staticData }) => staticData.instance === true),
      tabs: matches.some(({ staticData }) => staticData.tabs === true),
      projectSection:
        matches
          .flatMap(({ staticData }) =>
            staticData.projectSection === undefined ? [] : [staticData.projectSection],
          )
          .at(-1) ?? "overview",
    }),
    structuralSharing: true,
  });
}

/** Parameters are already decoded by the router; never reconstruct tenant identity from a URL. */
export function usePresentedTenantScope():
  | { organizationSlug: string; projectSlug?: string }
  | undefined {
  return useMatches({
    select: (matches) => {
      const params = matches.at(-1)!.params;
      return "organizationSlug" in params
        ? { organizationSlug: params.organizationSlug }
        : undefined;
    },
    structuralSharing: true,
  });
}

/** Links reflect the presented route tree, rather than the URL of an unfinished navigation. */
export function usePresentedDestination(to: string, subtree = false): boolean {
  return useMatches({
    select: (matches) =>
      (subtree ? matches : matches.slice(-1)).some(
        (match) => trimPathRight(match.pathname) === trimPathRight(to),
      ),
  });
}
