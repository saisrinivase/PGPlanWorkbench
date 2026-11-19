// CI-only generated input. No captures, screenshots, traces or report artifacts.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";

assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP is required");
const engines = await import(pathToFileURL(join(process.env.RUNNER_TEMP, "pgplan-browser-tools/node_modules/playwright/index.mjs")).href);
const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const make = depth => ({ "Node Type": depth ? "Append" : "Result", "Plan Rows": 1,
  "Startup Cost": 0, "Total Cost": 1, "Plan Width": 4,
  ...(depth ? { Plans: [make(depth - 1), make(depth - 1)] } : {}) });
const plan = make(6);
const lines = (node, depth = 0) => [(depth ? " ".repeat(depth * 6 - 4) + "->  " : "")
  + node["Node Type"] + "  (cost=0.00..1.00 rows=1 width=4)",
  ...(node.Plans ?? []).flatMap(child => lines(child, depth + 1))];
try {
  for (const name of ["chromium", "firefox", "webkit"]) {
    const browser = await engines[name].launch();
    try {
      for (const source of [JSON.stringify([{ Plan: plan }]), lines(plan).join("\n")]) {
        const page = await browser.newPage();
        const errors = [], outbound = [];
        page.on("pageerror", error => errors.push(error.name));
        await page.route("**/*", route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          outbound.push(true);
          return route.abort();
        });
        const response = await page.goto(origin);
        assert.match(response.headers()["content-security-policy"], /connect-src 'self'/);
        assert.equal(await page.title(), "PGPlanWorkbench");
        await page.locator("#plan-input-v06").fill(source);
        const started = Date.now();
        await page.getByRole("button", { name: /^Analyze plan/ }).click();
        const renderer = page.getByTestId("pev2-renderer");
        const nodes = renderer.locator(".plan-node");
        await nodes.nth(126).waitFor({ state: "attached", timeout: 30_000 });
        assert.equal(await nodes.count(), 127);
        assert.ok(Date.now() - started < 30_000, "Dense render exceeds 30 seconds");
        await page.getByRole("link", { name: /Grid/ }).click();
        const rows = renderer.locator(".plan-grid tr.node");
        await rows.nth(126).waitFor({ state: "attached", timeout: 10_000 });
        assert.equal(await rows.count(), 127);
        await page.getByRole("button", { name: /^Findings/ }).click();
        await page.getByRole("heading", { name: "Findings", exact: true }).waitFor();
        await page.getByRole("button", { name: /^Validate fix/ }).click();
        await page.getByLabel("After plan evidence").waitFor();
        assert.deepEqual(errors, []);
        assert.equal(outbound.length, 0);
        await page.close();
      }
      console.log(`PASS ${name}: JSON/TEXT, 127 nodes, Grid, Findings, Validate Fix, no outbound requests`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.httpServer.close(resolve)); }
