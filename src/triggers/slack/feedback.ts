/**
 * Buttons the agent attaches to a finished Slack card.
 *
 * The labels are whatever the agent sent. A click arrives as `block_actions`.
 * Suggested prompts are a different surface: they sit at the top of the Messages tab.
 */

export const SLACK_CHOICE_LIMIT = 5;

export interface SlackChoice {
  label: string;
  value: string;
  style?: "primary" | "danger";
}

const CHOICE_ACTION_ID = /^paseo_choice_\d+$/u;

/**
 * The sentence the next turn receives.
 *
 * @param choice - The button the person pressed
 * @returns The arrival text
 */
export function slackChoiceArrival(choice: Pick<SlackChoice, "label" | "value">): string {
  if (choice.label === choice.value) return `The person chose "${choice.label}".`;
  return `The person chose "${choice.label}" (${choice.value}).`;
}

/**
 * The buttons `chat.stopStream` attaches under the card.
 *
 * @param choices - Options the agent asked the person to pick
 * @returns One actions block
 */
export function slackChoiceBlocks(choices: readonly SlackChoice[]): Record<string, unknown>[] {
  return [
    {
      type: "actions",
      block_id: "paseo_choices",
      elements: choices.map((choice, index) => ({
        type: "button",
        action_id: `paseo_choice_${String(index)}`,
        text: { type: "plain_text", text: choice.label },
        value: choice.value,
        ...(choice.style === undefined ? {} : { style: choice.style }),
      })),
    },
  ];
}

/**
 * The option named by one of our buttons.
 *
 * @param action - One element of a `block_actions` payload
 * @returns The choice, or undefined for a button this app did not post
 */
export function slackChoiceFromAction(action: {
  action_id: string;
  value?: string | undefined;
  text?: { text?: string | undefined } | undefined;
}): Pick<SlackChoice, "label" | "value"> | undefined {
  if (!CHOICE_ACTION_ID.test(action.action_id)) return undefined;
  const value = action.value?.trim() ?? "";
  if (value.length === 0 || value.length > 200) return undefined;
  const label = action.text?.text?.trim() ?? "";
  return { label: label.length > 0 ? label : value, value };
}

/**
 * The card blocks with the choice buttons replaced by the option the person picked.
 *
 * Other blocks stay as Slack sent them, so the plan above the buttons remains.
 *
 * @param blocks - `message.blocks` from the click
 * @param label - The button text the person chose
 * @returns The replacement blocks, or undefined when this message has no choice buttons
 */
export function blocksAfterChoice(
  blocks: readonly unknown[],
  label: string,
): Record<string, unknown>[] | undefined {
  let replaced = false;
  const next = blocks.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (!blockHasChoice(block)) return [block];
    replaced = true;
    return [choiceLine(label)];
  });
  return replaced ? next : undefined;
}

function choiceLine(label: string): Record<string, unknown> {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: label }],
  };
}

function blockHasChoice(block: Record<string, unknown>): boolean {
  if (block["type"] !== "actions" || !Array.isArray(block["elements"])) return false;
  return block["elements"].some(
    (element) =>
      isRecord(element) &&
      typeof element["action_id"] === "string" &&
      CHOICE_ACTION_ID.test(element["action_id"]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
