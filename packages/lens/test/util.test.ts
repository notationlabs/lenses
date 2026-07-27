import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/util.js";

/** Evaluate an expression that is expected to throw, and format what it threw. */
async function messageFor(expr: string, data: unknown): Promise<string> {
  try {
    await jsonata(expr).evaluate(data);
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error(`${expr} did not throw`);
}

describe("errorMessage", () => {
  it("reads a JSONata throw, which is a plain object and not an Error", async () => {
    // The shape that made every one of these print "[object Object]".
    expect(await messageFor('$number("")', {})).toBe(
      'Unable to cast value to a number: "" [D3030 at position 8, near "number"]'
    );
  });

  it("locates a null argument reaching a string function", async () => {
    // A selector that matched nothing extracts as null; $split then throws.
    expect(await messageFor('$split(url, "/")', { url: null })).toBe(
      'Argument 1 of function "split" does not match function signature [T0410 at position 7, near "split"]'
    );
  });

  it("passes an Error through unchanged", () => {
    expect(errorMessage(new Error("missing parameter \"year\""))).toBe(
      'missing parameter "year"'
    );
  });

  it("falls back to stringification for values carrying no message", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: "X", position: 1 })).toBe("[object Object]");
  });
});
