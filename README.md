# Lay-Z — Bestway Spa & Pool Control for Homey

Control your **Bestway Lay-Z-Spa** (Airjet / Hydrojet Pro) and **Bestway Pool Filter Pump** directly from Homey. Monitor water temperature, control heating, jets and filter pump, and automate everything with Homey Flow.

> **App version:** 1.4.0 · **Homey SDK:** 3 · **Platform:** Homey Pro (≥ 12.0)

---

## Supported Devices

| Driver | Pairing method | Models |
|--------|----------------|--------|
| **Lay-Z** | Bestway / Gizwits cloud account | Lay-Z-Spa Airjet, Hydrojet Pro |
| **Lay-Z-Spa (Share Code)** | Share code — no account needed | Lay-Z-Spa Airjet, Hydrojet Pro |
| **Bestway Pool Filter Pump** | Bestway / Gizwits cloud account | Bestway pool filter pumps |

---

## Features

### Lay-Z-Spa (Airjet & Hydrojet Pro)

| Capability | Description |
|------------|-------------|
| Current temperature | Live water temperature reading |
| Target temperature | Set desired water temperature |
| Temperature reached | Indicator — target temp has been reached |
| Power on/off | Turn the spa unit on or off |
| Heating on/off | Control the heater independently |
| Filter pump on/off | Control the filter pump independently |
| Bubble / Wave (Airjet) | Toggle bubble massage |
| Airjet Low / High (Hydrojet) | Two-level massage intensity |
| Hydrojet Massage | Toggle the Hydrojet massage function |
| Locked | Child lock status indicator |
| Alarm | Active system error indicator |
| Error message | Plain-text error code description |
| Pump state / Heat state | Read-only status indicators |
| Power (W) | Estimated current power consumption |
| Energy (kWh) | Accumulated energy meter |

### Bestway Pool Filter Pump

| Capability | Description |
|------------|-------------|
| Power on/off | Turn the filter pump on or off |
| Timer | Set the auto-off timer (0–24 h) |
| Filter change | Indicator when cartridge replacement is due |
| Alarm | Active error indicator |
| Error message | Plain-text error description (E01–E08) |

---

## Flow Cards

### Lay-Z-Spa — Triggers

| Card | Token |
|------|-------|
| Target temperature reached | `temperature` (°C) |
| Spa error occurred | `error_message` |
| Heating turned on | — |
| Heating turned off | — |
| Filtering turned on | — |
| Filtering turned off | — |
| Filtering changed | — |

### Lay-Z-Spa — Conditions

| Card |
|------|
| Temperature is above [value] |
| Temperature is below [value] |
| Temperature reached |
| Airjet is active |
| Spa has an error |
| Spa is locked |
| Filtering is on |
| Filtering is off |

### Lay-Z-Spa — Actions

| Card | Note |
|------|------|
| Turn filter on or off | Applies to all connected spa devices |
| Turn heating on or off | Applies to all connected spa devices |
| Turn Airjet Low on or off | Applies to all connected spa devices |
| Turn Airjet High on or off | Applies to all connected spa devices |
| Turn Hydrojet on or off | Applies to all connected spa devices |
| Turn filtering on | Per device |
| Turn filtering off | Per device |
| Toggle filtering | Per device |

> All filter pump flow cards work for both the **Lay-Z** (account) driver and the **Lay-Z-Spa (Share Code)** driver.

### Pool Filter Pump — Triggers

| Card | Token |
|------|-------|
| Filter pump turned on | — |
| Filter pump turned off | — |
| Filter pump changed | — |
| Filter change required | — |
| Pool filter error occurred | `error_message` |

### Pool Filter Pump — Conditions

| Card |
|------|
| Filter pump is on |
| Filter pump is off |
| Filter change is active |
| Error is active |

---

## Pairing

### Via Bestway account (Lay-Z driver)

1. Open the Homey app → **Devices** → **+** → search for **Lay-Z**
2. Select the **Lay-Z** driver
3. Enter your **Bestway / Gizwits account credentials** (email + password)
4. Select the device from the list and tap **Add**

### Via share code — no account needed (Share Code driver)

1. In the Bestway app: open your spa → **Share** → copy the share code
2. In Homey: **Devices** → **+** → search for **Lay-Z** → select **Lay-Z-Spa (Share Code)**
3. Paste the share code and tap **Add**

### Updating credentials after a password change

Long-press the device card → **Settings** → **Repair** → enter the new credentials.

---

## Settings

Each device exposes the following settings:

| Setting | Description |
|---------|-------------|
| Poll interval | How often Homey fetches state from the cloud (10–300 s, default 60 s) |
| Enable power on/off control | Show or hide the main power toggle |
| Filter Pump Control | Show or hide the filter pump toggle |
| Power sensor (estimated) | Enable estimated power / energy tracking |
| Watt values | Per-component watt values for the power estimate |
| Troubleshooting labels | Last sync time, status, raw attributes (read-only) |

