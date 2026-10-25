'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient, SmarthubError } = require('../../lib/BestwaySmarthubClient');
const { BestwaySmartHomeClient, SmartHomeError } = require('../../lib/BestwaySmartHomeClient');
const Hibernation = require('../../lib/Hibernation');

const DEFAULT_POLL_INTERVAL_S = 60;
const MAX_POLL_INTERVAL_S     = 300;

// Bump whenever capabilitiesOptions in driver.compose.json changes, so already
// paired devices pick the new options up once. See _migrateCapabilityOptions().
// 1 -> initial, 2 -> titles moved into the capability definitions
const CAPABILITY_OPTIONS_REVISION = 2;

// Controls that moved off the built-in `onoff` sub-capabilities onto the app's
// own capabilities, so each one gets its own icon and both spa drivers share
// one vocabulary. See _migrateSubCapabilities().
const SUB_CAPABILITY_MIGRATION = {
  'onoff.filter':      'pump_onoff',
  'onoff.heating':     'heat_onoff',
  'onoff.airjet_low':  'airjet_low',
  'onoff.airjet_high': 'airjet_high',
  'onoff.hydrojet':    'jet_onoff',
};
const CONTROL_MAX_ATTEMPTS    = 1;
const CONTROL_RETRY_DELAY_MS  = 0;

const ERROR_DESCRIPTIONS = {
  E01: { en: 'Flow sensor error (paddle stuck)',      de: 'Durchflusssensor-Fehler (Paddel blockiert)' },
  E02: { en: 'Insufficient water flow',               de: 'Unzureichender Wasserfluss' },
  E03: { en: 'Water temperature too low (<4 °C)',     de: 'Wassertemperatur zu niedrig (<4 °C)' },
  E04: { en: 'Water temperature too high (>48 °C)',   de: 'Wassertemperatur zu hoch (>48 °C)' },
  E05: { en: 'Temperature sensor error',              de: 'Temperatursensor-Fehler' },
  E06: { en: 'Pump test failed',                      de: 'Pumpentest fehlgeschlagen' },
  E08: { en: 'Thermal cutoff triggered (>55 °C)',     de: 'Thermoschutz ausgelöst (>55 °C)' },
};

class LaZSpaConnectDevice extends Homey.Device {

  async onInit() {
    this.log('Device init (Connect):', this.getName());

    this._pollTimer      = null;
    this._pollFailCount  = 0;
    this._authPromise    = null;

    this._prevTempReached = undefined;
    this._prevAlarmActive = undefined;

    // Attribute dialect this device's shadow speaks ('aws' | 'gizwits').
    // Restored from the store so a control command issued before the first
    // poll completes is still encoded correctly; re-detected on every poll.
    this._dialect = this.getStoreValue('dialect') ?? 'aws';

    // Unit the device itself works in ('C' | 'F'). Homey always shows °C, so
    // readings are converted down and setpoints converted back up. Defaults to
    // Celsius until the first poll reports the actual unit.
    this._deviceUnit = 'C';

    this._energyLastTs    = Date.now();
    this._energyLastWatts = this.getCapabilityValue('measure_power') ?? 0;

    this._initClient();

    await this._migrateSubCapabilities();

    // Migration: add any capabilities that may be missing on older devices.
    // Derived from the manifest so a capability added there is never forgotten
    // here — the previous hardcoded list only covered half of them.
    for (const cap of (this.driver?.manifest?.capabilities ?? [])) {
      if (!this.hasCapability(cap)) {
        this.log(`Migrating: adding capability "${cap}"`);
        await this.addCapability(cap).catch(err =>
          this.error(`Failed to add capability "${cap}":`, err.message),
        );
      }
    }

    await this._migrateCapabilityOrder();
    await this._migrateCapabilityOptions();

    this.registerCapabilityListener('onoff',              this._onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this._onCapabilityTargetTemp.bind(this));
    this.registerCapabilityListener('heat_onoff',      this._onCapabilityHeating.bind(this));
    this.registerCapabilityListener('pump_onoff',       this._onCapabilityFilter.bind(this));
    this.registerCapabilityListener('airjet_low',   this._onCapabilityAirjetLow.bind(this));
    this.registerCapabilityListener('airjet_high',  this._onCapabilityAirjetHigh.bind(this));
    this.registerCapabilityListener('jet_onoff',     this._onCapabilityHydrojet.bind(this));
    this.registerCapabilityListener('bestway_locked',     this._onCapabilityLocked.bind(this));

    await this._syncStatus().catch(err => this.error('Initial sync failed:', err.message));
    this._startPolling();
  }

