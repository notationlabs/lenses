#!/usr/bin/env node
/**
 * Native-messaging bridge between Chrome and the lens-host processes.
 *
 * Chrome launches this over a stdio pipe (see `pok setup native`). Each running
 * lens-host writes a `<port>.json` file into ~/.actors/hosts on bind and removes
 * it on exit; this helper watches that directory and pushes the live-port list to
 * the extension whenever it changes. Because the extension is *told* which ports
 * are live, it only ever opens WebSockets to real hosts — so discovery is instant
 * and never logs a connection-refused line, even for a host that starts while the
 * user is parked on a page.
 *
 * Zero dependencies: it must run under whatever `node` is on PATH.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";

const DIR = join(homedir(), ".actors", "hosts");

// ---- native messaging framing: 4-byte LE length prefix + UTF-8 JSON ----
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

// ---- read the registry, dropping stale entries (crashed hosts) ----
function livePorts() {
  const ports = [];
  let files;
  try {
    files = readdirSync(DIR);
  } catch {
    return ports;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(DIR, file);
    try {
      const { pid, port } = JSON.parse(readFileSync(path, "utf8"));
      // process.kill(pid, 0) throws ESRCH if the pid is gone; EPERM means alive.
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code === "ESRCH") {
          rmSync(path, { force: true });
          continue;
        }
      }
      if (typeof port === "number") ports.push(port);
    } catch {
      // unreadable/half-written file — skip it, it'll settle on the next tick
    }
  }
  return ports.sort((a, b) => a - b);
}

// null (not "") so the very first publish always fires — even with zero hosts.
// That empty message tells the extension the native channel is live and
// authoritative, so it suppresses lazy TCP probing entirely.
let lastSent = null;
function publish() {
  const ports = livePorts();
  const key = ports.join(",");
  if (key === lastSent) return;
  lastSent = key;
  send({ ports });
}

mkdirSync(DIR, { recursive: true });

// Push the current set immediately, then on every change (debounced).
publish();
let timer = null;
if (existsSync(DIR)) {
  watch(DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(publish, 100);
  });
}

// Chrome closes stdin when it disconnects the port; exit cleanly then.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
