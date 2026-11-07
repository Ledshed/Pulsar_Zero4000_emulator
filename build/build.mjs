#!/usr/bin/env node
/*
 * Builds double-click executables of the Pulsar Zero 4000 emulator for Windows, macOS and Linux
 * using Node's Single Executable Applications feature.
 *
 *   npm install
 *   npm run build                 # all platforms
 *   npm run build -- win mac      # just some
 *
 * Output (dist/):
 *   PulsarZero4000-Windows.zip     Pulsar Zero 4000.exe + READ ME FIRST.txt
 *   PulsarZero4000-Mac.zip         Pulsar Zero 4000.app (Apple Silicon + Intel) + READ ME FIRST.txt
 *   PulsarZero4000-Linux.tar.gz    pulsar-zero4000 + READ ME FIRST.txt
 *
 * Needs: Node 22+ (the build uses the SAME Node version for every target), tar, unzip, zip.
 * macOS binaries must be (ad-hoc) code-signed to run on Apple Silicon: on a Mac this uses `codesign`,
 * elsewhere it downloads `rcodesign` (Linux x64 only).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const CACHE = path.join(BUILD, '.cache');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'work');
const NODE_V = process.version;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = PKG.version;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const RCODESIGN_V = '0.29.0';

const want = process.argv.slice(2);
const targets = want.length ? want : ['win', 'win7', 'mac', 'linux'];
const WIN7_NODE = 'v13.14.0'; // last Node release that supports Windows 7 / 8 / 8.1

const run = (cmd, args, opts = {}) => { console.log('  $', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', ...opts }); };
const bin = name => path.join(ROOT, 'node_modules', '.bin', name);
const mkdirp = d => fs.mkdirSync(d, { recursive: true });
const rmrf = d => fs.rmSync(d, { recursive: true, force: true });

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  console.log('  ↓', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  mkdirp(path.dirname(dest));
  fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
  return dest;
}

async function nodeBinary(platform, arch, version = NODE_V) {
  const base = `node-${version}-${platform}-${arch}`;
  const dir = path.join(CACHE, base);
  const exe = platform === 'win' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
  if (fs.existsSync(exe)) return exe;
  const ext = platform === 'win' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz';
  const archive = await download(`https://nodejs.org/dist/${version}/${base}.${ext}`, path.join(CACHE, `${base}.${ext}`));
  if (ext === 'zip') run('unzip', ['-q', '-o', archive, `${base}/node.exe`, '-d', CACHE]);
  else run('tar', ['-xf', archive, '-C', CACHE, `${base}/bin/node`]);
  return exe;
}

async function rcodesign() {
  const exe = path.join(CACHE, 'rcodesign', 'rcodesign');
  if (fs.existsSync(exe)) return exe;
  if (!(process.platform === 'linux' && process.arch === 'x64')) throw new Error('Mac signing needs a Mac (codesign) or Linux x64 (rcodesign).');
  const name = `apple-codesign-${RCODESIGN_V}-x86_64-unknown-linux-musl`;
  const tgz = await download(`https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_V}/${name}.tar.gz`, path.join(CACHE, `${name}.tar.gz`));
  mkdirp(path.dirname(exe));
  run('tar', ['-xzf', tgz, '-C', path.dirname(exe), '--strip-components=1', `${name}/rcodesign`]);
  return exe;
}

async function adhocSign(file) {
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', file]);
  else run(await rcodesign(), ['sign', file]);
}

/* ---------- 1. bundle + SEA blob (platform independent: no code cache, no snapshot) ---------- */
function prepareBlob() {
  console.log('\n▶ Bundling app');
  rmrf(WORK); mkdirp(WORK);
  run(bin('esbuild'), [path.join(ROOT, 'server.js'), '--bundle', '--platform=node', '--format=cjs', '--target=node22',
    `--outfile=${path.join(WORK, 'app.cjs')}`, '--log-level=warning']);
  const assets = {};
  const walk = (dir, rel) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f), r = rel ? `${rel}/${f}` : f;
      if (fs.statSync(p).isDirectory()) walk(p, r); else assets[`public/${r}`] = p;
    }
  };
  walk(path.join(ROOT, 'public'), '');
  const cfg = { main: path.join(WORK, 'app.cjs'), output: path.join(WORK, 'sea-prep.blob'), disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, assets };
  fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify(cfg, null, 2));
  run(process.execPath, ['--experimental-sea-config', path.join(WORK, 'sea-config.json')]);
  console.log(`  ${Object.keys(assets).length} page files embedded`);
  return cfg.output;
}

function inject(exe, blob, macho) {
  const a = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
  if (macho) a.push('--macho-segment-name', 'NODE_SEA');
  run(bin('postject'), a, { stdio: ['ignore', 'ignore', 'inherit'] });
}