  async onUninit() {
    this._stopPolling();
  }

  async onDeleted() {
    this._stopPolling();
    this.log('Device deleted:', this.getName());
  }

  async onSettings({ newSettings, changedKeys }) {
    // Apply a hibernation change straight away instead of leaving the old
    // values (and the old poll interval) in place until the next tick.
    if (Array.isArray(changedKeys) && changedKeys.includes(Hibernation.SETTING_ID)) {
      this._hibernating = undefined;
      this.homey.setTimeout(() => {
        this._syncStatus().catch(err => this.error('Hibernation re-sync failed:', err.message));
      }, 1000);
    }

    const rawInterval  = Number(newSettings.poll_interval);
    const pollInterval = Number.isFinite(rawInterval)
      ? Math.max(10, Math.min(300, rawInterval))
      : DEFAULT_POLL_INTERVAL_S;

    if (pollInterval !== rawInterval) {
      this.log(`Poll interval clamped: ${rawInterval}s → ${pollInterval}s`);
      this.setSettings({ poll_interval: pollInterval }).catch(err =>
        this.log('Failed to write back clamped poll interval:', err.message),
      );
    }

    this._pollFailCount = 0;
    this._startPolling();
    this.log('Settings updated — poll interval:', pollInterval, 's');
  }

  _initClient() {
    // Devices paired before this backend existed have no 'backend' store
    // value — default to the legacy SmartHub client for those.
    const backend = this.getStoreValue('backend') ?? 'smarthub';

    if (backend === 'smart_home') {
      this._client = new BestwaySmartHomeClient({
        region:  this.getStoreValue('region') ?? 'eu',
        phoneId: this.getStoreValue('phoneId'),
      });
    } else {
      this._client = new BestwaySmarthubClient({
        region:    this.getStoreValue('region') ?? 'eu',
        visitorId: this.getStoreValue('visitorId'),
      });
    }
    this._client._token = this.getStoreValue('token') ?? null;
  }

  async _ensureToken() {
    if (this._client._token) return;

    if (this._authPromise) {
      await this._authPromise;
      return;
    }

    this.log('No token — authenticating with stored visitor ID…');
    this._authPromise = this._client.authenticate()
      .then(async token => {
        await this.setStoreValue('token', token);
        this.log('Re-authentication successful.');
      })
      .finally(() => {
        this._authPromise = null;
      });

    await this._authPromise;
  }

  async _invalidateToken() {
    this._client._token = null;
    await this.setStoreValue('token', null).catch(() => {});
  }

