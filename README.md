# Lay-Z — Bestway Spa & Pool Control for Homey

Control your **Bestway Lay-Z-Spa** (Airjet / Hydrojet Pro) and **Bestway Pool Filter Pump** directly from Homey. Monitor water temperature, control heating, jets and filter pump, and automate everything with Homey Flow.

---

## Supported Devices

| Driver | Device |
|--------|--------|
| **Lay-Z** | Bestway Lay-Z-Spa (Airjet & Hydrojet Pro) — via Gizwits cloud account |
| **Lay-Z-Spa (Share Code)** | Lay-Z-Spa — via share code (no account needed) |
| **Bestway Pool Filter Pump** | Bestway pool filter pumps — via Gizwits cloud account |

> **Requirements:** Homey Pro (local platform) with Homey firmware ≥ 12.0.

---

## Features

### Lay-Z-Spa (Airjet & Hydrojet Pro)

| Capability | Description |
|------------|-------------|
| Current temperature | Live water temperature |
| Target temperature | Set desired water temperature |
| Temperature reached | Indicator when target temp is reached |
| Power on/off | Turn the spa on or off |
| Heating on/off | Control the heater |
| Filter pump | Control the filter pump independently |
| Bubble / Wave (Airjet) | Toggle bubble massage |
| Airjet Low / High (Hydrojet) | Two-level massage intensity |
| Hydrojet Massage | Toggle the Hydrojet massage function |
| Locked | Child lock indicator |
| Alarm | Active error indicator |
| Error message | Plain-text error description |
| Pump state / Heat state | Status indicators |
| Power (W) / Energy (kWh) | Estimated power consumption & meter |

### Bestway Pool Filter Pump

| Capability | Description |
|------------|-------------|
| Power on/off | Turn the filter pump on or off |
| Timer | Set the auto-off timer (0–24 h) |
| Filter change | Indicator when cartridge needs replacing |
| Alarm | Active error indicator |
| Error message | Plain-text error description (E01–E08) |

---

## Flow Cards

### Lay-Z-Spa (Lay-Z & Share Code drivers)

**Triggers**
- Temperature reached (token: temperature)
- Error triggered (token: error message)
- Filtering turned on / turned off / changed

**Conditions**
- Temperature is above / below threshold
- Temperature reached
- Airjet is active
- Error is active
- Spa is locked
- Filtering is on / off

**Actions**
- Set filter on/off
- Set heating on/off
- Set Airjet Low on/off
- Set Airjet High on/off
- Set Hydrojet on/off
- Turn filter pump on / off / toggle

### Pool Filter Pump

**Triggers**
- Filter pump turned on / turned off / changed
- Filter change required
- Error triggered (token: error message)

**Conditions**
- Filter pump is on / is off
- Filter change is active
- Error is active

---

## Pairing

**Via account (Lay-Z driver):**
1. Open the Homey app → **Devices** → **+** → search for **Lay-Z**
2. Select the **Lay-Z** driver
3. Enter your **Bestway account credentials** (email + password)
4. Select the device from the list and tap **Add**

**Via share code (no account needed):**
1. In the Bestway app: open your spa → Share → copy the share code
2. In Homey: **Devices** → **+** → search for **Lay-Z** → select **Lay-Z-Spa (Share Code)**
3. Enter the share code and tap **Add**

To update credentials later (e.g. after a password change), long-press the device card → **Settings** → **Repair**.

---

## Supported Regions

Login is attempted automatically against the US, EU, and global Gizwits servers. No manual region selection is needed during pairing.

---

## Languages

The app supports 11 languages: English, German, Norwegian, Czech, Dutch, Danish, Swedish, Italian, French, Russian, Polish.

---

## Changelog

### 1.3.4
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

- [Ruben Torkelsen](https://github.com/rtorkelsen)
- [Einar Hagen](https://github.com/einarand)
- [Andi Wirz](https://github.com/andiwirz)
