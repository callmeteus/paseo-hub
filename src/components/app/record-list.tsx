/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- a row href is a concrete path the generated route union cannot name */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * A short list of records inside a card, for the times a table would be wrong: the records are
 * already grouped by the card's own subject, so a header row would only repeat it.
 *
 * A table is still the answer for a page-level list of many records with real columns. Reach for
 * this when a card owns a handful of rows and the only columns are "what it is" and "what state
 * it is in" — four provider cards each listing their own connections, not one connections table.
 */
export function RecordList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="grid divide-y divide-border">
      {children}
    </ul>
  );
}

/**
 * One record: what it is on the left, its state and its actions on the right. The row owns the
 * distance to its neighbours so no card decides that for itself.
 */
export function RecordRow({
  children,
  status,
  actions,
  href,
  onSelect,
  expanded,
  controls,
}: {
  /** The identity of the record, normally a `TwoLine`. */
  children: ReactNode;
  /** Its state, always a `StatusPill`. */
  status?: ReactNode;
  /** Its actions, always behind a `RowActions` kebab. */
  actions?: ReactNode;
  /**
   * When set, the whole row is one link. Tab lands on it and Enter follows it, and the pointer
   * does the same wherever it hits the row. Do not combine it with `actions`: a menu inside a
   * link is a second control.
   */
  href?: string;
  /**
   * When set, the row is a button. Enter and Space run it. Not combined with `href`: a row is
   * either a link or a button. The button has no fill, so opening a row does not paint a card
   * under it.
   */
  onSelect?: () => void;
  /** The rest of the record, under the button. The row owns the gap. */
  expanded?: ReactNode;
  /** Id of `expanded`, announced from the button. */
  controls?: string;
}) {
  const body = (
    <>
      <div className="min-w-0">{children}</div>
      <div className="flex shrink-0 items-center gap-2">
        {status}
        {actions}
      </div>
    </>
  );
  if (onSelect !== undefined) {
    return (
      <li className="py-3">
        <button
          type="button"
          className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md bg-transparent text-left text-inherit"
          aria-expanded={expanded !== undefined}
          {...(controls === undefined || expanded === undefined
            ? {}
            : { "aria-controls": controls })}
          onClick={onSelect}
        >
          {body}
        </button>
        {expanded === undefined ? null : (
          <div id={controls} className="mt-2 grid gap-2">
            {expanded}
          </div>
        )}
      </li>
    );
  }
  if (href === undefined) {
    return (
      <li className="flex min-w-0 items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
        {body}
      </li>
    );
  }
  return (
    <li className="group">
      <Link
        to={href as never}
        className="flex min-w-0 items-center justify-between gap-3 rounded-md py-3 text-inherit no-underline outline-none group-first:pt-0 group-last:pb-0 hover:bg-accent focus-visible:bg-accent"
      >
        {body}
      </Link>
    </li>
  );
}