  _getPollIntervalMs() {
    // Hibernating devices only need to be checked often enough to notice they
    // came back — not often enough to track a spa nobody is using.
    if (Hibernation.isActive(this)) return Hibernation.pollIntervalMs();

    const baseSec = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL_S;
    const effectiveFailCount = Math.min(this._pollFailCount, 3);
    const backoffSec = Math.min(baseSec * (2 ** effectiveFailCount), MAX_POLL_INTERVAL_S);
    return Math.round(backoffSec) * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const schedule = () => {
      this._pollTimer = setTimeout(async () => {
        await this._syncStatus().catch(err => this.error('Poll sync failed:', err.message));
        schedule();
      }, this._getPollIntervalMs());
    };
    schedule();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Move an existing device off the old onoff.* sub-capabilities.
   *
   * The controls used to be sub-capabilities of the built-in `onoff`, which
   * meant Homey drew every one of them with the same generic on/off icon —
   * a capability's icon comes from its own definition, and sub-capabilities
   * inherit the base capability's. Switching to the app's own capabilities
   * (shared with the Lay-Z driver) gives each control its proper icon and
   * puts both drivers on one capability vocabulary.
   *
   * The last known value is carried over so the tile does not go blank until
   * the next poll.
   */
  async _migrateSubCapabilities() {
    for (const [oldCap, newCap] of Object.entries(SUB_CAPABILITY_MIGRATION)) {
      if (!this.hasCapability(oldCap)) continue;

      const previous = this.getCapabilityValue(oldCap);
      this.log(`Migrating capability "${oldCap}" -> "${newCap}"`);

      if (!this.hasCapability(newCap)) {
        await this.addCapability(newCap).catch(err =>
          this.error(`Failed to add capability "${newCap}":`, err.message),
        );
      }
      if (typeof previous === 'boolean' && this.hasCapability(newCap)) {
        await this.setCapabilityValue(newCap, previous).catch(() => {});
      }
      await this.removeCapability(oldCap).catch(err =>
        this.error(`Failed to remove capability "${oldCap}":`, err.message),
      );
    }
  }

  /**
   * Bring the tile order in line with driver.compose.json.
   *
   * Homey appends every addCapability() to the end, so a device that has been
   * through a migration ends up with its controls in the order they happened
   * to be added rather than the order the manifest declares. The only way to
   * reorder is to remove them all and add them back in the right sequence —
   * so this checks first and does nothing when the order already matches.
   *
   * Capability values are lost by the remove/re-add cycle and come back with
   * the next poll, which is why this must not run on every start.
   */
  async _migrateCapabilityOrder() {
    const desiredAll = this.driver?.manifest?.capabilities ?? [];
    if (!desiredAll.length) return;

    const snapshot = this.getCapabilities();
    const desired  = desiredAll.filter(c => snapshot.includes(c));
    const actual   = snapshot.filter(c => desiredAll.includes(c));

    const alreadyCorrect = snapshot.length === desired.length
      && desired.every((cap, i) => actual[i] === cap);
    if (alreadyCorrect) return;

    this.log('Reordering capabilities to manifest order…');
    this.log('  current:', snapshot.join(', '));
    this.log('  desired:', desiredAll.join(', '));

    for (const cap of snapshot) {
      await this.removeCapability(cap).catch(e => this.log(`  remove ${cap}:`, e.message));
    }
    // Give Homey a moment to commit the removals before adding them back.
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const cap of desiredAll) {
      await this.addCapability(cap).catch(e => this.error(`  add ${cap}:`, e.message));
    }
    this.log('Capability order migration done.');
  }

  /**
   * Push driver.compose.json's capabilitiesOptions onto an existing device.
   *
   * Homey copies those options into the device only when it is first paired —
   * an already-paired device keeps whatever was stored back then, so manifest
   * changes (a new icon, a renamed title, a different uiComponent) are
   * invisible on existing devices until they are written explicitly. Reading
   * straight from the manifest keeps this in sync automatically; bump
   * CAPABILITY_OPTIONS_REVISION whenever the options change so it runs once
   * more, rather than on every single start.
   */
  async _migrateCapabilityOptions() {
    if (this.getStoreValue('capOptionsRevision') === CAPABILITY_OPTIONS_REVISION) return;

    const options = this.driver?.manifest?.capabilitiesOptions ?? {};
    for (const [cap, opts] of Object.entries(options)) {
      if (!this.hasCapability(cap)) continue;
      await this.setCapabilityOptions(cap, opts).catch(err =>
        this.error(`setCapabilityOptions("${cap}") failed:`, err.message),
      );
    }

    await this.setStoreValue('capOptionsRevision', CAPABILITY_OPTIONS_REVISION).catch(() => {});
    this.log(`Capability options refreshed from manifest (revision ${CAPABILITY_OPTIONS_REVISION})`);
  }

  async _setCapability(cap, value) {
    if (!this.hasCapability(cap)) return;
    await this.setCapabilityValue(cap, value).catch(e => this.error(`set ${cap}:`, e));
  }

  /**
   * Detect which attribute dialect this device's shadow speaks.
   *
   * Most V02 devices report AWS-IoT style names (power_state, water_temperature,
   * …). Some devices — observed on a Hydrojet whose SmartHub shadow simply
   * proxies the underlying Gizwits attributes — report the classic V01 names
   * instead (power, Tnow, Tset, heat, filter, wave, jet, bit2, E01…E32).
   *
   * Without this check every branch in _syncStatus() silently skips and the
   * device shows no values at all.
   *
   * @returns {'gizwits'|'aws'}
   */
  _detectDialect(state) {
    const looksGizwits = state?.Tnow !== undefined
      || state?.Tset !== undefined
      || (state?.power !== undefined && state?.power_state === undefined);
    return looksGizwits ? 'gizwits' : 'aws';
  }

