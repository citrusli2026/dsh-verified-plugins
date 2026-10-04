#!/usr/bin/env node
/**
 * fixtures.mjs — execute the first-party plugin matrix against the real DSH CLI.
 *
 * This is deliberately an integration acceptance, not a unit test of the
 * report classifier. It runs dsh plugin add/remove and a real profile boot for
 * each fixture, then checks artifacts produced by the running fixture: profile
 * layers, an activation marker, a blocked build marker, a boot timeout, live
 * filesystem watchers, and an uninstall residue file.
 *
 * The CI caller runs this file in the same one-off, network-denied verifier
 * container used for the execution tier. The fixtures are authored here and
 * are therefore permitted by AGENTS.md; no third-party package is executed.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = process.env.FIXTURE_ROOT ?? '/work/fixture-plugins';
const SAMPLER = process.env.FIXTURE_SAMPLER ?? '/work/host-sampler.mjs';
const OUT = process.env.FIXTURE_ACCEPTANCE_OUT ?? '';
const WORK = mkdtempSync(join(tmpdir(), 'dsh-fixture-acceptance-'));
const cases = [];

function clean(text, max = 1024) {
  const value = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  if (Buffer.byteLength(value, 'utf8') <= max) return value;
  return `…(trimmed)…\n${value.slice(-max)}`;
}

function runDsh(home, args, extraEnv = {}, timeout = 30_000) {
  const caseHome = join(home, 'process-home');
  mkdirSync(caseHome, { recursive: true });
  const safeEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
  };
  const result = spawnSync('dsh', args, {
    cwd: WORK,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...safeEnv,
      DSH_HOME: home,
      HOME: caseHome,
      XDG_CONFIG_HOME: join(caseHome, '.config'),
      NPM_CONFIG_USERCONFIG: join(caseHome, 'missing.npmrc'),
      CI: '1',
      ...extraEnv,
    },
  });
  return {
    args: args.map((arg) => arg.replaceAll(FIXTURE_ROOT, '<fixtures>')),
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || result.signal === 'SIGKILL',
    output: clean(`${result.stdout ?? ''}${result.stderr ?? ''}`)
      .replaceAll(FIXTURE_ROOT, '<fixtures>')
      .replaceAll(WORK, '<temp>'),
  };
}

function profile(home) {
  const dir = join(home, 'profiles', 'verify');
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return { dir, packageJson: null };
  try {
    return { dir, packageJson: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { dir, packageJson: null };
  }
}

function bundleNames(home) {
  return profile(home).packageJson?.dsh?.profile?.bundles ?? [];
}

function fixture(name) {
  return join(FIXTURE_ROOT, name);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function record(name, checks, commands) {
  cases.push({ name, status: 'pass', checks, commands });
}

function newCase(name) {
  const dir = join(WORK, name);
  const home = join(dir, 'dsh-home');
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

function add(home, name, env = {}) {
  return runDsh(home, ['plugin', '--profile', 'verify', 'add', fixture(name)], env, 30_000);
}

function remove(home, packageName) {
  return runDsh(home, ['plugin', '--profile', 'verify', 'remove', packageName], {}, 30_000);
}

function boot(home, env = {}, timeout = 8_000) {
  return runDsh(home, ['--profile', 'verify'], env, timeout);
}

function normal() {
  const { home, dir } = newCase('normal');
  const marker = join(dir, 'activated.txt');
  const addResult = add(home, 'normal');
  expect(addResult.exitCode === 0, `normal add failed: ${addResult.output}`);
  expect(bundleNames(home).includes('dsh-fixture-normal'), 'normal bundle was not selected');
  const bootResult = boot(home, { FIXTURE_ACTIVATION_PATH: marker });
  expect(existsSync(marker), 'normal fixture did not execute during profile boot');
  const removeResult = remove(home, 'dsh-fixture-normal');
  expect(removeResult.exitCode === 0, `normal remove failed: ${removeResult.output}`);
  expect(!bundleNames(home).includes('dsh-fixture-normal'), 'normal bundle remains after removal');
  record('normal', { addExit: addResult.exitCode, bootObserved: true, removeExit: removeResult.exitCode }, [addResult, bootResult, removeResult]);
}

function missingManifest() {
  const { home } = newCase('missing-manifest');
  const addResult = add(home, 'missing-manifest');
  expect(addResult.exitCode === 0, `missing-manifest add failed: ${addResult.output}`);
  expect(!bundleNames(home).includes('dsh-fixture-missing-manifest'), 'bundle-less fixture was composed');
  expect(/declares no dsh\.bundle|plain dependency/i.test(addResult.output), 'missing-manifest warning was not observed');
  const removeResult = remove(home, 'dsh-fixture-missing-manifest');
  expect(removeResult.exitCode === 0, `missing-manifest remove failed: ${removeResult.output}`);
  record('missing-manifest', { addExit: addResult.exitCode, composed: false, removeExit: removeResult.exitCode }, [addResult, removeResult]);
}

function peerIncompatible() {
  const { home } = newCase('peer-incompatible');
  const addResult = add(home, 'peer-incompatible');
  expect(addResult.exitCode !== 0, 'peer-incompatible fixture unexpectedly installed');
  expect(/incompatible|peer/i.test(addResult.output), `peer refusal was not reported: ${addResult.output}`);
  expect(!bundleNames(home).includes('dsh-fixture-peer-incompatible'), 'peer-incompatible bundle was selected');
  record('peer-incompatible', { addExit: addResult.exitCode, refusalObserved: true }, [addResult]);
}

function buildScriptPending() {
  const { home, dir } = newCase('build-script');
  const marker = join(dir, 'postinstall-ran.txt');
  const addResult = add(home, 'build-script', { FIXTURE_BUILD_MARKER: marker });
  expect(addResult.exitCode === 0, `build-script add failed: ${addResult.output}`);
  expect(!existsSync(marker), 'build script executed without an approval decision');
  expect(/Ignored build scripts|build script|approve/i.test(addResult.output), `pending build script was not visible: ${addResult.output}`);
  expect(bundleNames(home).includes('dsh-fixture-build-script'), 'build-script bundle was not selected');
  const removeResult = remove(home, 'dsh-fixture-build-script');
  expect(removeResult.exitCode === 0, `build-script remove failed: ${removeResult.output}`);
  record('build-script-pending', { addExit: addResult.exitCode, buildScriptExecuted: false, removeExit: removeResult.exitCode }, [addResult, removeResult]);
}

function deadLoop() {
  const { home, dir } = newCase('dead-loop');
  const marker = join(dir, 'activated.txt');
  const addResult = add(home, 'dead-loop');
  expect(addResult.exitCode === 0, `dead-loop add failed: ${addResult.output}`);
  const bootResult = boot(home, { FIXTURE_ACTIVATION_PATH: marker }, 2_000);
  expect(bootResult.timedOut, `dead-loop boot did not hit the bound: ${JSON.stringify(bootResult)}`);
  expect(!existsSync(marker), 'dead-loop reached code after the blocking loop');
  const removeResult = remove(home, 'dsh-fixture-dead-loop');
  expect(removeResult.exitCode === 0, `dead-loop remove failed: ${removeResult.output}`);
  record('dead-loop', { addExit: addResult.exitCode, bootTimedOut: true, removeExit: removeResult.exitCode }, [addResult, bootResult, removeResult]);
}

function watcherMedian(sample) {
  const values = (sample.samples ?? []).map((row) => row.watchers).filter((value) => typeof value === 'number').sort((a, b) => a - b);
  return values.length === 0 ? null : values[Math.floor(values.length / 2)];
}

function recursiveWatcher() {
  const { home, dir } = newCase('recursive-watcher');
  const marker = join(dir, 'activated.txt');
  const sample = join(dir, 'sample.json');
  const tree = join(dir, 'tree');
  for (let i = 0; i < 40; i++) mkdirSync(join(tree, `d${i}`), { recursive: true });
  const addResult = add(home, 'recursive-watcher');
  expect(addResult.exitCode === 0, `recursive-watcher add failed: ${addResult.output}`);
  const bootResult = boot(home, {
    FIXTURE_ACTIVATION_PATH: marker,
    FIXTURE_WATCH_ROOT: tree,
    NODE_OPTIONS: `--import ${SAMPLER}`,
    SAMPLE_OUT: sample,
    SAMPLER_T0: String(Date.now()),
    SAMPLE_SETTLE_MS: '1000',
    SAMPLE_COUNT: '3',
    SAMPLE_INTERVAL_MS: '200',
  }, 10_000);
  expect(existsSync(marker), 'recursive-watcher fixture did not execute');
  expect(existsSync(sample), `watcher sampler produced no sample: ${bootResult.output}`);
  const parsed = JSON.parse(readFileSync(sample, 'utf8'));
  const median = watcherMedian(parsed);
  expect(median !== null && median >= 10, `watcher anomaly was not observed: median=${median}`);
  const removeResult = remove(home, 'dsh-fixture-recursive-watcher');
  expect(removeResult.exitCode === 0, `recursive-watcher remove failed: ${removeResult.output}`);
  record('recursive-watcher', { addExit: addResult.exitCode, watcherMedian: median, watchedDirectories: 40, removeExit: removeResult.exitCode }, [addResult, bootResult, removeResult]);
}

function unloadResidue() {
  const { home, dir } = newCase('unload-residue');
  const marker = join(dir, 'activated.txt');
  const residue = join(profile(home).dir, 'fixture-residue.txt');
  const addResult = add(home, 'unload-residue');
  expect(addResult.exitCode === 0, `unload-residue add failed: ${addResult.output}`);
  const bootResult = boot(home, { FIXTURE_ACTIVATION_PATH: marker, FIXTURE_RESIDUE_PATH: residue });
  expect(existsSync(marker), 'unload-residue fixture did not execute');
  expect(existsSync(residue), 'unload-residue fixture did not create its residue');
  const removeResult = remove(home, 'dsh-fixture-unload-residue');
  expect(removeResult.exitCode === 0, `unload-residue remove failed: ${removeResult.output}`);
  expect(existsSync(residue), 'uninstall incorrectly removed the fixture residue');
  record('unload-residue', { addExit: addResult.exitCode, residueObservedBeforeAndAfterRemove: true, removeExit: removeResult.exitCode }, [addResult, bootResult, removeResult]);
}

let failure = null;
try {
  normal();
  missingManifest();
  peerIncompatible();
  buildScriptPending();
  deadLoop();
  recursiveWatcher();
  unloadResidue();
} catch (error) {
  failure = String(error instanceof Error ? error.message : error);
}

const report = {
  schema: 'dsh.verifier.fixture-acceptance.v1',
  dshVersion: runDsh(join(WORK, 'version-home'), ['--version']).output.trim().split('\n').pop() ?? 'unknown',
  cases,
  failure,
};
if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
rmSync(WORK, { recursive: true, force: true });

if (failure) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
