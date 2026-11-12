# Shimmer Companion privacy policy (draft)

> **Draft for review before publishing.** It describes what the extension's code does as of
> version 1.5. The Chrome Web Store needs a privacy policy at a public URL, so this text has to be
> reviewed, completed and hosted before the extension is listed. The open questions at the end are
> for the people who own the study and the data, not for the code.

Shimmer Companion records physiological signals from a Shimmer3R sensor while a study participant
watches a video or browses a page, so researchers can line the signals up with what was on screen.

## What the extension records

Nothing is recorded until the participant opens the companion from the toolbar button, connects a
sensor and starts a recording. The extension only works in the tab where it was opened.

| Data | When | Kept where |
| --- | --- | --- |
| GSR (skin conductance) and PPG (pulse) samples | While recording | In the companion, until cleared or the tab closes |
| Sensor name and Bluetooth MAC address | On connecting a sensor | In the companion |
| Page title and media playback time | While the companion is open | In the companion |
| Page address | When uploading (see below) | Not kept |
| Time of each click on the page | While recording, only if on-click screenshots are on | In the companion |
| Screenshots of the recording tab | Only if the participant turns on periodic or on-click screenshots (both off by default), and only while that tab is the one showing | In the companion |
| Face presence (yes/no, up to about 10 times a second) | Only if the participant turns on webcam analysis (off by default) | In the companion |

**Webcam images never leave the device.** Webcam analysis runs locally with a bundled model. Frames
are not saved or uploaded. Only the yes/no face-presence value is recorded.

**Other tabs are never recorded.** The extension cannot read or capture other tabs or other sites.

## What is stored on the computer

- **Sign-in:** the access token and participant ID, in the extension's session storage, until the
  participant signs out or closes Chrome. The server address and email address are kept in local
  storage to fill in the sign-in form next time.
- **Preferences:** webcam preview and debug settings and the chosen camera, in the extension's
  local storage.

Recorded data is not stored. It is held in memory until the participant clears it, downloads it or
closes the tab.

## What leaves the computer

- **Download:** the participant can download a session as a ZIP file (CSV files, screenshots and an
  HTML report) to their own computer. Nothing is sent anywhere.
- **Cloud upload:** only when the participant signs in and presses **Upload**. The session goes to
  the study's ASM Cloud server, which must be an `https://…verisense.net` address, and from there to
  the study's cloud storage. The upload contains:
  - the GSR and PPG files;
  - face presence, if webcam analysis was on;
  - screenshots and their event log, if screenshots were on;
  - the HTML report;
  - a session manifest with the sensor MAC address, the page title and the page address without its
    query string or fragment.

  Signing in sends the participant's email address and password to that server over HTTPS.

The extension contains no analytics, advertising or tracking code, and sends nothing to Shimmer or
to any other third party.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Gives access only to the tab where the toolbar button was clicked: to open the companion there, read its title and address, and take screenshots of it |
| `scripting` | Adds the companion to that tab when the toolbar button is clicked |
| `storage` | Keeps the sign-in and preferences listed above |

The extension has no access to other sites or tabs. Bluetooth and the camera are requested from
Chrome only when the participant connects a sensor or enables webcam analysis.

## Open questions before publishing

- [ ] Who is the data controller for uploaded sessions: Shimmer, or the organisation running each
      study?
- [ ] How long uploaded sessions are kept, and how a participant asks for them to be deleted.
- [ ] The contact address for privacy questions.
- [ ] The public URL where this policy will be hosted.
