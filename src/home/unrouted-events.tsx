/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- each row's button opens that row, and the opened text is that row's own slot */
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { formatAbsolute, RelativeTime } from "../components/app/relative-time.js";
import { statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import type { HomeSnapshot } from "./dashboard.js";

type UnroutedEvent = HomeSnapshot["unroutedEvents"][number];

/**
 * The events the home warning counted. One list: a row is the resolved line, and opening it
 * shows the rest of the message and the clock time.
 */
export function UnroutedEventList({
  events,
  openId,
  onOpen,
}: {
  events: HomeSnapshot["unroutedEvents"];
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <RecordList label="Events with no trigger">
      {events.map((event) => (
        <UnroutedEventRow key={event.id} event={event} open={openId === event.id} onOpen={onOpen} />
      ))}
    </RecordList>
  );
}

function UnroutedEventRow({
  event,
  open,
  onOpen,
}: {
  event: UnroutedEvent;
  open: boolean;
  onOpen: (id: string) => void;
}) {
  const detailId = `unrouted-event-${event.id}`;
  const message = event.body ?? event.text;
  return (
    <RecordRow
      onSelect={() => onOpen(event.id)}
      controls={detailId}
      expanded={open ? <EventText message={message} receivedAt={event.receivedAt} /> : undefined}
    >
      <TwoLine primary={event.text ?? event.source} secondary={<EventDetail event={event} />} />
    </RecordRow>
  );
}

function EventText({ message, receivedAt }: { message: string | undefined; receivedAt: string }) {
  return (
    <>
      {message === undefined ? null : (
        <p className="min-w-0 text-sm break-words whitespace-pre-wrap">{message}</p>
      )}
      <time dateTime={receivedAt} className="text-sm text-muted-foreground">
        {formatAbsolute(receivedAt)}
      </time>
    </>
  );
}

function EventDetail({ event }: { event: UnroutedEvent }) {
  const parts = [unroutedProviderName(event.provider)];
  if (event.channel !== undefined) parts.push(event.channel);
  if (event.author !== undefined) parts.push(event.author);
  if (event.repository !== undefined) parts.push(event.repository);
  return (
    <>
      {parts.join(" · ")} · <RelativeTime value={event.receivedAt} />
    </>
  );
}

export function unroutedProviderName(
  provider: HomeSnapshot["unrouted"][number]["provider"],
): string {
  if (provider === "github") return "GitHub";
  if (provider === "slack") return "Slack";
  if (provider === "discord") return "Discord";
  if (provider === "linear") return "Linear";
  return statusLabel(provider);
}
