#!/usr/bin/env node
/**
 * Toolchain detector for the 노동자의 지갑 monorepo.
 *
 * Probes the host machine for every external dependency the apps need
 * (Node, pnpm, Rust toolchain for Tauri, JDK + Android SDK for React
 * Native, Xcode for iOS), prints a coloured table summarising what is
 * installed and what is missing, and exits 0 even on missing tools so
 * the script can be safely chained from CI (`pnpm setup-check`).
 *
 * Why a standalone script rather than per-app shell snippets: each
 * platform (Windows/macOS/Linux) phrases its detection commands
 * differently, and Tauri/RN error messages assume tooling is present.
 * This gives a single source of truth, in plain JS that runs on any
 * OS that already has Node ≥ 20.
 */

import { spawnSync } from 'node:child_process';
import { platform } from 'node:process';

/* ------------------------------------------------------------------ */
/* ANSI colours — degrade gracefully when stdout is not a TTY.        */
/* ------------------------------------------------------------------ */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : s);
const green = c('32');
const red = c('31');
const yellow = c('33');
const cyan = c('36');
const dim = c('2');
const bold = c('1');

/* ------------------------------------------------------------------ */
/* Probe definitions.                                                  */
/*                                                                     */
/* Each probe runs `cmd args...`, captures stdout+stderr, and feeds    */
/* the combined output to `extract` which returns a version string or  */
/* null. A probe is considered "installed" iff `extract` returns       */
/* non-null AND the process exit code is 0 (some tools — looking at    */
/* you, `java -version` — print to stderr but still exit 0).           */
/* ------------------------------------------------------------------ */
const probes = [
  {
    key: 'node',
    label: 'Node.js',
    cmd: 'node',
    args: ['-v'],
    requiredBy: ['everything'],
    minNote: '>= 20.10',
    extract: (out) => out.match(/v[\d.]+/)?.[0],
  },
  {
    key: 'pnpm',
    label: 'pnpm',
    cmd: 'pnpm',
    args: ['-v'],
    requiredBy: ['everything'],
    minNote: '>= 9',
    extract: (out) => out.match(/[\d]+\.[\d]+\.[\d]+/)?.[0],
  },
  {
    key: 'rustc',
    label: 'rustc',
    cmd: 'rustc',
    args: ['--version'],
    requiredBy: ['apps/desktop (Tauri)'],
    minNote: '>= 1.77',
    extract: (out) => out.match(/rustc\s+([\d.]+)/)?.[1],
  },
  {
    key: 'cargo',
    label: 'cargo',
    cmd: 'cargo',
    args: ['--version'],
    requiredBy: ['apps/desktop (Tauri)'],
    extract: (out) => out.match(/cargo\s+([\d.]+)/)?.[1],
  },
  {
    key: 'java',
    label: 'java (JDK)',
    cmd: 'java',
    args: ['-version'],
    requiredBy: ['apps/mobile (Android)'],
    minNote: '>= 17',
    // java prints to stderr; the combined-output extractor catches both.
    extract: (out) => out.match(/version "([\d._]+)"/)?.[1],
  },
  {
    key: 'javac',
    label: 'javac (JDK)',
    cmd: 'javac',
    args: ['-version'],
    requiredBy: ['apps/mobile (Android)'],
    minNote: '>= 17',
    extract: (out) => out.match(/javac\s+([\d._]+)/)?.[1],
  },
  {
    key: 'JAVA_HOME',
    label: '$JAVA_HOME',
    envVar: 'JAVA_HOME',
    requiredBy: ['apps/mobile (Android)'],
  },
  {
    key: 'ANDROID_HOME',
    label: '$ANDROID_HOME',
    envVar: 'ANDROID_HOME',
    requiredBy: ['apps/mobile (Android)'],
  },
  {
    key: 'adb',
    label: 'adb',
    cmd: 'adb',
    args: ['--version'],
    requiredBy: ['apps/mobile (Android)'],
    extract: (out) => out.match(/version\s+([\d.]+)/)?.[1],
  },
  {
    key: 'gradle',
    label: 'gradle (optional)',
    cmd: 'gradle',
    args: ['-v'],
    requiredBy: ['apps/mobile (only if not using gradle-wrapper)'],
    optional: true,
    extract: (out) => out.match(/Gradle\s+([\d.]+)/)?.[1],
  },
  {
    key: 'xcrun',
    label: 'xcrun (Xcode)',
    cmd: 'xcrun',
    args: ['--version'],
    requiredBy: ['apps/mobile (iOS, macOS only)'],
    platforms: ['darwin'],
    extract: (out) => out.match(/xcrun\s+version\s+([\d.]+)/)?.[1],
  },
  {
    key: 'pod',
    label: 'CocoaPods',
    cmd: 'pod',
    args: ['--version'],
    requiredBy: ['apps/mobile (iOS, macOS only)'],
    platforms: ['darwin'],
    extract: (out) => out.match(/[\d.]+/)?.[0],
  },
  {
    key: 'choco',
    label: 'choco (Windows pkg mgr)',
    cmd: 'choco',
    args: ['--version'],
    optional: true,
    platforms: ['win32'],
    // Require at least one digit so a bogus zero-output exit-0 (which
    // can happen when the shell resolves `choco` to a no-op .bat) does
    // not get reported as installed.
    extract: (out) => out.match(/\d+\.\d+(?:\.\d+)?/)?.[0],
  },
  {
    key: 'scoop',
    label: 'scoop (Windows pkg mgr)',
    cmd: 'scoop',
    args: ['--version'],
    optional: true,
    platforms: ['win32'],
    extract: (out) => out.match(/[a-f0-9]{6,}/)?.[0],
  },
  {
    key: 'brew',
    label: 'brew (macOS pkg mgr)',
    cmd: 'brew',
    args: ['--version'],
    optional: true,
    platforms: ['darwin'],
    extract: (out) => out.match(/Homebrew\s+([\d.]+)/)?.[1],
  },
];