  /**
   * Translate a Gizwits-dialect shadow into the AWS-IoT field names the rest
   * of _syncStatus() reads. AWS-dialect payloads pass through untouched.
   *
   * Value-scale differences are normalised here too — most importantly
   * `filter`, which is 0/2 on Gizwits but 0/1 on AWS.
   */
  _normalizeState(state) {
    if (this._detectDialect(state) !== 'gizwits') return state;

    const out = { ...state };

    if (state.power !== undefined)  out.power_state = state.power === 1 ? 1 : 0;
    if (typeof state.Tnow === 'number') out.water_temperature   = state.Tnow;
    if (typeof state.Tset === 'number') out.temperature_setting = state.Tset;
    if (state.Tunit !== undefined)  out.temperature_unit = state.Tunit;
    // heat: 0=off, 1=starting, 3=heating, 4=target reached — same scale as heater_state
    if (state.heat !== undefined)   out.heater_state = state.heat;
    // filter is 0/2 here (2 = ON) but the AWS branch compares against 1
    if (state.filter !== undefined) out.filter_state = state.filter === 0 ? 0 : 1;
    if (state.wave !== undefined)   out.wave_state = state.wave;
    if (state.jet !== undefined)    out.hydrojet_state = state.jet;
    if (state.bit2 !== undefined)   out.locked = state.bit2;

    // E32 is the device's "target temperature reached" signal, not a fault.
    // It lags behind a setpoint change though — observed still set to 1
    // immediately after the target was raised well above the current water
    // temperature — so only trust it when the temperatures don't contradict
    // it. Leaving it unset falls through to the heater-state / temperature
    // comparison below, which carries the hysteresis.
    const contradicted = typeof state.Tnow === 'number'
      && typeof state.Tset === 'number'
      && state.Tnow < state.Tset;
    if (state.E32 === 1 && !contradicted) out.temp_reach_state = 1;

    // E01..E31 are real faults. Report the first active one; the caller turns
    // "E07" into a localised description.
    for (let i = 1; i <= 31; i++) {
      const key = `E${String(i).padStart(2, '0')}`;
      if (state[key] === 1) {
        out.error_code = key;
        break;
      }
    }

    return out;
  }

