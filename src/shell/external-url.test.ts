import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { embeddedHubKeepsPage } from "./external-url.js";

describe("embedded Hub external navigation", () => {
  it("keeps the page when Hub is inside Paseo", () => {
    assert.equal(
      embeddedHubKeepsPage(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/33.2.0 Safari/537.36",
      ),
      true,
    );
  });

  it("leaves the page in a normal browser", () => {
    assert.equal(
      embeddedHubKeepsPage(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      ),
      false,
    );
  });

  it("leaves the page when the user agent is missing", () => {
    assert.equal(embeddedHubKeepsPage(""), false);
  });
});
