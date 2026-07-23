import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/serial-task-queue.js";

describe("SerialTaskQueue", () => {
  it("does not start a second task until the first finishes", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push("first started");
      await firstGate;
      events.push("first finished");
    });
    const second = queue.run(async () => {
      events.push("second started");
    });

    await Promise.resolve();
    expect(events).toEqual(["first started"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first started", "first finished", "second started"]);
  });

  it("continues after a task rejects", async () => {
    const queue = new SerialTaskQueue();
    const first = queue.run(async () => {
      throw new Error("failed");
    });
    const second = queue.run(async () => "completed");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("completed");
  });
});