  async _syncStatus() {
    try {
      await this._ensureToken();

      const deviceId  = this.getData().id;
      const productId = this.getStoreValue('productId');
      const raw       = await this._client.getDeviceStatus(deviceId, productId);

      this.log('Connect status:', JSON.stringify(raw));

      const dialect = this._detectDialect(raw);
      if (dialect !== this._dialect) {
        this.log(`Connect attribute dialect detected: ${dialect}`);
        this._dialect = dialect;
        this.setStoreValue('dialect', dialect).catch(() => {});
      }
      const state = this._normalizeState(raw);

      // Seasonal hibernation: a packed-away spa keeps returning its last known
      // state forever, so watch the device's own freshness marker rather than
      // the fact that the request succeeded.
      const hibernation = await Hibernation.evaluate(this, Hibernation.fingerprint(
        raw.status_time,
        raw.updated_at,
        Hibernation.signatureOf(state, [
          'power_state', 'water_temperature', 'temperature_setting',
          'heater_state', 'filter_state', 'wave_state', 'hydrojet_state',
        ]),
      ));
      if (hibernation.changed) this._startPolling();
      if (hibernation.hibernating) {
        await this._setCapability('measure_power', 0);
        this._energyLastTs    = Date.now();
        this._energyLastWatts = 0;
        this.setEnergy({ approximation: { usageOn: 0, usageOff: 0 } }).catch(() => {});
        this._updateDebugSettings(raw);
        this._pollFailCount = 0;
        return;
      }

      // Homey always displays °C. A device configured in Fahrenheit reports raw
      // F values, so convert on read and back again on write — same as the
      // Lay-Z driver does. temperature_unit === 1 means Celsius; treat a
      // missing field as Celsius rather than guessing.
      this._deviceUnit = (state.temperature_unit !== undefined && state.temperature_unit !== 1)
        ? 'F' : 'C';
      const toC = (v) => (this._deviceUnit === 'F' && typeof v === 'number')
        ? Math.round((v - 32) * 5 / 9 * 10) / 10
        : v;

      if (state.power_state !== undefined) {
        await this._setCapability('onoff', state.power_state === 1);
      }

      if (typeof state.water_temperature === 'number') {
        await this._setCapability('measure_temperature', toC(state.water_temperature));
      }

      if (typeof state.temperature_setting === 'number') {
        await this._setCapability('target_temperature', toC(state.temperature_setting));
      }

      // heater_state: 0=off, anything above 0 = heater engaged. Known values are
      // 1=starting, 3/5=actively heating, 4=target reached (idle) — the exact
      // set varies by model, so treat any non-zero value as "on" rather than
      // matching against a fixed list.
      if (state.heater_state !== undefined) {
        const prevHeating = this._prevHeatingOn;
        const heatingOn   = state.heater_state > 0;
        await this._setCapability('heat_onoff', heatingOn);
        if (prevHeating !== undefined && prevHeating !== heatingOn) {
          if (heatingOn) {
            try { await this.homey.flow.getDeviceTriggerCard('heating_turned_on').trigger(this, {}, {}); }
            catch (e) { this.error('Trigger heating_turned_on failed', e); }
          } else {
            try { await this.homey.flow.getDeviceTriggerCard('heating_turned_off').trigger(this, {}, {}); }
            catch (e) { this.error('Trigger heating_turned_off failed', e); }
          }
        }
        this._prevHeatingOn = heatingOn;
      }

      if (state.filter_state !== undefined) {
        const prevFilter = this._prevFilterOn;
        const filterOn   = state.filter_state === 1;
        await this._setCapability('pump_onoff', filterOn);

        if (prevFilter !== undefined && prevFilter !== filterOn) {
          try { await this.homey.flow.getDeviceTriggerCard('filter_pump_changed').trigger(this, {}, {}); }
          catch (e) { this.error('Trigger filter_pump_changed failed', e); }
          if (filterOn) {
            try { await this.homey.flow.getDeviceTriggerCard('filter_pump_turned_on').trigger(this, {}, {}); }
            catch (e) { this.error('Trigger filter_pump_turned_on failed', e); }
          } else {
            try { await this.homey.flow.getDeviceTriggerCard('filter_pump_turned_off').trigger(this, {}, {}); }
            catch (e) { this.error('Trigger filter_pump_turned_off failed', e); }
          }
        }
        this._prevFilterOn = filterOn;
      }

      if (state.wave_state !== undefined) {
        // 0 = off, 1–99 = low, 100 = high
        await this._setCapability('airjet_low',  state.wave_state > 0 && state.wave_state < 100);
        await this._setCapability('airjet_high', state.wave_state === 100);
      }

      if (state.hydrojet_state !== undefined) {
        await this._setCapability('jet_onoff', state.hydrojet_state === 1);
      }

      if (state.locked !== undefined) {
        await this._setCapability('bestway_locked', state.locked === 1);
      }

      // Priority: temp_reach_state → heater_state=4 → infer from temperatures.
      let tempReachedRaw;
      if (state.temp_reach_state !== undefined) {
        tempReachedRaw = state.temp_reach_state === 1;
      } else if (state.heater_state === 4) {
        tempReachedRaw = true;
      } else {
        tempReachedRaw = typeof state.water_temperature === 'number'
          && typeof state.temperature_setting === 'number'
          && state.power_state === 1
          && state.water_temperature >= state.temperature_setting;
      }

      // Hysteresis: once reached, hold "reached" until the temperature drops a
      // full degree Celsius below target (1.8 °F on a Fahrenheit device — the
      // comparison runs in the device's own unit). Prevents oscillation when
      // the temperature hovers at the setpoint boundary.
      const hysteresisBuffer = this._deviceUnit === 'F' ? 1.8 : 1.0;
      const prevStable = this._prevTempReached;
      const hysteresisActive = (prevStable === true)
        && typeof state.water_temperature === 'number'
        && typeof state.temperature_setting === 'number'
        && state.water_temperature >= state.temperature_setting - hysteresisBuffer;
      const tempReached = tempReachedRaw || hysteresisActive;

      await this._setCapability('bestway_temp_reached', tempReached);

      if (prevStable !== undefined && tempReached && !prevStable) {
        this._fireTriggerTempReached(toC(state.water_temperature ?? 0));
      }
      this._prevTempReached = tempReached;

      // warning is a boolean flag (0/1); error_code carries the actual code (E01, "1", etc.)
      // Do NOT use warning as the error code — it causes warning=1 to be fabricated into "E01".
      const warningActive = state.warning !== undefined && state.warning !== null
        && state.warning !== '' && state.warning !== 0 && state.warning !== false && state.warning !== '0';
      const errorCode = state.error_code ?? state.fault_code ?? state.fault_state;
      const hasErrorCode = errorCode !== undefined && errorCode !== null
        && errorCode !== 0 && errorCode !== false && errorCode !== '';
      const hasError = warningActive || hasErrorCode;
      await this._setCapability('alarm_generic', hasError);

      if (hasError) {
        if (hasErrorCode) {
          const raw     = String(errorCode).replace(/^E/i, '');
          const codeNum = parseInt(raw, 10);
          const lang    = this.homey.i18n.getLanguage();
          if (Number.isFinite(codeNum) && codeNum > 0) {
            const eKey  = `E${String(codeNum).padStart(2, '0')}`;
            const entry = ERROR_DESCRIPTIONS[eKey];
            const desc  = entry ? (entry[lang] ?? entry.en) : String(errorCode);
            await this._setCapability('bestway_error_message', `${eKey}: ${desc}`);
          } else {
            await this._setCapability('bestway_error_message', String(errorCode));
          }
        } else {
          // warning flag active but no specific error code from device
          await this._setCapability('bestway_error_message', 'Device warning (no error code)');
        }
      } else {
        await this._setCapability('bestway_error_message', '–');
      }

      if (this._prevAlarmActive !== undefined && hasError && !this._prevAlarmActive) {
        const errorMsg = hasErrorCode ? String(errorCode) : String(state.warning);
        this._fireTriggerError(errorMsg);
      }
      this._prevAlarmActive = hasError;

      const fw = state.wifi_version ?? state.firmware_version ?? state.fw_version ?? state.trd_version;
      if (fw !== undefined && fw !== null && fw !== '') {
        this.setSettings({ debug_firmware: String(fw) }).catch(() => {});
      }

      // Show the untranslated payload in the troubleshooting label — that is
      // what is actually useful when diagnosing a device's attribute dialect.
      this._updateDebugSettings(raw);
      this._updateEnergyApproximation();
      this._pollFailCount = 0;
      if (!this.getAvailable()) this.setAvailable().catch(err => this.log('setAvailable failed:', err.message));

    } catch (err) {
      const code = (err instanceof SmarthubError || err instanceof SmartHomeError) ? err.code : null;
      const codeStr = code !== null && code !== undefined ? String(code) : null;

      if (codeStr === '401' || codeStr === '403' || codeStr === '505'
        || (err.message && err.message.toLowerCase().includes('token'))) {
        this.log('Token appears invalid — will re-authenticate on next poll.');
        await this._invalidateToken();
      }

      this._updateDebugSettings(null, err.message);

      // A hibernating spa is expected to be unreachable — don't count those
      // failures, don't mark it unavailable, and don't fill the log all winter.
      if (Hibernation.isActive(this)) {
        this.log('Connect sync failed while hibernating (expected):', err.message);
        return;
      }

      this._pollFailCount++;
      this.error(`Connect sync failed (consecutive: ${this._pollFailCount}):`, err.message);

      if (this._pollFailCount >= 3) {
        this.setUnavailable(err.message).catch(e => this.log('setUnavailable failed:', e.message));
      }

      throw err;
    }
  }