const readme = os => fs.readFileSync(path.join(BUILD, `README-${os}.txt`), 'utf8').replaceAll('{{VERSION}}', APP_VERSION);

/* ---------- 2. per platform ---------- */
async function buildWin(blob) {
  console.log('\n▶ Windows (x64)');
  const out = path.join(WORK, 'win'); rmrf(out); mkdirp(out);
  const exe = path.join(out, 'Pulsar Zero 4000.exe');
  // Icon + version info first (this drops Node's own signature), then inject the app.
  run(bin('resedit'), ['--in', await nodeBinary('win', 'x64'), '--out', exe, '--ignore-signed',
    '--icon', `1,${path.join(BUILD, 'icon.ico')}`,
    '--product-name', 'Pulsar Zero 4000', '--file-description', 'Pulsar Zero 4000 emulator',
    '--original-filename', 'Pulsar Zero 4000.exe', '--internal-name', 'pulsar-zero4000',
    '--company-name', 'Pulsar Zero 4000 emulator', '--legal-copyright', 'Emulation software; Pulsar is a trademark of its owner',
    '--product-version', `${APP_VERSION}.0`, '--file-version', `${APP_VERSION}.0`]);
  inject(exe, blob, false);
  fs.writeFileSync(path.join(out, 'READ ME FIRST.txt'), readme('Windows').replace(/\n/g, '\r\n'));
  const zip = path.join(DIST, 'PulsarZero4000-Windows.zip'); rmrf(zip);
  run('zip', ['-q', '-r', '-9', zip, '.'], { cwd: out });
}

/*
 * Windows 7 / 8 / 8.1: Node 22 needs Windows 10 (it imports GetSystemTimePreciseAsFileTime, which Windows 7 lacks).
 * This build uses Node 13.14 (last version supporting Windows 7) as a "runtime" folder, plus a small launcher .exe
 * compiled with mingw-w64 that uses only Windows XP-era APIs. It also runs on Windows 10/11.
 */
async function buildWin7() {
  console.log('\n▶ Windows 7 / 8 (x64, Node ' + WIN7_NODE + ')');
  const cc = 'x86_64-w64-mingw32-gcc', rc = 'x86_64-w64-mingw32-windres';
  try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); } catch (_) {
    console.log('  ! skipped: needs mingw-w64 (Debian/Ubuntu: apt install gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64)');
    return;
  }
  const out = path.join(WORK, 'win7'); rmrf(out);
  const top = path.join(out, 'Pulsar Zero 4000'), rt = path.join(top, 'runtime');
  mkdirp(rt);
  run(bin('esbuild'), [path.join(ROOT, 'server.js'), '--bundle', '--platform=node', '--format=cjs', '--target=node13',
    `--outfile=${path.join(rt, 'app.js')}`, '--log-level=warning']);
  fs.cpSync(path.join(ROOT, 'public'), path.join(rt, 'public'), { recursive: true });
  // The engine (Node 13) gets Pulsar's name and icon, so the Windows Firewall pop-up and Task Manager say
  // "Pulsar Zero 4000" instead of "Node.js: Server-side JavaScript".
  run(bin('resedit'), ['--in', await nodeBinary('win', 'x64', WIN7_NODE), '--out', path.join(rt, 'pulsar-zero4000-engine.exe'), '--ignore-signed',
    '--icon', `1,${path.join(BUILD, 'icon.ico')}`,
    '--product-name', 'Pulsar Zero 4000', '--file-description', 'Pulsar Zero 4000',
    '--original-filename', 'pulsar-zero4000-engine.exe', '--internal-name', 'pulsar-zero4000-engine',
    '--company-name', 'Pulsar Zero 4000 emulator', '--legal-copyright', 'Engine: Node.js 13.14 (MIT licence)',
    '--product-version', `${APP_VERSION}.0`, '--file-version', `${APP_VERSION}.0`]);
  // launcher: icon, version info and manifest as resources
  const [v1, v2, v3] = APP_VERSION.split('.');
  const src = path.join(BUILD, 'win7');
  const rcText = fs.readFileSync(path.join(src, 'launcher.rc'), 'utf8')
    .replaceAll('@V1@', v1).replaceAll('@V2@', v2).replaceAll('@V3@', v3).replaceAll('@VERSION@', APP_VERSION)
    .replace('"../icon.ico"', JSON.stringify(path.join(BUILD, 'icon.ico')))
    .replace('"launcher.manifest"', JSON.stringify(path.join(src, 'launcher.manifest')));
  const tmpRc = path.join(WORK, 'launcher.rc'), res = path.join(WORK, 'launcher.res');
  fs.writeFileSync(tmpRc, rcText);
  run(rc, [tmpRc, '-O', 'coff', '-o', res]);
  run(cc, ['-O2', '-municode', '-mconsole', '-s', '-D_WIN32_WINNT=0x0601', '-o', path.join(top, 'Pulsar Zero 4000.exe'),
    path.join(src, 'launcher.c'), res, '-static-libgcc']);
  fs.writeFileSync(path.join(top, 'READ ME FIRST.txt'), readme('Windows7').replace(/\n/g, '\r\n'));
  const zip = path.join(DIST, 'PulsarZero4000-Windows7.zip'); rmrf(zip);
  run('zip', ['-q', '-r', '-9', zip, 'Pulsar Zero 4000'], { cwd: out });
}

