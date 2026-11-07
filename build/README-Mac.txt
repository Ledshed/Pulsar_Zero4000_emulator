PULSAR ZERO 4000 emulator  (version {{VERSION}})  -  macOS 11 or newer
=======================================================================
(works on both Apple Silicon and Intel Macs)

STARTING IT
1. Drag "Pulsar Zero 4000.app" into your Applications folder.
2. Double-click it. Your web browser opens with the front panel.

The emulator runs quietly in the background, with no window of its own.
To stop it, choose Unit > Quit in the browser.

THE FIRST TIME: "cannot be opened" / "Apple could not verify..."
This app isn't signed with an Apple developer certificate, so macOS blocks it
the first time:
  1. Click "Done" (or "OK") on the warning.
  2. Open System Settings > Privacy & Security.
  3. Scroll down and click "Open Anyway" next to Pulsar Zero 4000.
  4. Enter your password and click "Open".
You only need to do this once. (On older macOS you can instead right-click
the app, choose Open, then click Open.)

If macOS asks to allow incoming network connections or access to the local
network, click Allow. The emulator needs this to send sACN / DDP to your
lights.

RUNNING SEVERAL UNITS
In the browser, open Unit > "+ Add unit". Each unit is a separate Zero 4000
in its own browser tab, with its own settings and outputs. Give each unit
its own sACN universe so they don't fight over the same lights.
Double-clicking the app again just opens another browser tab.


SOUND
In the browser, open Audio and choose Mic / line-in, PC audio, or a music file.
PC audio (all system sound) needs Chrome and macOS 14.2 or newer. Otherwise,
share a Chrome tab that is playing music.

Settings:  ~/Library/Application Support/Pulsar Zero 4000
Log file:  ~/Library/Logs/Pulsar Zero 4000.log

STILL WON'T OPEN?
Open Terminal and paste this, then try again:
  xattr -dr com.apple.quarantine "/Applications/Pulsar Zero 4000.app"