  _fireTriggerTempReached(temperature) {
    this.driver._triggerTempReached
      .trigger(this, { temperature: temperature ?? 0 })
      .catch(e => this.error('Flow trigger spa_temp_reached failed:', e));
  }

  _fireTriggerError(errorMessage) {
    this.driver._triggerErrorTriggered
      .trigger(this, { error_message: errorMessage })
      .catch(e => this.error('Flow trigger spa_error_triggered failed:', e));
  }

  async _onCapabilityOnoff(value) {
    this.log('Set onoff →', value);
    await this._sendControl({ power_state: value ? 1 : 0 });
    if (!value) {
      await this.setCapabilityValue('heat_onoff', false).catch(() => {});
      await this.setCapabilityValue('pump_onoff',  false).catch(() => {});
      this._updateEnergyApproximation();
    }
  }

  async _onCapabilityTargetTemp(value) {
    // Homey hands us °C; convert back if the device itself runs in Fahrenheit.
    const deviceValue = this._deviceUnit === 'F'
      ? Math.round(value * 9 / 5 + 32)
      : Math.round(value);
    this.log(`Set target_temperature → ${Math.round(value)} °C (sending ${deviceValue} °${this._deviceUnit ?? 'C'})`);
    await this._sendControl({ temperature_setting: deviceValue });
  }

