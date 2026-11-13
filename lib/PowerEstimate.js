'use strict';

/**
 * Shared power estimate for both spa drivers.
 *
 * The watt settings are calibrated totals, not component draws: "AirJet Low"
 * means the whole spa while AirJet Low runs, "Filter + Heating" means the whole
 * spa while both of those run. The old code therefore picked exactly one of
 * them with an if/else ladder — which silently lost the filter and heater
 * whenever bubbles were running at the same time, something the hardware
 * happily allows. A spa heating at 2200 W reported 1550 W the moment someone
 * switched the bubbles on.
 *
 * This keeps every calibrated total intact for the combinations that already
 * had one, and adds the missing base on top when jets run alongside it:
 *
 *     total = jets (as calibrated)  +  (filter/heating total − standby)
 *
 * Subtracting standby avoids counting the idle draw twice, since both figures
 * already include it. Nothing is derived by arithmetic from the other
 * settings — the shipped defaults are not mutually consistent (AirJet Low
 * alone is listed higher than HydroJet + AirJet Low together), so deriving
 * component draws from them would produce worse numbers than the values the
 * user actually measured.
 *
 * @param {import('homey').Device} device  Read for its power_* settings
 * @param {object} state
 * @param {boolean} state.filterOn    Filter pump running
 * @param {boolean} state.heating     Heater actively drawing power
 * @param {boolean} state.airjetLow   Bubbles on low
 * @param {boolean} state.airjetHigh  Bubbles on high
 * @param {boolean} state.hydrojet    HydroJet massage running
 * @returns {number} Estimated watts
 */
function estimateWatts(device, state) {
  const num = (id, fallback = 0) => Number(device.getSetting(id)) || fallback;

  const standby = num('power_standby_w', 2);
  const { filterOn, heating, airjetLow, airjetHigh, hydrojet } = state;

  // Calibrated total for whatever jets are running, 0 when none are.
  let jets = 0;
  if (hydrojet && airjetHigh)     jets = num('power_hydrojet_airjet_high_w');
  else if (hydrojet && airjetLow) jets = num('power_hydrojet_airjet_low_w');
  else if (airjetHigh)            jets = num('power_airjet_high_w');
  else if (airjetLow)             jets = num('power_airjet_low_w');
  else if (hydrojet)              jets = num('power_hydrojet_w');

  // Calibrated total for the filter/heater side.
  const base = heating ? num('power_heating_w')
    : filterOn ? num('power_filter_w')
      : standby;

  // No jets: the base total already is the answer.
  if (jets <= 0) return base;

  // Jets plus whatever else is running — standby is in both totals, count once.
  return jets + Math.max(0, base - standby);
}

module.exports = { estimateWatts };
