/**
 * browser-probe.mjs — real Web-surface observation for a declared dsh.client.
 *
 * This runs only inside the maintainer-triggered, network-denied verifier
 * container. It starts the official `dsh --profile web` surface, opens its
 * authenticated startup URL in Chromium, and records a subject-owned UI
 * marker. A declared client is not a load pass unless the marker is visible
 * and the page reports no browser/runtime/network errors.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from '/usr/local/lib/node_modules/@playwright/test/index.mjs';

const SPEC = process.argv[2] ?? '';
const OUT = process.argv[3] ?? '/work/out/l2-browser.json';
const PORT = Number(process.env.DSH_VERIFY_BROWSER_PORT ?? 8765);
const STARTUP_BOUND_MS = 30_000;
const PAGE_BOUND_MS = 30_000;
const SUBJECT_MARKER = /^(Notifications|通知)$/i;

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

function safeText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"']+/g, (url) => safeUrl(url))
    .replace(/(?:\/work|\/home\/verifier|\/usr\/local|\/tmp|\/opt)(?:\/[^\s"']*)?/g, '<runtime-path>')
    .slice(-2048);
}

function writeResult(result) {
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function waitForStartup(server, output) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STARTUP_BOUND_MS;
    const check = () => {
      const match = output.join('').match(/\bdsh web:\s+(https?:\/\/[^\s]+)/);
      if (match) return resolve(match[1]);
      if (server.exitCode !== null) return reject(new Error(`web surface exited ${server.exitCode}`));
      if (Date.now() >= deadline) return reject(new Error('web surface did not print a startup URL within the bound'));
      setTimeout(check, 100);
    };
    check();
  });
}

async function visibleMarker(page) {
  const marker = page.getByText(SUBJECT_MARKER).first();
  const deadline = Date.now() + PAGE_BOUND_MS;
  while (Date.now() < deadline) {
    if (await marker.count() > 0 && await marker.isVisible().catch(() => false)) {
      return (await marker.innerText().catch(() => 'Notifications')).trim();
    }

    // The section is behind the real settings navigation in the Web surface.
    // Use accessible roles first; the selector fallback only covers the icon
    // button whose accessible name is supplied by a tooltip in some builds.
    for (const role of ['button', 'link']) {
      const settings = page.getByRole(role, { name: /settings/i }).first();
      if (await settings.count() > 0 && await settings.isVisible().catch(() => false)) {
        await settings.click({ timeout: 2_000 }).catch(() => {});
        break;
      }
    }
    const iconSettings = page.locator('[aria-label*="settings" i], [title*="settings" i]').first();
    if (await iconSettings.count() > 0 && await iconSettings.isVisible().catch(() => false)) {
      await iconSettings.click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
  }
  return null;
}

const started = performance.now();
const output = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const httpErrors = [];
let server;
let browser;
let result;

try {
  if (SPEC === '') throw new Error('browser probe: no subject spec');

  server = spawn('dsh', ['--profile', 'web', '--no-open', '--port', String(PORT)], {
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(String(chunk)));
  server.stderr.on('data', (chunk) => output.push(String(chunk)));

  const startupUrl = await waitForStartup(server, output);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(safeText(message.text()));
  });
  page.on('pageerror', (error) => pageErrors.push(safeText(error.message)));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${safeUrl(request.url())}: ${safeText(request.failure()?.errorText ?? 'request failed')}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.request().method()} ${safeUrl(response.url())}`);
  });

  await page.goto(startupUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_BOUND_MS });
  const markerText = await visibleMarker(page);
  result = {
    status: markerText && consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0 && httpErrors.length === 0 ? 'pass' : 'fail',
    browserClientActivated: Boolean(markerText),
    markerText,
    startupUrl: safeUrl(startupUrl),
    finalUrl: safeUrl(page.url()),
    title: await page.title().catch(() => ''),
    consoleErrors,
    pageErrors,
    failedRequests,
    httpErrors,
    durationMs: Math.round(performance.now() - started),
  };
} catch (error) {
  result = {
    status: 'inconclusive',
    browserClientActivated: false,
    markerText: null,
    startupUrl: null,
    finalUrl: null,
    title: '',
    consoleErrors,
    pageErrors,
    failedRequests,
    httpErrors,
    diagnostics: safeText(error?.stack ?? error),
    webOutput: safeText(output.join('')),
    durationMs: Math.round(performance.now() - started),
  };
}

try { await browser?.close(); } catch {}
if (server && server.exitCode === null) server.kill('SIGTERM');
writeResult({ spec: SPEC, ...result });
process.exitCode = result.status === 'pass' ? 0 : 1;
