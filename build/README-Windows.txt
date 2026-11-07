PULSAR ZERO 4000 emulator  (version {{VERSION}})  -  Windows 10 / 11
=====================================================================

ON WINDOWS 7 OR 8? Use the "Windows 7" download instead. This one shows an
error about "GetSystemTimePreciseAsFileTime" there.

STARTING IT
1. Unzip this folder somewhere (for example Documents or the Desktop).
2. Double-click "Pulsar Zero 4000.exe".
3. Your web browser opens with the front panel.

A small black window also opens. Leave it open while you use the emulator.
Closing it (or choosing Unit > Quit in the browser) stops it.

THE FIRST TIME: "Windows protected your PC"
This program isn't code-signed, so Windows warns you the first time.
Click "More info", then click "Run anyway". You only need to do this once.

If Windows Firewall asks whether to allow network access, tick "Private
networks" and click Allow. The emulator needs this to send sACN / DDP to
your lights.

RUNNING SEVERAL UNITS
In the browser, open Unit > "+ Add unit". Each unit is a separate Zero 4000
in its own browser tab, with its own settings and outputs. Give each unit
its own sACN universe so they don't fight over the same lights.

If you double-click the program while it's already running, it opens
another browser tab instead of starting a second copy.


SOUND
In the browser, open Audio and choose Mic / line-in, PC audio, or a music file.
PC audio works in Chrome and Edge.

Your settings are saved automatically in:
  %APPDATA%\Pulsar Zero 4000
