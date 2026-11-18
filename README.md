# Nova S Pro Drill Control

A web client for the Nova S Pro table tennis robot by [wenguang1111](https://github.com/wenguang1111).
It replaces the original app: no account, no vendor server, works in a Chromium-based browser over Web Bluetooth.

Live: **https://wenguang1111.github.io/nova/**

| Main | Editor | Countdown |
| :---: | :---: | :---: |
| <img src="./images/main.png" width="300"> | <img src="./images/editor.png" width="300"> | <img src="./images/countdown.png" width="300"> |

## Usage

**Online:** open https://wenguang1111.github.io/nova/ and tap *Connect*. Self-hosting needs HTTPS (Web Bluetooth requirement).

**Local:** download the repository and serve it, for example `python3 -m http.server`, then open `http://localhost:8000`.

**Requirements**

  * Android: Chrome, Cromite or another Chromium-based browser.
  * iPhone: Safari and Chrome for iOS have no Web Bluetooth. Use the Bluefy browser (tested by the author).
  * Keep the screen on during a drill. The page asks the browser to keep it awake; if the phone still dims or locks, the browser suspends the page and the drill stops.

## Features

**General**

  * **Fully customizable drills:** add and remove drills and balls; export and import settings as CSV.
  * **Data persistence:** settings and drills are saved in the browser's local storage on that device. Nothing is uploaded unless you share a drill.
  * **Themes:** 4 options, including dark mode.
  * **Languages:** English, Simplified Chinese and German. The first visit follows the device language; the menu lets you switch.
  * **Statistics:** accumulated counters (total balls and drills).
  * **Version label:** shown at the bottom right of the main page, so you can check which build you are running.

**Drill management**

  * **Edit and create:** modify pre-programmed drills or create custom ones in groups A, B and C (up to 100 each).
  * **Randomization:** randomize ball sequences or configure several variants of a single ball.
  * **Scatter:** randomize the drop point of a ball (drop point ± scatter).
  * **Drag and drop:** reorder drills or move them between categories.
  * **Controls:** drill length by time or repetitions, pause, stop, countdown (tap to skip).

**Editor tools**

  * **Drill editor:** long-press a drill button. Delete, *Save As*, test the whole sequence, and share.
  * **Ball editor:** add or remove balls, change the order, rename drills, test a single ball without saving.

**Sharing drills**

  * **Share:** in the editor, *Share* uploads the current drill to the author's Google Drive folder together with your name and a short description. The Drive folder ID is kept in an Apps Script and is not part of this repository.
  * **Download Drill:** in the menu, enter the password to see all shared drills, tick the ones you want and import them into Custom A, B or C. Existing drills are never overwritten.
  * Set-up and security notes: [docs/drive-share.md](docs/drive-share.md).

**Remote control (experimental)**

  A person elsewhere can request drills through a relay server; the phone next to the robot must confirm every start. See [docs/remote-testing.md](docs/remote-testing.md). This is not a fail-safe: someone on site must always be able to switch the robot off.

## Custom drills (CSV)

Drills can be imported and exported as CSV. Variant balls (pseudo-randomness) share the same ball number.

**CSV format:** `Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps`

**Example:**

```csv
A;1;Drill A2;7.5;5;top;50;-5;60;1
A;2;Drill A2;7.5;5;back;50;-5;30;1
B;1;Drill B1;7.5;5;top;50;-5;60;1
B;1;Drill B1;7.5;5;back;50;5;60;1
```

The CSV is not a full backup: it does not contain random order, the enabled flag of a ball, scatter, statistics or theme.

## Technical parameters

| Parameter | Description | Range | Step |
| :--- | :--- | :--- | :--- |
| **Spin type** | top / back | - | - |
| **Speed** | ball speed | 0 - 10 | 0.5 |
| **Spin** | ball spin | 0 - 10 | 0.5 |
| **Height** | ball height | -50 (down) to 100 (up) | 1 |
| **Drop** | drop point | -10 (right) to 10 (left) | 0.5 |
| **BPM** | balls per minute | 30 - 90 | 1 |
| **Reps** | repetitions | 1 - 200 | 1 |

## Credits

This project is a fork of [olanga/nova](https://github.com/olanga/nova) (Nova S Pro Drill Control, web client 2.3a at the time of forking). The Bluetooth protocol, drill editor and the original interface come from that project, which in turn is based on findings by [smee](https://github.com/smee/nova-s-custom-drills) and plunder. Thank you.

What this fork adds: German and Chinese translations with device-language detection, a screen wake lock during drills, Google Drive drill sharing with a password-protected download list, remote control through a relay server, and GitHub Pages deployment.

There is no license file in this repository or in the upstream project; all rights remain with the respective authors.