/* ------------------------------------------------------------------ */
/* Probe runner.                                                       */
/*                                                                     */
/* spawnSync with shell:true is necessary on Windows because `cargo`   */
/* etc. are .cmd shims that PowerShell resolves but raw exec() does    */
/* not. We swallow errors — ENOENT just means "not installed".         */
/* ------------------------------------------------------------------ */
function run(cmd, args) {
  try {
    // Concatenating cmd+args into a single string and using shell:true is
    // the only portable way to invoke .cmd / .bat shims on Windows from
    // Node without bumping into ENOENT or the spawn-args-with-shell
    // deprecation warning (DEP0190). All callers control `args` so
    // there's no untrusted-input concern.
    const cmdline = [cmd, ...args].join(' ');
    const res = spawnSync(cmdline, {
      shell: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.error) return { ok: false, out: '', code: -1 };
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    return { ok: res.status === 0, out, code: res.status ?? -1 };
  } catch {
    return { ok: false, out: '', code: -1 };
  }
}

function probeOne(p) {
  // Platform-gated probe — skip rather than mark missing.
  if (p.platforms && !p.platforms.includes(platform)) {
    return { status: 'skipped', value: `n/a on ${platform}` };
  }
  if (p.envVar) {
    const v = process.env[p.envVar];
    return v
      ? { status: 'ok', value: v }
      : { status: p.optional ? 'optional' : 'missing', value: null };
  }
  const r = run(p.cmd, p.args);
  if (!r.ok && !r.out) {
    return { status: p.optional ? 'optional' : 'missing', value: null };
  }
  const version = p.extract ? p.extract(r.out) : r.out.split('\n')[0];
  if (!version) {
    return { status: p.optional ? 'optional' : 'missing', value: null };
  }
  return { status: 'ok', value: version };
}

/* ------------------------------------------------------------------ */
/* Reporter                                                            */
/* ------------------------------------------------------------------ */
function tagFor(status) {
  switch (status) {
    case 'ok':
      return green('[OK]      ');
    case 'missing':
      return red('[MISSING] ');
    case 'optional':
      return yellow('[OPTIONAL]');
    case 'skipped':
      return dim('[SKIPPED] ');
    default:
      return dim('[?]       ');
  }
}

function main() {
  console.log(bold(cyan('\n노동자의 지갑 — toolchain probe')));
  console.log(dim(`platform: ${platform}    node: ${process.version}\n`));

  const results = probes.map((p) => ({ probe: p, result: probeOne(p) }));

  const labelW = Math.max(...probes.map((p) => p.label.length));
  const versionW = 22;

  for (const { probe, result } of results) {
    const tag = tagFor(result.status);
    const label = probe.label.padEnd(labelW);
    const versionRaw = result.value ?? '—';
    const versionTrunc = versionRaw.length > versionW ? versionRaw.slice(0, versionW - 1) + '…' : versionRaw;
    const version = versionTrunc.padEnd(versionW);
    const note =
      result.status === 'missing'
        ? red(`required for ${probe.requiredBy?.join(', ') ?? '?'}`)
        : result.status === 'optional'
          ? dim(`optional (${probe.requiredBy?.join(', ') ?? '—'})`)
          : probe.minNote
            ? dim(`(need ${probe.minNote})`)
            : '';
    console.log(`  ${tag}  ${label}  ${dim(version)}  ${note}`);
  }

  /* Summary. */
  const missing = results.filter((r) => r.result.status === 'missing');
  const ok = results.filter((r) => r.result.status === 'ok').length;
  const total = results.length;
  console.log('');
  console.log(bold('Summary:'), `${ok}/${total} present`);

  if (missing.length === 0) {
    console.log(green('All required tooling detected. You can build everything from this machine.'));
  } else {
    console.log(yellow('Missing — what each unlocks:'));
    /* Group by feature gate. */
    const gates = new Set();
    for (const m of missing) for (const g of m.probe.requiredBy ?? []) gates.add(g);
    for (const g of gates) {
      const tools = missing.filter((m) => m.probe.requiredBy?.includes(g)).map((m) => m.probe.label);
      console.log(`  - ${g}: install ${tools.join(', ')}`);
    }
    console.log(dim('See docs/SETUP.md for install commands.'));
  }
  console.log('');
}

main();
