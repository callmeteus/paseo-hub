/**
 * Whether Hub is open inside the Paseo desktop webview.
 *
 * Paseo cancels a cross-origin navigation and opens the system browser, so
 * the connections page does not unload. A normal browser does leave.
 *
 * @param userAgent - `navigator.userAgent`, or an empty string during server render.
 * @returns True when this page stays after an external URL is opened.
 */
export function embeddedHubKeepsPage(userAgent: string): boolean {
  return userAgent.includes("Electron");
}