---

## Supported Regions

Login is attempted automatically against the **US**, **EU**, and **global** Gizwits servers. No manual region selection is needed during pairing.

---

## Languages

The app supports **11 languages**: English, German, Norwegian, Czech, Dutch, Danish, Swedish, Italian, French, Russian, Polish.

---

## Installation

The app is available on the Homey App Store (TEST channel):

👉 [Install Lay-Z on Homey](https://homey.app/de-ch/app/com.utkikk.layz/Lay-Z/)

> **Note:** Extended features (Share Code driver, Pool Filter Pump, full flow card set) are currently available in the **TEST** version only.

---

## Manual Installation (without the Homey App Store)

You can install this app directly from source using the Homey CLI — useful for testing unreleased fixes, running a fork, or trying a change before it reaches the Store.

### Prerequisites

- **Node.js 18 or newer** — check with `node -v`; download from [nodejs.org](https://nodejs.org/) if needed
- **A Homey Pro** (2019 or 2023) — this app uses the `local` platform and does **not** run on Homey Cloud or Homey Bridge
- **A Homey/Athom account**, with your Homey Pro already paired to it in the Homey app
- Being on the **same Wi-Fi network** as your Homey Pro is recommended (not strictly required — the CLI can also install over the Athom cloud, just more slowly)

### Steps

1. **Install the Homey CLI** globally:
   ```bash
   npm install -g homey
   ```

2. **Clone this repository** (or download and unzip the [source ZIP](https://github.com/andiwirz/homey-layz/archive/refs/heads/main.zip)):
   ```bash
   git clone https://github.com/andiwirz/homey-layz.git
   cd homey-layz
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Log in** to your Homey/Athom account — this opens a browser window to authenticate:
   ```bash
   homey login
   ```

5. **Install the app** onto your Homey. From the project's root folder:
   ```bash
   homey app install
   ```
   - If a Store version of the app is already installed, this simply overwrites it in place — no need to uninstall first, and your paired devices, settings, and flows are preserved.
   - You'll be prompted to choose which Homey to install to if you have more than one paired to your account.
   - This builds the app from `.homeycompose/` and installs it **permanently** — it keeps running after you close the terminal, exactly like a Store install.
   - `homey app validate` runs automatically as part of this; if it fails, fix the reported error before retrying.

6. **Pair your devices.** Open the Homey app → **Devices** → **+** → search for **Lay-Z**, and follow the steps under [Pairing](#pairing) below.

### Alternative: live development mode

Instead of `homey app install`, you can run:
```bash
homey app run
```
This streams live logs from your Homey to your terminal and reloads the app automatically when you save a file — useful while actively making changes. Recent Homey CLI versions keep the app running on your Homey even after you close the terminal (stop it from the Homey app's **Apps** overview, or press <kbd>Ctrl+C</kbd> to detach). Use `homey app install` instead if you just want a normal, always-on installation without keeping the CLI around.

### Updating a sideloaded install

Pull the latest changes and re-run `homey app install` — it overwrites the existing sideloaded version in place. Your paired devices, settings, and flows are preserved.

```bash
git pull
homey app install
```

### Uninstalling

Homey app → **Settings** → **Apps** → **Lay-Z** → **Uninstall**.

---

## Community & Support

- 💬 [Homey Community Thread](https://community.homey.app/t/app-pro-lay-z-control-your-bestway-spa-pool-filter-from-homey/155679)
- 🐛 [Report a bug on GitHub](https://github.com/rtorkelsen/homey-layz/issues)

---

## Credits

The new **Lay-Z-Spa (Share Code)** driver and **Bestway Pool Filter Pump** driver were built using [ha-bestway](https://github.com/cdpuk/ha-bestway) as the primary API reference — a Home Assistant integration for Bestway devices. Many thanks to the ha-bestway contributors.

---

## Support the Project

If this app saves you time or adds value to your smart home, consider a small donation:

- ☕ [Donate to Ruben (paypal.me/rtorkelsen)](https://paypal.me/rtorkelsen) — original app author
- ☕ [Donate to Andi (paypal.me/andiwirz)](https://paypal.me/andiwirz) — Share Code & Pool Filter driver

---

## Changelog

### 1.3.18
- Added: support for the new Bestway **"Smart Home"** backend used by 2025+ UltraFit devices via the Bestway Connect app — since ~July 2026, that app's "Share Device" QR code no longer produces an `RW_Share_` text code but a share link instead (e.g. `smart-spa-eu-app.bestwaycorp.com/...?shareId=...`), which the app previously rejected outright
- Pairing now automatically detects and routes to the correct backend, whether you paste a legacy `RW_Share_` code or a new share link/id
- Existing devices are unaffected

### 1.3.17
- Fixed: pairing instructions for the **Lay-Z-Spa (Share Code)** driver updated for newer Bestway app versions that only display a QR code (no visible text share code) — now explains scanning the QR code with any QR scanner app, and mentions the **Bestway Connect** app alongside **Smart Hub**
- Updated in all 11 supported languages

### 1.3.15
- Fixed: removed a redundant runtime `setCapabilityOptions` call — `target_temperature` min/max/step are now defined statically in the driver manifest, eliminating a source of unnecessary capability update events

### 1.3.14
- Fixed: flow cards briefly showing as unavailable on every data refresh
- Fixed: flow card run listeners were registered twice (caused warnings and unstable behaviour)
- Fixed: product name `Hydrojet` was not recognised as the HydroJet adapter, causing unnecessary capability changes on first poll
- Fixed: `spa_temp_reached` trigger fired repeatedly when temperature oscillated near the setpoint — added hysteresis
- Fixed: temperature value in the `spa_temp_reached` trigger was in °F instead of °C on Fahrenheit devices

### 1.3.13
- Fixed: temperature always displayed and set in °C in Homey, even when the physical device is configured in Fahrenheit — conversion happens transparently in the driver

### 1.3.12
- Improved: 5 new device-level action cards (heating, filter, AirJet Low/High, HydroJet) — appear directly under the selected device in the flow editor
- Old app-level cards marked as deprecated and continue to work in existing flows

### 1.3.11
- Improved: extended App Store search tags in English and German — `pool`, `pool filter`, `pump`, `whirlpool`, `inflatable`, `outdoor`, `wellness` and more for better discoverability

### 1.3.10
- Added: flow triggers **"Heating turned on"** and **"Heating turned off"** for both drivers
- Added: **Lay-Z** (account) driver auto-refreshes expired Gizwits tokens — no more manual repair for routine token expiry
- Fixed: crash in Share Code driver (`rawError is not defined`) — devices went unavailable after 3 failed polls
- Fixed: repair view missing for **Lay-Z** and **Pool Filter** drivers (`repair_login.html` was never created)
- Fixed: all pair/repair views updated to SDK v3 Promise-based `Homey.emit()`
- Fixed: `warning=1` without `error_code` no longer fabricates **E01: Flow sensor error**
- Fixed: flow card formatting — removed `[[temperature]]` and `°C` from `title` fields; added missing `titleFormatted` translations

### 1.3.9
- Fixed: Share Code devices with `warning=1` but no `error_code` were incorrectly showing **E01: Flow sensor error** — the `warning` field is now treated as a boolean flag only; the error description is derived from `error_code` / `fault_code` exclusively

### 1.3.8
- Fixed: heating on/off button missing on existing **Share Code** devices — `onoff.heating` is now added automatically on first start after update
- Fixed: global "Turn heating on or off" flow action now uses a direct method call on Share Code devices

### 1.3.7
- Fixed: `spa_error_triggered` and `spa_error_active` flow cards now use explicit driver filter instead of a capability proxy
- Fixed: filter pump conditions (`is on` / `is off`) now correctly handle Share Code devices
- Improved: Lay-Z driver infers device availability from poll result — halves API calls per poll cycle
- Improved: filter pump trigger cards now have localised `titleFormatted` for all 11 supported languages

### 1.3.6
- Fixed: heating on/off button missing on existing devices after capability migration
- Fixed: `bestway_temp_reached` and `bestway_error_message` now always ensured present on existing devices

### 1.3.1
- Fixed: filter pump flow cards (on/off/changed triggers, conditions, actions) now also work for the Share Code driver
- Fixed: spa error flow card now uses explicit driver filter
- Fixed: capability order migration skips reorder when already correct
- Added: pool filter flow card translations for 9 additional languages (no, cs, nl, da, sv, it, fr, ru, pl)

### 1.3.0
- Added **Bestway Pool Filter Pump** driver with full flow card support
- Added **Lay-Z-Spa (Share Code)** driver (no account required)
- Custom login/repair views for all drivers — consistent design, fully localised
- Added 9 additional languages (no, cs, nl, da, sv, it, fr, ru, pl)
- Renamed capability titles: "Filter" (de), "Hydrojet Massage" (all languages)
- Fixed capability display order (`pump_onoff` now appears directly after `onoff.heating`)
- Fixed debug "Last Sync" timestamp to show Homey's local timezone instead of UTC
- Improved capability order migration: two-pass removal with retry for existing devices
- New devices skip migration entirely (capabilities come from driver definition)

### 1.2.4
- Repair login page added
- Various bug fixes

### 1.2.x
- Hydrojet Pro adapter support
- Airjet Low / High massage levels
- Energy estimation (W / kWh)
- Child lock indicator

### 1.2.0
- Initial multi-model support (Airjet + Hydrojet Pro)
- Model registry with pluggable adapters

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE.MD) file for details.

## Contributors

- [Ruben Torkelsen](https://github.com/rtorkelsen) — original author & maintainer
- [Einar Hagen](https://github.com/einarand)
- [Andi Wirz](https://github.com/andiwirz) — Share Code & Pool Filter driver, flow card expansion
