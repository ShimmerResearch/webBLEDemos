# Shimmer Consensys Export Demo

This is a demonstration of how a logged Shimmer3 or Shimmer3R trial can be
prepared for import into Consensys using only a web browser.

The demo can:

- connect to a Shimmer3 or Shimmer3R over Web Bluetooth and set its real-time
  clock from the computer or phone;
- read a selected trial folder from Shimmer storage or an SD card;
- detect the trial files and device identifiers;
- arrange the files in the folder structure expected by Consensys; and
- build a ZIP file that can be shared or imported.

## Example use case

Imagine you are collecting data with SD logging in a remote location, away
from the person who will review or analyse it. Once the recording is complete,
you can use this demo to package the trial into a Consensys-ready ZIP and send
it to them quickly. They can then import the package into Consensys and inspect
the data without waiting for the physical device or SD card to be returned.

This could be useful for remote studies, field testing, troubleshooting, or
any situation where somebody needs to review a recording from another
location.

## Demo status

This is an early example, not a finished or officially supported Consensys
feature. It is intended to demonstrate the workflow and help us learn how
people would use it in practice.

Device, browser, operating-system, firmware, storage-access, and Consensys
version differences may affect the result. Please verify exported data before
using it for important work.

The Web Bluetooth utility requires a compatible Chromium-based browser, such
as Chrome on Windows or Android. Web Bluetooth is not currently available in
iOS browsers.

## Feedback and testing

If this workflow would be useful to you, we would be happy to hear from you.

You are welcome to test the demo and share feedback through the repository or
with the Shimmer support team. Real-world feedback will help us understand the
need and inform the design of a more complete, polished, and supported feature.

## Try it

Open [`index.html`](index.html) from a secure web origin (HTTPS or localhost)
in a compatible browser.
