# Lay-Z — Bestway Spa & Pool Control for Homey

Control your **Bestway Lay-Z-Spa** (Airjet / Hydrojet Pro) and **Bestway Pool Filter Pump** directly from Homey. Monitor water temperature, control heating, jets and filter pump, and automate everything with Homey Flow.

> **App version:** 1.3.7 · **Homey SDK:** 3 · **Platform:** Homey Pro (≥ 12.0)

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
