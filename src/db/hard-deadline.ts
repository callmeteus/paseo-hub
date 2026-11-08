/**
 * An accepted run starts with a hard deadline. The execution can clear it.
 * Null means there is no hard cap. The idle timeout is a separate clock.
 */
export function hardDeadlinePassed(deadline: Date | null, at: Date): boolean {
  return deadline !== null && deadline.getTime() <= at.getTime();
}

/**
 * The earlier of a step clock and the run clock. A cleared run clock does not cap the step.
 */
export function earlierDeadline(stepDeadline: Date, runDeadline: Date | null): Date {
  if (runDeadline === null) return stepDeadline;
  return new Date(Math.min(stepDeadline.getTime(), runDeadline.getTime()));
}
