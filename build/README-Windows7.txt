PULSAR ZERO 4000 emulator  (version {{VERSION}})  -  Windows 7 / 8 / 8.1
=========================================================================
(this version also works on Windows 10 and 11)

STARTING IT
1. Unzip the whole download. Keep "Pulsar Zero 4000.exe" in the same folder
   as the "runtime" folder next to it. Don't move the .exe on its own
   (you can make a desktop shortcut to it instead: right-click > Send to >
   Desktop).
2. Double-click "Pulsar Zero 4000.exe".
3. Your web browser opens with the front panel. Use Chrome, Edge or Firefox.
   (Internet Explorer won't work.)

A black window also opens. Leave it open while you use the emulator.
Closing it (or choosing Unit > Quit in the browser) stops it.

THE FIRST TIME
If Windows warns about an unknown publisher, click "Run" (or "More info",
then "Run anyway").

If Windows Firewall asks about "Pulsar Zero 4000", click "Allow access"
(it's needed to send sACN / DDP to your lights).

RUNNING SEVERAL UNITS
In the browser, open Unit > "+ Add unit". Each unit is a separate Zero 4000
in its own browser tab. Give each unit its own sACN universe so they don't
fight over the same lights.


SOUND
In the browser, open Audio and choose Mic / line-in, PC audio, or a music file.
On Windows 7, "PC audio" may not capture system sound. If it doesn't, use the
"Stereo Mix" recording device as the Mic / line-in input (enable it in
Control Panel > Sound > Recording, right-click > Show Disabled Devices).

Your settings are saved in:
  %APPDATA%\Pulsar Zero 4000

WHY A SEPARATE WINDOWS 7 VERSION?
The main Windows version needs Windows 10 or 11. On Windows 7 it fails with
"The procedure entry point GetSystemTimePreciseAsFileTime could not be
located...". This version uses an older engine that still supports Windows 7.
