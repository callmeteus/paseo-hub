import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { takeConnectionHandoff } from "./functions.js";
import { watchConnectionHandoff } from "./handoff-watch.js";

/**
 * Polls for a provider callback that the system browser could not finish.
 *
 * @returns Nothing visible. The callback, when it arrives, replaces this page.
 */
export function ConnectionHandoffWatcher() {
  const take = useServerFn(takeConnectionHandoff);
  useEffect(() => {
    return watchConnectionHandoff(async () => {
      const result = await take();
      if (result.status !== "ok") {
        return null;
      }
      return result.data.path;
    });
  }, [take]);
  return null;
}