  async _onCapabilityHeating(value) {
    this.log('Set heat_onoff →', value);
    await this._sendControl({ heater_state: value ? 1 : 0 });
    if (value && !this.getCapabilityValue('pump_onoff')) {
      this.log('Heating on — auto-enabling filter pump.');
      await this.triggerCapabilityListener('pump_onoff', true).catch(err =>
        this.error('Auto-enable filter failed:', err.message),
      );
    }
  }

  async _onCapabilityFilter(value) {
    this.log('Set pump_onoff →', value);
    await this._sendControl({ filter_state: value ? 1 : 0 });
  }

  // ── Flow action card helpers ────────────────────────────────────────────
  //
  // The device-level spa action cards (spa_filter, spa_heating, spa_airjet_low,
  // spa_airjet_high, spa_hydrojet) are shared with the Lay-Z driver and call
  // these methods straight on the device, so both drivers must expose the same
  // set of names — a missing one makes the card fail with a TypeError.
  // triggerCapabilityListener both sends the command and updates the UI state.

  async setFilterPump(value) {
    return this.triggerCapabilityListener('pump_onoff', !!value);
  }

  async setFilter(value) {
    return this.triggerCapabilityListener('pump_onoff', !!value);
  }

  async setHeating(value) {
    return this.triggerCapabilityListener('heat_onoff', !!value);
  }

  async setAirjetLow(value) {
    return this.triggerCapabilityListener('airjet_low', !!value);
  }

  async setAirjetHigh(value) {
    return this.triggerCapabilityListener('airjet_high', !!value);
  }

  async setHydrojet(value) {
    return this.triggerCapabilityListener('jet_onoff', !!value);
  }

  // Smart Home (Gizwits AEP / UltraFit) pumps report bubbles as on/off only
  // (wave_state 0/1) rather than the SmartHub backend's 0/50/100 low/high
  // scale — see BestwaySmartHomeClient.js. Low and High therefore both just
  // toggle bubbles on for these devices; there is no distinct "high" write
  // value confirmed for this hardware.
  _airjetOnValue() {
    return (this.getStoreValue('backend') ?? 'smarthub') === 'smart_home' ? 1 : 50;
  }

  async _onCapabilityAirjetLow(value) {
    this.log('Set airjet_low →', value);
    await this._sendControl({ wave_state: value ? this._airjetOnValue() : 0 });
    if (value) {
      await this.setCapabilityValue('airjet_high', false)
        .catch(e => this.error('set airjet_high:', e));
    }
  }

  async _onCapabilityAirjetHigh(value) {
    this.log('Set airjet_high →', value);
    const backend = this.getStoreValue('backend') ?? 'smarthub';
    await this._sendControl({ wave_state: value ? (backend === 'smart_home' ? 1 : 100) : 0 });
    if (value) {
      await this.setCapabilityValue('airjet_low', false)
        .catch(e => this.error('set airjet_low:', e));
    }
  }

  async _onCapabilityHydrojet(value) {
    this.log('Set jet_onoff →', value);
    await this._sendControl({ hydrojet_state: value ? 1 : 0 });
  }

  async _onCapabilityLocked(value) {
    this.log('Set bestway_locked →', value);
    await this._sendControl({ locked: value ? 1 : 0 });
  }

