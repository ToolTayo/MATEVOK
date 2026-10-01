import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vercel static deployment targets dist and applies the same privacy headers and safe cache policy", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const headersFile = await readFile(new URL("../dist/_headers", import.meta.url), "utf8");
  const sharedHeaders = config.headers.find((entry) => entry.source === "/(.*)")?.headers;
  const values = Object.fromEntries((sharedHeaders || []).map(({ key, value }) => [key.toLowerCase(), value]));
  const headerRules = new Map();
  let path = null;
  for (const line of headersFile.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) { path = line.trim(); headerRules.set(path, {}); continue; }
    const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (match && path) headerRules.get(path)[match[1].toLowerCase()] = match[2];
  }

  assert.equal(config.outputDirectory, "dist");
  for (const name of ["content-security-policy", "permissions-policy", "referrer-policy", "x-content-type-options", "x-frame-options"]) {
    assert.equal(values[name], headerRules.get("/*")?.[name], `${name} must match the portable static-host policy`);
  }
  assert.match(values["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(config.headers.find((entry) => entry.source === "/index.html")?.headers.find(({ key }) => key.toLowerCase() === "cache-control")?.value, headerRules.get("/index.html")?.["cache-control"]);
  assert.equal(config.headers.find((entry) => entry.source === "/sw.js")?.headers.find(({ key }) => key.toLowerCase() === "cache-control")?.value, headerRules.get("/sw.js")?.["cache-control"]);
});
