# Pulsar Zero 4000 emulator

A software version of the 1980 Pulsar Zero 4000 four-channel sound-to-light chaser, built from the
original circuit drawings (RJM, Oct/Nov 1980). The front panel is drawn on screen, and the four
channels are sent out as **sACN (E1.31)** and/or **DDP**.

## For end users: the ready-made downloads
Tests: `npm test` (page/script element check and the schematic checks), and against a running copy with a
fresh settings folder `node test/core-test.js beat.wav`
(audio in → sACN/DDP out), `node test/security-test.js` and `node test/audio-robustness-test.js`.

Run `npm run build` (see **Building** below) to produce three downloads in `dist/`:

| Download | What's inside | How to start it |
|---|---|---|
| `PulsarZero4000-Windows.zip` | `Pulsar Zero 4000.exe` (Windows 10/11) | Double-click. Leave the small black window open while it runs. |
| `PulsarZero4000-Windows7.zip` | `Pulsar Zero 4000.exe` + `runtime` folder (Windows 7/8/8.1, also runs on 10/11) | Unzip the whole folder and double-click the .exe. |
| `PulsarZero4000-Mac.zip` | `Pulsar Zero 4000.app` (works on Apple Silicon and Intel) | Drag it to Applications and double-click. It runs in the background; use Unit ▸ Quit to stop it. |
| `PulsarZero4000-Linux.tar.gz` | `pulsar-zero4000` | `./pulsar-zero4000` |

Each download includes a `READ ME FIRST.txt`. It explains the one-time security warning: the
programs aren't code-signed, so Windows shows "Windows protected your PC" and macOS shows
"Apple could not verify…".

There is nothing to install. The browser opens on the front panel automatically. Settings are saved in
the user's app-data folder (`%APPDATA%\Pulsar Zero 4000`, `~/Library/Application Support/Pulsar Zero 4000`
or `~/.config/pulsar-zero4000`).

## Several units at once
One running program can host as many units as you like. Use **Unit ▸ ＋ Add unit** to open another
Zero 4000 in a new browser tab. Each unit has its own name, panel settings, audio source and filters,
and outputs. New units start on the next free sACN universe. A red **⚠ overlaps another unit** warning
appears if two units drive the same sACN addresses or the same DDP pixels. Starting the program again
while it's running just opens another browser tab, and it switches to the next port if 8040 is
taken. Units live at `http://localhost:8040/u/<n>/`.

## Security
The emulator controls lights and listens for browser connections, so it defends itself:

* **Network exposure:** it only listens on `127.0.0.1` (this computer).
* **Other websites in your browser:** binding to localhost alone doesn't stop a web page from trying to
  connect, so every connection must pass three checks:
  * The **Host header** must be a name that means this computer (`localhost`, `127.0.0.1` or this
    computer's own IP address, on this port). This blocks DNS-rebinding attacks.
  * The **Origin** must be this app's own page.
  * It must carry a **random per-run token**. The server puts the token into its own page, where only
    same-origin scripts can read it.
  "Add unit" (`/new`) needs the token too. Responses send `X-Frame-Options: DENY` and a strict
  Content-Security-Policy (no framing, own scripts only), so the panel can't be embedded in another site.
* **WebSocket input** (`wsproto.js`):
  * messages may be up to 64 KB, in at most 16 fragments, with the buffered data capped;
  * client frames must be masked, and reserved bits, unknown opcodes, oversized or fragmented control
    frames, out-of-order continuations, binary frames and invalid UTF-8 are rejected;
  * there's a per-connection message rate limit, a 10-second limit for finishing a frame, and caps on
    connections and units;
  * a violation closes the connection with the matching RFC 6455 status code.
* **Settings** (`validate.js`): an explicit schema with allowed keys, types, numeric ranges, enums,
  string lengths and formats (colours, DMX address lists, IP addresses and host names). Unknown keys,
  including `__proto__`, are ignored. Anything rejected is reported back to the page. Saved settings are
  validated the same way when they're loaded.
* **Destinations and probing:** sACN and DDP only go to local-network addresses (loopback, RFC 1918,
  link-local, CGNAT) unless **Allow internet addresses** is ticked. The WLED check only queries a device on
  this computer's own subnet, and only while someone has that unit open. It makes two fixed GET requests
  to port 80, with a 1.5-second timeout and a size limit, and doesn't follow redirects.
* **Upgrading:** a newer copy stops an older one using the token written to `instance.json` in the settings
  folder, which only the user can read (mode 0600).

## Troubleshooting DDP
Go to **Outputs → DDP** and press **Send test**. It sends white for 5 seconds and asks the WLED what it's
receiving (through WLED's `/json/si` and `/json/cfg`), then reports one of these:

* **receiving ✔**: it works.
* **Receive UDP realtime is OFF**: switch it on in WLED.
* **Override live data is on**: switch it off in WLED.
* **reachable but isn't receiving**: something on the computer (firewall or security software) or on the network (guest/IoT VLAN) is blocking UDP.
* **not on the same network**: the IP address is wrong.
* **receiving DDP from another device**: something else is also sending to that WLED.

At start-up, an older copy of the app that's still running is shut down automatically, so two copies
can't both send to the lights. **Monitor → Copy diagnostics** gives a text report you can paste into a
support message.

## Running from source (developers)
```bash
node server.js            # opens http://localhost:8040/ in your browser
node server.js --port 8040 --data ./mydata --no-open

```
You need Node 22 or later. There are no runtime dependencies. If an old `state.json` is next to
`server.js`, it is imported into Unit 1 on first run.

## Building
```bash
npm install          # build tools only: esbuild, postject, resedit-cli
npm run build        # all platforms, or e.g.  npm run build -- win
```
The Windows 7 target (`win7`) needs mingw-w64 (`apt install gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64`). Node 22
won't start on Windows 7, because it imports `GetSystemTimePreciseAsFileTime`, which Windows 7 doesn't have. So this
target bundles the app for Node 13.14, the last release that supports Windows 7, and ships it as a `runtime` folder
with a small C launcher (`build/win7/launcher.c`) that only uses Windows XP-era APIs. The engine is shipped as
`runtime/pulsar-zero4000-engine.exe`, with Pulsar's name and icon, so Task Manager shows "Pulsar Zero 4000". The `postject` message
"Relocation corrupted: BlockSize is out of bound" during the main Windows build is harmless.

The build uses Node's *single executable application* support. It bundles the app, embeds `public/`
as assets, and injects both into the official Node binary for each platform, using the same Node
version as the one running the build. It also adds the icon and version information to the `.exe`,
and ad-hoc signs the Mac binaries (Apple Silicon won't run unsigned code). On Linux it downloads
`rcodesign` for the signing; on a Mac it uses `codesign`. To get rid of the security warnings, sign
the Windows `.exe` with a code-signing certificate, and sign and notarize the Mac app with an Apple
Developer ID ($99 a year).

## Architecture
* `emulator.js`: the circuit logic, simulated in 0.5 ms steps. It keeps running on the server, so the
  outputs carry on when the browser tab is hidden or closed, just as the hardware would.
* `outputs.js`: the sACN and DDP packet senders, plus host-name handling (pasted URLs, `:port`, mDNS `.local`).
* `validate.js`: strict validation of all settings and messages.
* `wsproto.js`: the WebSocket protocol, with size, fragment, rate and timeout limits.
* `netcheck.js`: network diagnostics (local addresses, same-subnet check, WLED status query).
* `server.js`: hosts the units; static files (from disk, or embedded in the executable), a small WebSocket
  server, the 40 fps output loop per unit, saved settings, single-instance start-up and browser launch.
* `build/`: the build script, the icon and the READ ME FIRST notes for each platform.
* `public/detector.js`: the audio front end as an AudioWorklet (log amp, the four RC band filters,
  peak detectors and AGC).
* `public/panel.js`: the SVG front panel.

## Using it
The front panel stays pinned at the top of the page. The menu bar sits under it, and each menu opens
below the panel (the panel shrinks a little so it never gets covered):

* **Audio**:
  * Sound source: 🎤 mic / line-in (choose the device), 🖥 PC audio, 🎵 music file, or off.
  * Input trim and sensitivity.
  * 24-LED green/yellow/red ladder meters for the input and each band. Each band has a trigger lamp and an
    amber marker showing its running average.
  * Band filter editor: low cut and high cut for each band, slope 6/12/24 dB per octave, and
    **Reset to original**.
* **Outputs**:
  * Channel colours: a colour picker for each channel, with preset swatches and a hex box.
  * sACN patch: each channel can drive any list of dimmer addresses (`1, 5, 9-12`) and/or colour
    fixtures (by start address). Each channel has its own colour order: RGB, RBG, GRB, GBR, BRG, BGR
    (3 ch) or RGBW, GRBW, BGRW, WRGB (4 ch). With RGBW, the white part of the colour is sent on W.
    **Quick patch** fills in a row of N fixtures, assigning Bass, Tenor, Alto, Treble in turn.
  * DDP: pixels per channel, pattern repeated ×N along the strip, and colour order (an RGBW order
    sends 4-byte RGBW pixels).
  * Frame rate and master level.
  * Unticking an output sends black (sACN also sends stream-terminate), so lights don't freeze.
* **Emulation**: mains power and frequency, lamp simulation, treble-reset behaviour, remote input.
* **Monitor**: what's being sent, and the chaser's current state.
* **⤢ Panel only** (or the **H** key) hides everything except the panel. Move the mouse to show the
  ☰ Menus button, or press **H** again.

PC audio works in Chrome and Edge. In the pop-up, pick **Entire screen** and switch on **Share system
audio**. Open the page as `localhost:8040`, because browsers only allow audio capture there.

## What is emulated (with schematic page)
| Function | Behaviour |
|---|---|
| Audio in (p3) | Stereo summed to mono, then diode log compression |
| Filters (p2, Zero 4000 values) | Bass LP 106 Hz · Tenor 360–530 Hz · Alto 1.45–2.1 kHz · Treble HP 3.6 kHz (first-order RC). You can change these in Audio → Band filters |
| Music detect (p7) | Peak-peak detector (≈33 ms attack / 121 ms release) with ≈1 s AGC. A channel fires when its band rises above its own recent average |
| Run pulse generator (p4) | C9 ramp oscillator, 1 M log SPEED pot: about 0.28 to 42 steps/s. **Music** mode: the chase advances only while music is detected, at a rate that rises with how much music is present. **Constant** mode: runs at the pot speed |
| Program rocker (p5) | Music+Auto / Program Hold (centre keeps the last music or constant mode and stops the auto-program change) / Constant+Auto |
| Chaser (p6B) | 3 × 4013 shift register with feedback. Bass = D1 and Alto = Q2. Tenor and Treble go through the 4016 reverse switches: forward (via R25/R26) is Tenor = Q3 and Treble = Q1, so the chase runs Bass → Treble → Alto → Tenor; reverse runs Bass → Tenor → Alto → Treble |
| Auto program (p6B) | 4024 counter clocked once per chase cycle (from L, i.e. every 4 steps). Each pattern runs forward then reverse: Pairs → Dark → Light → repeat. Direction changes every 64 steps; pattern every 128 steps |
| Flip-Flop / Flop-Flip | /Q2 drives Bass+Tenor and Q2 drives Alto+Treble, so the two pairs alternate |
| Selectors (p7) | Off (−7 V, lamp off), Static (wired to the +V rail, lamp on), Flip-Flop / Flop-Flip, Chase, Music, Man. The Manual Flash button sits between +V and the *Man.* contact, so it only works with the knob on *Man.*: the lamp is off, and on while the button is held |
| Output latches (p8B) | Outputs change only on mains-cycle edges (zero-crossing switching). Shimmer Dim passes alternate whole cycles (50 % with shimmer). Standby = 0 %. Lights stay off briefly at power-on (C11) |
| Treble reset (R81–83, D14–16) | R83 and D15/D16 form an AND of the Bass, Tenor and Alto outputs, which resets the Treble latch through R82 (D14 ORs in the Standby/Shimmer reset). So Treble is forced off while the other three are on. You can turn this off in Setup |
| Remote jack | The 4N27 opto input that forces Full. It is a toggle in Setup |
| Lamps | An optional incandescent filament model (warm-up and cool-down), so LED fixtures behave like the original lamps. Turn it off for hard triac on/off switching |

## Output mapping
* **sACN**: multicast (239.255.x.y) or unicast, on one universe, using the patch described above.
  Where two channels drive the same address, the higher level wins.
* **DDP**: UDP port 4048, RGB 8-bit. Each channel fills *N* pixels of its colour. The block of four
  repeats ×N, starting at the start pixel you set. This works with WLED, xLights, Falcon and similar
  controllers.

## Checked against the schematic
`node test/emulator-test.js` runs 22 checks against the drawings, each naming its page. They cover:
* the selector positions;
* Manual Flash only on *Man.*;
* Flip-Flop and Flop-Flip;
* the three chase patterns and both directions;
* the Pairs → Dark → Light program sequence;
* Program Hold remembering Music or Constant;
* the speed range;
* music gating of the run oscillator;
* the treble reset;
* Standby, Shimmer and mains-synchronised switching.

Version 1.4.0 corrected the chase direction. Earlier versions had Tenor and Treble swapped, so each pattern
started running the wrong way.

## Interpretation notes
The drawings do not fully settle a few points, so these are my best reading of them:

* The music speed-control mix. In music mode, about two fully active bands give the full pot speed.
* The AGC threshold.
* Whether the treble-reset circuit acts exactly as its parts-list note ("reset circuit for treble if
  other 3 channels are on") describes.

The input-trim and sensitivity sliders are not on the original unit. They are there to help adjust
modern line levels, and they default to neutral.

## Panel fonts
The fonts are bundled in `public/fonts` (open licences, see `LICENSES.txt`), so the panel works offline.
They are close matches to the original lettering:
* **PULSAR**: Fredoka Bold with a dark inline highlight, to match the fat rounded 70s logo.
* **ZERO 4000**: Abril Fatface, a heavy high-contrast serif with full-height digits.
* **Legends**: Arimo Bold, which has the same proportions as the Helvetica Bold used on the panel.

## Licence
MIT (see `LICENSE`). The bundled fonts keep their own licences (`public/fonts/LICENSES.txt`).
The packaged downloads include the Node.js runtime (MIT licence).