async function buildMac(blob) {
  console.log('\n▶ macOS (Apple Silicon + Intel, one app)');
  const out = path.join(WORK, 'mac'); rmrf(out);
  const app = path.join(out, 'Pulsar Zero 4000.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  const res = path.join(app, 'Contents', 'Resources');
  mkdirp(macos); mkdirp(res);
  for (const arch of ['arm64', 'x64']) {
    const exe = path.join(macos, `pulsar-zero4000-${arch}`);
    fs.copyFileSync(await nodeBinary('darwin', arch), exe);
    fs.chmodSync(exe, 0o755);
    inject(exe, blob, true);
    await adhocSign(exe); // required for Apple Silicon to run it at all
  }
  // The app's main executable is a tiny launcher: it starts the emulator in the background and exits,
  // so double-clicking the app again opens another browser tab instead of doing nothing.
  const launcher = path.join(macos, 'launcher');
  fs.writeFileSync(launcher, `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then BIN="$DIR/pulsar-zero4000-arm64"; else BIN="$DIR/pulsar-zero4000-x64"; fi
LOG="$HOME/Library/Logs/Pulsar Zero 4000.log"
mkdir -p "$HOME/Library/Logs"
nohup "$BIN" "$@" >>"$LOG" 2>&1 &
exit 0
`);
  fs.chmodSync(launcher, 0o755);
  fs.copyFileSync(path.join(BUILD, 'icon.icns'), path.join(res, 'icon.icns'));
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Pulsar Zero 4000</string>
  <key>CFBundleDisplayName</key><string>Pulsar Zero 4000</string>
  <key>CFBundleIdentifier</key><string>io.github.pulsar-zero4000.emulator</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
  fs.writeFileSync(path.join(out, 'READ ME FIRST.txt'), readme('Mac'));
  const zip = path.join(DIST, 'PulsarZero4000-Mac.zip'); rmrf(zip);
  run('zip', ['-q', '-r', '-y', '-9', zip, '.'], { cwd: out });
}

async function buildLinux(blob) {
  console.log('\n▶ Linux (x64)');
  const out = path.join(WORK, 'linux', 'pulsar-zero4000'); rmrf(path.dirname(out)); mkdirp(out);
  const exe = path.join(out, 'pulsar-zero4000');
  fs.copyFileSync(await nodeBinary('linux', 'x64'), exe);
  fs.chmodSync(exe, 0o755);
  inject(exe, blob, false);
  fs.copyFileSync(path.join(BUILD, 'icon.png'), path.join(out, 'icon.png'));
  fs.writeFileSync(path.join(out, 'READ ME FIRST.txt'), readme('Linux'));
  const tgz = path.join(DIST, 'PulsarZero4000-Linux.tar.gz'); rmrf(tgz);
  run('tar', ['--owner=0', '--group=0', '-czf', tgz, '-C', path.dirname(out), 'pulsar-zero4000']);
}

/* ---------- main ---------- */
const major = +NODE_V.slice(1).split('.')[0];
if (major < 22) { console.error('Build with Node 22 or newer.'); process.exit(1); }
console.log(`Pulsar Zero 4000 ${APP_VERSION} — building with Node ${NODE_V} for: ${targets.join(', ')}`);
mkdirp(DIST);
run(process.execPath, [path.join(ROOT, 'test', 'ui-ids-test.js')]); // page/script consistency check
run(process.execPath, [path.join(ROOT, 'test', 'emulator-test.js')]); // behaviour checked against the schematic
const blob = prepareBlob();
if (targets.includes('win')) await buildWin(blob);
if (targets.includes('win7')) await buildWin7();
if (targets.includes('mac')) await buildMac(blob);
if (targets.includes('linux')) await buildLinux(blob);
console.log('\n✔ Done:');
for (const f of fs.readdirSync(DIST)) if (!fs.statSync(path.join(DIST, f)).isDirectory()) console.log(`  dist/${f}  ${(fs.statSync(path.join(DIST, f)).size / 1048576).toFixed(1)} MB`);
