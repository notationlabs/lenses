import { afterEach, describe, expect, it, vi } from "vitest";
import { performSteps } from "../src/background/perform.js";

afterEach(() => vi.unstubAllGlobals());

describe("perform submit", () => {
  it("passes literal form fields to the content-script primitive", async () => {
    const messages: unknown[] = [];
    vi.stubGlobal("chrome", {
      tabs: {
        async sendMessage(_tabId: number, message: unknown) {
          messages.push(message);
          return { ok: true };
        },
        async get() {
          return { url: "https://example.com/journal", title: "Journal" };
        },
      },
    });

    const result = await performSteps(
      { tabId: 7, target: "https://example.com/journal", loadTimeoutMs: 1000 },
      [{
        submit: "#journal_set",
        form: { "journal_set[description]": "published" },
      }]
    );

    expect(messages).toEqual([{
      type: "perform_submit",
      selector: "#journal_set",
      form: { "journal_set[description]": "published" },
    }]);
    expect(result).toEqual({
      url: "https://example.com/journal",
      title: "Journal",
    });
  });
});
