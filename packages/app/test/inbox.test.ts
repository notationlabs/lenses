import { describe, expect, it } from "vitest";
import { createInbox, needLabel } from "../src/inbox.js";

describe("inbox", () => {
  it("tells once per page, however often the page asks", () => {
    const added: number[] = [];
    const inbox = createInbox({ added: (item) => added.push(item.page) });
    inbox.raise(1, "example.com", "needs_auth", 100);
    inbox.raise(1, "example.com", "needs_auth", 200);
    inbox.raise(2, "other.org", "needs_auth", 300);
    expect(added).toEqual([1, 2]);
    expect(inbox.items().map((item) => [item.page, item.since])).toEqual([[1, 100], [2, 300]]);
  });

  it("keeps an ignored item until the page no longer needs the user", () => {
    const inbox = createInbox();
    inbox.raise(1, "example.com", "needs_auth");
    inbox.ignore(1);
    expect(inbox.get(1)).toMatchObject({ ignored: true });
    // Asked again (another sign-in step): still quiet.
    inbox.raise(1, "example.com", "needs_auth");
    expect(inbox.get(1)).toMatchObject({ ignored: true });
    inbox.remove(1);
    expect(inbox.items()).toEqual([]);
  });

  it("says what the user is asked to do", () => {
    expect(needLabel("needs_auth", "example.com")).toBe("Sign in to example.com");
    expect(needLabel("needs_human_check", "example.com")).toBe("example.com needs human check");
  });
});
