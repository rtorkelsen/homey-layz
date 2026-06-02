'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient, SmarthubError } = require('../../lib/BestwaySmarthubClient');

const DEFAULT_POLL_INTERVAL_S = 60;
const MAX_POLL_INTERVAL_S     = 300;
const CONTROL_MAX_ATTEMPTS    = 2;
const CONTROL_RETRY_DELAY_MS  = 2000;

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

    this._prevTempReached = false;
    this._prevAlarmActive = false;

    this._energyLastTs    = Date.now();
    this._energyLastWatts = this.getCapabilityValue('measure_power') ?? 0;

    this._initClient();

    for (const cap of ['measure_power', 'meter_power', 'alarm_generic', 'bestway_error_message', 'bestway_temp_reached', 'bestway_locked']) {
      if (!this.hasCapability(cap)) {
        this.log(`Migrating: adding capability "${cap}"`);
        await this.addCapability(cap).catch(err =>
          this.error(`Failed to add capability "${cap}":`, err.message),
        );
      }
    }

    this.registerCapabilityListener('onoff',              this._onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this._onCapabilityTargetTemp.bind(this));
    this.registerCapabilityListener('onoff.heating',      this._onCapabilityHeating.bind(this));
    this.registerCapabilityListener('onoff.filter',       this._onCapabilityFilter.bind(this));
    this.registerCapabilityListener('onoff.airjet_low',   this._onCapabilityAirjetLow.bind(this));
    this.registerCapabilityListener('onoff.airjet_high',  this._onCapabilityAirjetHigh.bind(this));
    this.registerCapabilityListener('onoff.hydrojet',     this._onCapabilityHydrojet.bind(this));
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

  async onSettings({ newSettings }) {
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
    this._client = new BestwaySmarthubClient({
      region:    this.getStoreValue('region') ?? 'eu',
      visitorId: this.getStoreValue('visitorId'),
    });
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

  async _setCapability(cap, value) {
    if (!this.hasCapability(cap)) return;
    await this.setCapabilityValue(cap, value).catch(e => this.error(`set ${cap}:`, e));
  }

  async _syncStatus() {
    try {
      await this._ensureToken();

      const deviceId  = this.getData().id;
      const productId = this.getStoreValue('productId');
      const state     = await this._client.getDeviceStatus(deviceId, productId);

      this.log('Connect status:', JSON.stringify(state));

      if (state.power_state !== undefined) {
        await this._setCapability('onoff', state.power_state === 1);
      }

      if (typeof state.water_temperature === 'number') {
        await this._setCapability('measure_temperature', state.water_temperature);
      }

      if (typeof state.temperature_setting === 'number') {
        await this._setCapability('target_temperature', state.temperature_setting);
      }

      // heater_state: 0=off, 1=starting, 3=actively heating, 4=target reached (idle)
      if (state.heater_state !== undefined) {
        await this._setCapability('onoff.heating', state.heater_state > 0);
      }

      if (state.filter_state !== undefined) {
        const prevFilter = this._prevFilterOn;
        const filterOn   = state.filter_state === 1;
        await this._setCapability('onoff.filter', filterOn);

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
        await this._setCapability('onoff.airjet_low',  state.wave_state > 0 && state.wave_state < 100);
        await this._setCapability('onoff.airjet_high', state.wave_state === 100);
      }

      if (state.hydrojet_state !== undefined) {
        await this._setCapability('onoff.hydrojet', state.hydrojet_state === 1);
      }

      if (state.locked !== undefined) {
        await this._setCapability('bestway_locked', state.locked === 1);
      }

      // Priority: temp_reach_state → heater_state=4 → infer from temperatures.
      let tempReached;
      if (state.temp_reach_state !== undefined) {
        tempReached = state.temp_reach_state === 1;
      } else if (state.heater_state === 4) {
        tempReached = true;
      } else {
        tempReached = typeof state.water_temperature === 'number'
          && typeof state.temperature_setting === 'number'
          && state.power_state === 1
          && state.water_temperature >= state.temperature_setting;
      }
      await this._setCapability('bestway_temp_reached', tempReached);

      if (tempReached && !this._prevTempReached) {
        this._fireTriggerTempReached(state.water_temperature ?? 0);
      }
      this._prevTempReached = tempReached;

      const rawError = (state.warning !== undefined && state.warning !== '' && state.warning !== null)
        ? state.warning
        : (state.error_code ?? state.fault_code ?? state.fault_state);
      const hasError = rawError !== undefined && rawError !== null
        && rawError !== 0 && rawError !== false && rawError !== '';
      await this._setCapability('alarm_generic', hasError);

      if (hasError) {
        const codeNum = typeof rawError === 'number' ? rawError : parseInt(rawError, 10);
        const eKey    = `E${String(codeNum).padStart(2, '0')}`;
        const entry   = ERROR_DESCRIPTIONS[eKey];
        const lang    = this.homey.i18n.getLanguage();
        const desc    = entry ? (entry[lang] ?? entry.en) : String(rawError);
        await this._setCapability('bestway_error_message', `${eKey}: ${desc}`);
      } else {
        await this._setCapability('bestway_error_message', '–');
      }

      if (hasError && !this._prevAlarmActive) {
        this._fireTriggerError(String(rawError));
      }
      this._prevAlarmActive = hasError;

      const fw = state.wifi_version ?? state.firmware_version ?? state.fw_version ?? state.trd_version;
      if (fw !== undefined && fw !== null && fw !== '') {
        this.setSettings({ debug_firmware: String(fw) }).catch(() => {});
      }

      this._updateDebugSettings(state);
      this._updateEnergyApproximation();
      this._pollFailCount = 0;
      this.setAvailable().catch(err => this.log('setAvailable failed:', err.message));

    } catch (err) {
      const code = err instanceof SmarthubError ? err.code : null;

      if (code === 401 || (err.message && err.message.toLowerCase().includes('token'))) {
        this.log('Token appears invalid — will re-authenticate on next poll.');
        await this._invalidateToken();
      }

      this._pollFailCount++;
      this.error(`Connect sync failed (consecutive: ${this._pollFailCount}):`, err.message);
      this._updateDebugSettings(null, err.message);

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
      await this.setCapabilityValue('onoff.heating', false).catch(() => {});
      await this.setCapabilityValue('onoff.filter',  false).catch(() => {});
      this._updateEnergyApproximation();
    }
  }

  async _onCapabilityTargetTemp(value) {
    const rounded = Math.round(value);
    this.log('Set target_temperature →', rounded, '°C');
    await this._sendControl({ temperature_setting: rounded });
  }

  async _onCapabilityHeating(value) {
    this.log('Set onoff.heating →', value);
    await this._sendControl({ heater_state: value ? 1 : 0 });
    if (value && !this.getCapabilityValue('onoff.filter')) {
      this.log('Heating on — auto-enabling filter pump.');
      await this.triggerCapabilityListener('onoff.filter', true).catch(err =>
        this.error('Auto-enable filter failed:', err.message),
      );
    }
  }

  async _onCapabilityFilter(value) {
    this.log('Set onoff.filter →', value);
    await this._sendControl({ filter_state: value ? 1 : 0 });
  }

  // Used by Flow action cards (filter_pump_turn_on/off/toggle)
  async setFilterPump(value) {
    return this.triggerCapabilityListener('onoff.filter', !!value);
  }

  async _onCapabilityAirjetLow(value) {
    this.log('Set onoff.airjet_low →', value);
    await this._sendControl({ wave_state: value ? 50 : 0 });
    if (value) {
      await this.setCapabilityValue('onoff.airjet_high', false)
        .catch(e => this.error('set onoff.airjet_high:', e));
    }
  }

  async _onCapabilityAirjetHigh(value) {
    this.log('Set onoff.airjet_high →', value);
    await this._sendControl({ wave_state: value ? 100 : 0 });
    if (value) {
      await this.setCapabilityValue('onoff.airjet_low', false)
        .catch(e => this.error('set onoff.airjet_low:', e));
    }
  }

  async _onCapabilityHydrojet(value) {
    this.log('Set onoff.hydrojet →', value);
    await this._sendControl({ hydrojet_state: value ? 1 : 0 });
  }

  async _onCapabilityLocked(value) {
    this.log('Set bestway_locked →', value);
    await this._sendControl({ locked: value ? 1 : 0 });
  }

  _updateEnergyApproximation() {
    if (this.getSetting('power_sensor_enabled') !== 'yes') return;

    const standby = Number(this.getSetting('power_standby_w')) || 2;

    const airjetHigh = this.getCapabilityValue('onoff.airjet_high');
    const airjetLow  = this.getCapabilityValue('onoff.airjet_low');
    const hydrojet   = this.getCapabilityValue('onoff.hydrojet');

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
    } else if (this.getCapabilityValue('onoff.heating') && this.getCapabilityValue('onoff.filter')) {
      usageOn = Number(this.getSetting('power_heating_w')) || 0;
    } else if (this.getCapabilityValue('onoff.filter')) {
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

  async _sendControl(updates) {
    let lastErr;

    for (let attempt = 1; attempt <= CONTROL_MAX_ATTEMPTS; attempt++) {
      try {
        await this._ensureToken();
        const deviceId  = this.getData().id;
        const productId = this.getStoreValue('productId');
        this.log(`Connect control (attempt ${attempt}) →`, JSON.stringify(updates));
        await this._client.control(deviceId, productId, updates);
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
