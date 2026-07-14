import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Open the step-by-step setup guide in Chrome",
  run: async (r) => {
    await r.exec('open -a "Google Chrome" setup-guide.html');
    r.reporter.success("Opened setup-guide.html — follow the six steps.");
  },
});