  _updateEnergyApproximation() {
    if (this.getSetting('power_sensor_enabled') !== 'yes') return;

    const standby = Number(this.getSetting('power_standby_w')) || 2;

    const airjetHigh = this.getCapabilityValue('airjet_high');
    const airjetLow  = this.getCapabilityValue('airjet_low');
    const hydrojet   = this.getCapabilityValue('jet_onoff');

    let usageOn;
    if (hydrojet && airjetHigh) {
      usageOn = Number(this.getSetting('power_hydrojet_airjet_high_w')) || 0;
    } else if (hydrojet && airjetLow) {
      usageOn = Number(this.getSetting('power_hydrojet_airjet_low_w')) || 0;
    } else if (airjetHigh) {
      usageOn = Number(this.getSetting('power_airjet_high_w')) || 0;
    } else if (airjetLow) {
      usageOn = Number(this.getSetting('power_airjet_low_w')) || 0;
    } else if (hydrojet) {
      usageOn = Number(this.getSetting('power_hydrojet_w')) || 0;
    } else if (this.getCapabilityValue('heat_onoff') && this.getCapabilityValue('pump_onoff')) {
      usageOn = Number(this.getSetting('power_heating_w')) || 0;
    } else if (this.getCapabilityValue('pump_onoff')) {
      usageOn = Number(this.getSetting('power_filter_w')) || 0;
    } else {
      usageOn = standby;
    }

    const now = Date.now();
    const elapsedHours = (now - this._energyLastTs) / 3_600_000;
    const deltaKwh     = (this._energyLastWatts / 1000) * elapsedHours;
    const totalKwh     = (this.getCapabilityValue('meter_power') ?? 0) + deltaKwh;
    this._setCapability('meter_power', Math.round(totalKwh * 10000) / 10000);
    this._energyLastTs    = now;
    this._energyLastWatts = usageOn;

    this.setEnergy({ approximation: { usageOn, usageOff: standby } })
      .catch(err => this.error('setEnergy failed:', err.message));

    this._setCapability('measure_power', usageOn);
  }

  _updateDebugSettings(state, error = null) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    const updates = {
      debug_last_sync: timestamp,
      debug_status:    error ? `Error: ${error}` : 'OK ✓',
      debug_region:    this.getStoreValue('region') ?? '–',
      debug_backend:   `${this.getStoreValue('backend') ?? 'smarthub'} (${this._dialect ?? 'aws'})`,
    };

    if (state) {
      updates.debug_raw = Object.entries(state)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(' | ');
    }

    this.setSettings(updates).catch(err =>
      this.log('Failed to update debug settings:', err.message),
    );
  }

  /**
   * Translate an AWS-style control payload into the dialect this device speaks.
   *
   * The capability handlers always build AWS-style updates (power_state,
   * heater_state, …); devices whose shadow reports classic Gizwits attributes
   * only accept those names — and a different scale for `filter` and `wave`.
   */
  _encodeControl(updates) {
    if (this._dialect !== 'gizwits') return updates;

    const out = {};
    for (const [key, value] of Object.entries(updates)) {
      switch (key) {
        case 'power_state':         out.power  = value ? 1 : 0; break;
        // Values here must be the states the device actually *reports*, not
        // command values — this writes a shadow "desired" state, which the
        // device matches against its own reported state. Sending heat=1 (a
        // command value the Gizwits /app/control endpoint accepts) is silently
        // ignored here; 3 is the reported ON state. Same reason filter is 2.
        case 'heater_state':        out.heat   = value ? 3 : 0; break;
        case 'filter_state':        out.filter = value ? 2 : 0; break;
        case 'hydrojet_state':      out.jet    = value ? 1 : 0; break;
        case 'temperature_setting': out.Tset   = value; break;
        // Bubble levels as reported by these models: 0 = off, 40 = low, 100 = high
        case 'wave_state':          out.wave   = value === 0 ? 0 : (value >= 100 ? 100 : 40); break;
        // Read attribute is bit2, but the write attribute is 'locked'
        case 'locked':              out.locked = value ? 1 : 0; break;
        default:                    out[key]   = value; break;
      }
    }
    return out;
  }

  async _sendControl(updates) {
    let lastErr;
    const payload = this._encodeControl(updates);

    for (let attempt = 1; attempt <= CONTROL_MAX_ATTEMPTS; attempt++) {
      try {
        await this._ensureToken();
        const deviceId  = this.getData().id;
        const productId = this.getStoreValue('productId');
        this.log(`Connect control (attempt ${attempt}) →`, JSON.stringify(payload));
        await this._client.control(deviceId, productId, payload);
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Connect control failed (attempt ${attempt}):`, err.message);

        if (attempt < CONTROL_MAX_ATTEMPTS) {
          await this._invalidateToken();
          await new Promise(resolve => setTimeout(resolve, CONTROL_RETRY_DELAY_MS));
        }
      }
    }

    this.error('Connect control failed after retry:', lastErr.message);
    throw new Error(this.homey.__('error.control_failed'));
  }

}

module.exports = LaZSpaConnectDevice;
