PULSAR ZERO 4000 emulator  (version {{VERSION}})  -  Linux x64
================================================================

STARTING IT
  ./pulsar-zero4000

Your web browser opens with the front panel. Press Ctrl+C in the terminal
(or choose Unit > Quit in the browser) to stop it.

Options:
  --port 8040      first port to try (it moves to the next free port if this one is busy)
  --host 0.0.0.0   also allow access from other machines (audio input only works on localhost)
  --data <dir>     where to keep settings (default: ~/.config/pulsar-zero4000)
  --no-open        don't open a browser

RUNNING SEVERAL UNITS
In the browser, open Unit > "+ Add unit". Each unit is a separate Zero 4000
in its own browser tab. Give each unit its own sACN universe so they don't
fight over the same lights.

