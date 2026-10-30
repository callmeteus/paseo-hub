/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- one picker binds the channel filter of the open trigger */
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useState } from "react";

import { LoadingLine } from "../../components/app/loading.js";
import type { FieldControl } from "../../components/app/form-field.js";
import { Button } from "../../components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.js";
import { cn } from "../../lib/utils.js";
import { useSnapshotQuery } from "../../queries/index.js";
import type { SlackChannelChoice } from "../../providers/slack/channels.js";
import { slackChannels } from "../functions.js";

/**
 * Searchable multi-select of Slack channels.
 *
 * The form still stores channel ids, because that is what the event filter compares. The list
 * shows names. An empty selection means every channel the bot is in.
 *
 * @param props - The open trigger's Slack connection and the current id list
 * @returns Nothing.
 */
export function SlackChannelPicker({
  control,
  organizationSlug,
  connection,
  value,
  onChange,
}: {
  control: FieldControl;
  organizationSlug: string;
  connection: string;
  value: string;
  onChange: (channels: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const load = useServerFn(slackChannels);
  const connected = connection.trim().length > 0;
  const snapshot = useSnapshotQuery({
    queryKey: ["slack-channels", organizationSlug, connection],
    queryFn: () =>
      load({
        data: {
          organizationSlug,
          connectionSlug: connection,
        },
      }),
    enabled: connected,
  });
  const selected = channelIds(value);
  const channels = snapshot.status === "success" ? snapshot.data : undefined;
  const invalid = control["aria-invalid"];

  return (
    <div className="grid gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={control.id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            {...(control.required === undefined ? {} : { "aria-required": control.required })}
            {...(invalid ? { "aria-invalid": true } : {})}
            {...(control["aria-describedby"] === undefined
              ? {}
              : { "aria-describedby": control["aria-describedby"] })}
            disabled={!connected}
            className="w-full min-w-0 justify-between"
          >
            <span className={cn("truncate", selected.length === 0 && "text-muted-foreground")}>
              {connected ? selectionLabel(selected, channels) : "Select a connection"}
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent id={listId} align="start" className="w-(--radix-popover-trigger-width) p-0">
          <Command>
            <CommandInput placeholder="Search channels" />
            <CommandList>
              {snapshot.status === "pending" ? <LoadingLine>Loading channels</LoadingLine> : null}
              {snapshot.status === "error" ? (
                <p className="px-3 py-6 text-center text-sm text-destructive">
                  {snapshot.error ?? "Hub couldn't load Slack channels."}
                </p>
              ) : null}
              {snapshot.status === "success" ? (
                <>
                  <CommandEmpty>No channels found.</CommandEmpty>
                  <ChannelOptions
                    channels={snapshot.data}
                    selected={selected}
                    onChange={onChange}
                    value={value}
                  />
                </>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {snapshot.status === "error" ? (
        <p className="text-sm text-destructive">
          {snapshot.error ?? "Hub couldn't load Slack channels."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "every channel" row plus one row per channel the bot is in.
 *
 * @param props - The loaded channels and the ids already chosen
 * @returns Nothing.
 */
function ChannelOptions({
  channels,
  selected,
  value,
  onChange,
}: {
  channels: readonly SlackChannelChoice[];
  selected: readonly string[];
  value: string;
  onChange: (channels: string) => void;
}) {
  return (
    <>
      <CommandItem value="every channel" keywords={["all"]} onSelect={() => onChange("")}>
        <span className="truncate">Every channel</span>
        <Check className={cn("ml-auto", selected.length === 0 ? "opacity-100" : "opacity-0")} />
      </CommandItem>
      {channels.map((channel) => (
        <CommandItem
          key={channel.id}
          value={channel.name}
          keywords={[channel.id, `#${channel.name}`]}
          onSelect={() => onChange(toggleChannel(value, channel.id))}
        >
          <span className="truncate">#{channel.name}</span>
          {channel.isPrivate ? (
            <span className="text-xs text-muted-foreground">Private</span>
          ) : null}
          <Check
            className={cn("ml-auto", selected.includes(channel.id) ? "opacity-100" : "opacity-0")}
          />
        </CommandItem>
      ))}
    </>
  );
}

/**
 * The closed control's label. Names replace ids once the list has loaded.
 *
 * @param selected - Channel ids currently stored on the form
 * @param channels - The loaded list, absent while the request is still running
 * @returns The text on the closed picker
 */
function selectionLabel(
  selected: readonly string[],
  channels: readonly SlackChannelChoice[] | undefined,
): string {
  if (selected.length === 0) {
    return "Every channel";
  }

  if (channels === undefined) {
    if (selected.length === 1) {
      return "1 channel";
    }

    return `${selected.length} channels`;
  }

  return selected
    .map((id) => {
      const channel = channels.find((candidate) => candidate.id === id);

      if (channel === undefined) {
        return id;
      }

      return `#${channel.name}`;
    })
    .join(", ");
}

/**
 * Splits the form's comma-separated channel ids.
 *
 * @param value - The channels field
 * @returns Ids, without empty entries
 */
function channelIds(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Adds or removes one channel id.
 *
 * @param value - The channels field
 * @param id - Channel to toggle
 * @returns The field value the form should store
 */
function toggleChannel(value: string, id: string): string {
  const selected = channelIds(value);
  const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
  return next.join(", ");
}
