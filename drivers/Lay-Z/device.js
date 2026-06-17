'use strict';

const Homey = require('homey');
const axios = require('axios');

/**
 * Model registry with pluggable adapters.
 * Add future models by appending a new adapter object to MODEL_REGISTRY.
 */
const MODEL_REGISTRY = [
  {
    id: 'Airjet',
    match: {
      productNames: ['Airjet'],
      // Structural signature: Airjet exposes temp_now / temp_set
      is: (attr) => typeof attr?.temp_now !== 'undefined' || typeof attr?.temp_set !== 'undefined',
      priority: 10,
    },
    normalize(attr) {
      const unit = (attr?.temp_set_unit === '华氏') ? 'F' : 'C';
      return {
        powerOn:  attr?.power === 1,
        heatOn:   attr?.heat_power === 1,
        filterOn: attr?.filter_power === 1,
        waveOn:   attr?.wave_power === 1,
        tempNow:  attr?.temp_now,
        tempSet:  attr?.temp_set,
        unit,
        heatReached: attr?.heat_temp_reach === 1,
        locked: attr?.bit2 === 1,
        errors: (() => {
          const a = [];
          for (let i = 1; i <= 9; i++) if (attr?.[`system_err${i}`] === 1) a.push(`E0${i}`);
          return a;
        })(),
      };
    },
    encode(cmd, value) {
      switch (cmd) {
        case 'power':   return { attrs: { power: value ? 1 : 0 } };
        case 'heat':    return { attrs: { heat_power: value ? 1 : 0 } };
        case 'filter':  return { attrs: { filter_power: value ? 1 : 0 } };
        case 'wave':    return { attrs: { wave_power: value ? 1 : 0 } };
        case 'tempSet': return { attrs: { temp_set: value } };
        case 'lock':    return { attrs: { locked: value ? 1 : 0 } };
        default:        return { attrs: {} };
      }
    },
  },

  {
    id: 'Hydrojet_Pro',
    match: {
      productNames: ['Hydrojet_Pro'],
      // Structural signature: Hydrojet exposes Tnow / Tset
      is: (attr) => typeof attr?.Tnow !== 'undefined' || typeof attr?.Tset !== 'undefined',
      priority: 10,
    },
    normalize(attr) {
      // Hydrojet: Tunit === 1 → Celsius
      const unit = (typeof attr?.Tunit === 'number') ? (attr.Tunit === 1 ? 'C' : 'F') : 'C';
      // Map wave numeric to enum
      const waveLevel =
        attr?.wave === 100 ? 'high' :
        attr?.wave === 42  ? 'low'  : 'off';

      return {
        powerOn:  attr?.power  === 1,
        // Heat can report >=1 when on (e.g., 1, 3, 4...). Treat any value >= 1 as ON.
        heatOn:   (attr?.heat ?? 0) >= 1,
        // Filter is 0/2 (2 means ON)
        filterOn: attr?.filter === 2,
        // Legacy wave toggle (0/1); kept for backward compatibility
        waveOn:   attr?.wave   === 1,
        // Hydrojet-specific extras
        waveLevel,                 // enum: off/low/high
        jetOn:    attr?.jet === 1, // boolean 0/1
        tempNow:  attr?.Tnow,
        tempSet:  attr?.Tset,
        unit,
        // No explicit flag on Hydrojet; derive from temps
        heatReached: (typeof attr?.Tnow === 'number' && typeof attr?.Tset === 'number') ? (attr.Tnow >= attr.Tset) : false,
        locked: attr?.bit2 === 1,
        // Errors: E01..E31 (E32 = temp-reached signal, not an error)
        errors: (() => {
          const a = [];
          for (let i = 1; i <= 31; i++) {
            const k = `E${String(i).padStart(2, '0')}`;
            if (attr?.[k] === 1) a.push(k);
          }
          return a;
        })(),
      };
    },
    encode(cmd, value) {
      switch (cmd) {
        case 'power':     return { attrs: { power:  value ? 1 : 0 } };
        // Write 1 to turn heat ON, 0 to turn heat OFF (status may later report 3/4/etc.)
        case 'heat':      return { attrs: { heat:   value ? 1 : 0 } };
        // Filter uses 0/2 mapping (2=ON)
        case 'filter':    return { attrs: { filter: value ? 2 : 0 } };
        // Legacy wave toggle (0/1)
        case 'wave':      return { attrs: { wave:   value ? 1 : 0 } };
        // Explicit massage levels → wave numeric values
        case 'waveLevel': {
          const map = { off: 0, low: 42, high: 100 };
          return { attrs: { wave: map[String(value)] ?? 0 } };
        }
        // Hydrojet on/off
        case 'jet':       return { attrs: { jet: value ? 1 : 0 } };
        case 'tempSet':   return { attrs: { Tset:   value } };
        case 'lock':      return { attrs: { locked: value ? 1 : 0 } };
        default:          return { attrs: {} };
      }
    },
  },
];

/** Adapter selector helpers (prefer product_name; fall back to payload signature). */
function selectAdapterByProductName(productName) {
  if (!productName) return null;
  const name = String(productName).trim();
  return MODEL_REGISTRY.find(a => a.match.productNames?.includes(name)) || null;
}
function selectAdapterBySignature(attr) {
  const candidates = MODEL_REGISTRY
    .filter(a => typeof a.match?.is === 'function' && a.match.is(attr))
    .sort((a, b) => (b.match?.priority || 0) - (a.match?.priority || 0));
  return candidates[0] || null;
}

class SpaDevice extends Homey.Device {

  async onInit() {
    this.log('SpaDevice is initializing...');
  
  // *** Backfill per-device store from legacy app settings if missing ***
  // NOTE: Only backfill if the legacy token/baseUrl actually contains THIS did.
  let store = this.getStore() || {};
    if (!store.token || !store.baseUrl || !store.appId) {
      const legacyToken   = this.homey.settings.get('token');
      const legacyBaseUrl = this.homey.settings.get('baseUrl');
      const legacyAppId   = this.homey.settings.get('appId');
      const legacyUid     = this.homey.settings.get('uid');
      const legacyExpire  = this.homey.settings.get('expire_at');

      if (legacyToken && legacyBaseUrl && legacyAppId) {
        try {
          // Verify that this DID belongs to the legacy token/baseUrl
          const resp = await axios.get(`${legacyBaseUrl}/app/bindings`, {
            headers: {
              'X-Gizwits-Application-Id': legacyAppId,
              'X-Gizwits-User-token': legacyToken,
            },
          });
          const list = Array.isArray(resp?.data?.devices) ? resp.data.devices : [];
          const found = list.find(d => d?.did === this.getData().did);

          if (found) {
            this.log('Backfilling per-device store from legacy app settings (verified DID on legacy baseUrl).');
            if (typeof this.setStore === 'function') {
              try {
                await this.setStore({
                  token: legacyToken,
                  baseUrl: legacyBaseUrl,
                  appId: legacyAppId,
                  uid: legacyUid,
                  expire_at: legacyExpire,
                });
                store = this.getStore() || {};
              } catch (e) {
                this.error('setStore failed; using legacy credentials in-memory only', e);
                store = {
                  token: legacyToken,
                  baseUrl: legacyBaseUrl,
                  appId: legacyAppId,
                  uid: legacyUid,
                  expire_at: legacyExpire,
                };
              }
            } else {
              // Very old SDK fallback
              store = {
                token: legacyToken,
                baseUrl: legacyBaseUrl,
                appId: legacyAppId,
                uid: legacyUid,
                expire_at: legacyExpire,
              };
            }
          } else {
            this.log('Legacy credentials do not contain this DID; skipping backfill. Please re-pair this device.');
          }
        } catch (e) {
          this.error('Failed to verify legacy credentials against /app/bindings; skipping backfill', e?.message || e);
        }
      }
    }

  
    // *** Default request headers (Application-Id is required by Gizwits) ****
    this._userToken = store.token;
    this.baseUrl    = store.baseUrl;
    const appId     = store.appId;

    if (!this._userToken || !this.baseUrl || !appId) {
      this.error('Missing per-device credentials in store. Please re-pair this device.');
    }

    this.headers = {
      'X-Gizwits-Application-Id': appId || '', 
      'Content-Type': 'application/json; charset=UTF-8',
    };

    this.log('Auth initialized for DID:', this.getData().did, 'baseUrl:', this.baseUrl, 'hasToken:', !!this._userToken, 'hasAppId:', !!appId)
    // Choose adapter by product_name (fallback to Airjet until first payload arrives)
    const data = this.getData();
    this.log('Device data from Homey:', data);
    this.adapter = selectAdapterByProductName(data?.product_name)
      || MODEL_REGISTRY.find(a => a.id === 'Airjet');
    this.log('Initial adapter:', this.adapter?.id);
  
    // Migrate device class (was 'thermostat', must be 'other' for configurable status display)
    if (this.getClass() !== 'other') {
      await this.setClass('other').catch(this.error);
    }

    // Remove legacy capabilities if present
    for (const old of ['system_error', 'heat_temp_reach', 'thermostat_mode']) {
      await this.removeCapability(old).catch(() => {});
    }

    // New capabilities (migration: add if not present)
    for (const cap of ['bestway_error_message', 'bestway_temp_reached', 'meter_power']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    // Capability order migration (runs once per device, skipped for new devices
    // that are already paired with the correct driver.compose.json order)
    const REORDER_VERSION = 6;
    const storedVersion = this.getStoreValue('capOrderVersion') || 0;
    this.log(`Capability order: stored=${storedVersion}, required=${REORDER_VERSION}`);
    if (storedVersion < REORDER_VERSION) {
      const ORDERED_CAPS = [
        'temp_now', 'measure_temperature', 'target_temperature',
        'bestway_temp_reached', 'onoff', 'onoff.heating', 'pump_onoff', 'msg_onoff',
        'heat_state', 'alarm_generic', 'bestway_error_message', 'bestway_locked',
        'pump_state', 'measure_power', 'meter_power',
        'airjet_low', 'airjet_high', 'jet_onoff',
      ];

      // Check whether the relative order of present caps already matches ORDERED_CAPS.
      // If it does, skip the disruptive remove/re-add cycle.
      const snapshot = this.getCapabilities();
      const desired  = ORDERED_CAPS.filter(c => snapshot.includes(c));
      const actual   = snapshot.filter(c => ORDERED_CAPS.includes(c));
      const alreadyCorrect = desired.every((cap, i) => actual[i] === cap);

      if (alreadyCorrect) {
        this.log('Capability order already correct — skipping reorder migration.');
        await this.setStoreValue('capOrderVersion', REORDER_VERSION).catch(() => {});
      } else {
        this.log('Running capability reorder migration v6...');
        this.log('Current order:', snapshot.join(', '));
        this.log('Expected order:', desired.join(', '));

        // Phase 1 – removal pass 1: remove all current caps
        for (const cap of snapshot) {
          await this.removeCapability(cap).catch(e => this.log(`  remove ${cap} (pass 1):`, e.message));
        }

        // Give Homey time to commit all removes before checking / retrying
        await new Promise(r => setTimeout(r, 500));

        // Phase 1 – removal pass 2: retry any caps still present
        const afterPass1 = this.getCapabilities();
        if (afterPass1.length > 0) {
          this.log('Caps still present after pass 1 (retrying):', afterPass1.join(', '));
          for (const cap of afterPass1) {
            await this.removeCapability(cap).catch(e => this.log(`  remove ${cap} (pass 2):`, e.message));
          }
          await new Promise(r => setTimeout(r, 300));
        }

        const stuck = this.getCapabilities();
        if (stuck.length > 0) this.log('Permanently stuck caps:', stuck.join(', '));

        // Phase 2 – re-add in desired order (only caps that were in the snapshot
        // AND were actually removed; stuck caps stay at their current positions)
        for (const cap of ORDERED_CAPS) {
          if (snapshot.includes(cap) && !this.hasCapability(cap)) {
            await this.addCapability(cap).catch(e => this.log(`  add ${cap}:`, e.message));
          }
        }

        await this.setStoreValue('capOrderVersion', REORDER_VERSION).catch(() => {});
        this.log('Migration complete. Final caps:', this.getCapabilities().join(', '));
      }
    }

    // State tracking for rising-edge triggers and energy accumulation
    this._prevTempReached = false;
    this._prevAlarmActive = false;
    this._energyLastTs    = null;
    this._energyLastWatts = 0;
    this._pollFailCount   = 0;

    // *** Common capabilities (shared by all models) ****
    await this.enableCapability('onoff', this.getSetting('power_control_enabled'));
    await this.enableCapability('onoff.heating', true);
    await this.enableCapability('pump_onoff', this.getSetting('filter_pump_control_enabled'));
    await this.enableCapability('pump_state', true);
    await this.enableCapability('heat_state', true);
    await this.enableCapability('temp_now', true);
    await this.enableCapability('measure_power', true);
    await this.enableCapability('measure_temperature', true);
    await this.enableCapability('target_temperature', true);
    await this.enableCapability('bestway_temp_reached', true);
    await this.enableCapability('bestway_error_message', true);
    await this.enableCapability('alarm_generic', true);
  
    // *** Model-specific capabilities ***
    const isHydro = this.adapter?.id === 'Hydrojet_Pro';

    // Wave/bubble toggle: Airjet only (Hydrojet uses airjet_low/high buttons instead)
    await this.enableCapability('msg_onoff', !isHydro);

    // Hydrojet-only controls (massage_mode replaced by airjet_low/high buttons)
    await this.removeCapability('massage_mode').catch(() => {});
    // Migrate: remove old sub-capability names if present
    for (const old of ['onoff.airjet_low', 'onoff.airjet_high']) {
      await this.removeCapability(old).catch(() => {});
    }

    await this.enableCapability('airjet_low',  isHydro);
    await this.enableCapability('airjet_high', isHydro);
    await this.enableCapability('jet_onoff',         isHydro);
    // Lock is Airjet-only (Hydrojet write command has no effect per ha-bestway)
    await this.enableCapability('bestway_locked',    !isHydro);

    // Register capability listeners (safe to register even if capability isn't present)
    this.log('Registering capability listeners...');
    this.registerCapabilityListener('target_temperature',  this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('onoff',               this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('onoff.heating',        this.onCapabilityHeating.bind(this));
    this.registerCapabilityListener('pump_onoff',          this.onCapabilityPumpOnoff.bind(this));
    this.registerCapabilityListener('msg_onoff',           this.onCapabilityMsgOnoff.bind(this));
    this.registerCapabilityListener('airjet_low',          this.onCapabilityAirjetLow.bind(this));
    this.registerCapabilityListener('airjet_high',         this.onCapabilityAirjetHigh.bind(this));
    this.registerCapabilityListener('jet_onoff',           this.onCapabilityJetOnoff.bind(this));
    this.registerCapabilityListener('bestway_locked',      this.onCapabilityBestwayLocked.bind(this));
    this.log('Capability listeners registered');
  
    // Polling
    this._startPolling();
    await this.updateOnlineStatus();
    await this.updateDeviceStatus();
  
    this.log('SpaDevice has been initialized');
  }
  

  async enableCapability(capability, enabled) {
    if (enabled && !this.hasCapability(capability)) {
      await this.addCapability(capability).catch(this.error);
    } else if (!enabled && this.hasCapability(capability)) {
      await this.removeCapability(capability).catch(this.error);
    }
  }

  async updateDeviceStatus() {
    this.log('updateDeviceStatus started');
    try {
      const data = await this.fetchDeviceData();
      const { attr } = data || {};
      if (!attr) throw new Error('attr field missing in response data');

      // Re-select adapter by signature if payload indicates a better match
      const bySig = selectAdapterBySignature(attr);
      if (bySig && bySig.id !== this.adapter.id) {
        this.log(`Switching adapter based on payload signature: ${this.adapter.id} -> ${bySig.id}`);
        this.adapter = bySig;
      }

      // Toggle Hydrojet-only caps dynamically (in case adapter changed)
      const isHydro = this.adapter?.id === 'Hydrojet_Pro';
      await this.enableCapability('airjet_low',  isHydro);
      await this.enableCapability('airjet_high', isHydro);
      await this.enableCapability('jet_onoff',   isHydro);
      await this.enableCapability('msg_onoff',         !isHydro);
      await this.enableCapability('bestway_locked',    !isHydro);

      // Normalize and log snapshot
      const n = this.adapter.normalize(attr);
      this.log('Normalized snapshot:', {
        adapter: this.adapter.id,
        powerOn: n.powerOn, heatOn: n.heatOn, filterOn: n.filterOn, waveOn: n.waveOn,
        tempNow: n.tempNow, tempSet: n.tempSet, unit: n.unit, heatReached: n.heatReached,
        waveLevel: n.waveLevel, jetOn: n.jetOn
      });

      // Update UI units for target temperature
      const units = n.unit === 'F' ? '°F' : '°C';
      const options = {
        units: { en: units, no: units },
        min: units === '°F' ? 68 : 20,
        max: units === '°F' ? 104 : 40,
        step: 1,
        decimals: 0,
      };
      await this.setCapabilityOptions('target_temperature', options);

      // Update common capabilities (read)
      await this.safeSetCapabilityValue('target_temperature', n.tempSet);
      await this.safeSetCapabilityValue('measure_temperature', n.tempNow);

      // Fire Flow triggers when heating state changes
      const prevHeating = this._prevHeatingOn;
      await this.safeSetCapabilityValue('onoff.heating', n.heatOn);
      if (prevHeating !== undefined && prevHeating !== n.heatOn) {
        if (n.heatOn) {
          try { await this.homey.flow.getDeviceTriggerCard('heating_turned_on').trigger(this, {}, {}); }
          catch (e) { this.error('Trigger heating_turned_on failed', e); }
        } else {
          try { await this.homey.flow.getDeviceTriggerCard('heating_turned_off').trigger(this, {}, {}); }
          catch (e) { this.error('Trigger heating_turned_off failed', e); }
        }
      }
      this._prevHeatingOn = n.heatOn;

      await this.safeSetCapabilityValue('temp_now', n.tempNow);

      await this.safeSetCapabilityValue('onoff', n.powerOn);
      // Fire Flow triggers when filter state changes
      
      const prev = this._prevFilterOn; // Keep previous value BEFORE updating capability

      await this.safeSetCapabilityValue('pump_onoff', n.filterOn);

      if (prev !== undefined && prev !== n.filterOn) {
        try { await this.homey.flow.getDeviceTriggerCard('filter_pump_changed').trigger(this, {}, {}); }
        catch (e) { this.error('Trigger filter_pump_changed failed', e); }

        if (n.filterOn) {
          try { await this.homey.flow.getDeviceTriggerCard('filter_pump_turned_on').trigger(this, {}, {}); }
          catch (e) { this.error('Trigger filter_pump_turned_on failed', e); }
        } else {
          try { await this.homey.flow.getDeviceTriggerCard('filter_pump_turned_off').trigger(this, {}, {}); }
          catch (e) { this.error('Trigger filter_pump_turned_off failed', e); }
        }
      }

      // Persist for next comparison
      this._prevFilterOn = n.filterOn;

      
      await this.safeSetCapabilityValue('msg_onoff', n.waveOn);
      await this.safeSetCapabilityValue('pump_state', n.filterOn);
      await this.safeSetCapabilityValue('heat_state', n.heatOn);

      // Hydrojet-only capability values
      await this.safeSetCapabilityValue('airjet_low',  n.waveLevel === 'low');
      await this.safeSetCapabilityValue('airjet_high', n.waveLevel === 'high');
      await this.safeSetCapabilityValue('jet_onoff',         n.jetOn);

      // Power estimate using granular settings
      const powerConsumption = this._calculatePower(n);
      await this.safeSetCapabilityValue('measure_power', powerConsumption);

      // Errors / warnings
      const hasErrors = Array.isArray(n.errors) && n.errors.length > 0;
      await this.safeSetCapabilityValue('alarm_generic', hasErrors);
      if (hasErrors) {
        await this.setWarning(`${this.homey.__('error.system_errors')}: ${n.errors.join(', ')}`);
      } else {
        await this.unsetWarning();
      }

      // New: error message, lock state, temp-reached flag
      const errorMsg = hasErrors ? n.errors.join(' | ') : '–';
      await this.safeSetCapabilityValue('bestway_error_message', errorMsg);
      await this.safeSetCapabilityValue('bestway_locked', n.locked ?? false);
      await this.safeSetCapabilityValue('bestway_temp_reached', n.heatReached);

      // Rising-edge: fire spa_temp_reached trigger
      if (n.heatReached && !this._prevTempReached) {
        this.driver._triggerTempReached?.trigger(this, { temperature: n.tempNow ?? 0 })
          .catch(e => this.error('Trigger spa_temp_reached failed', e));
      }
      this._prevTempReached = n.heatReached;

      // Rising-edge: fire spa_error_triggered trigger
      if (hasErrors && !this._prevAlarmActive) {
        this.driver._triggerErrorTriggered?.trigger(this, { error_message: errorMsg })
          .catch(e => this.error('Trigger spa_error_triggered failed', e));
      }
      this._prevAlarmActive = hasErrors;

      // Accumulate energy (kWh)
      this._updateEnergyApproximation(powerConsumption);

      // Debug labels
      this._updateDebugLabels(attr, n, null);

      // Success: reset fail count and ensure device is marked available
      this._pollFailCount = 0;
      if (!this.getAvailable()) await this.setAvailable().catch(() => {});

    } catch (error) {
      if (error?.response) {
        this.error(`Server responded with status code: ${error.response.status}`, error.message);
      } else if (error?.request) {
        this.error('No response received from the server', error.message);
      } else {
        this.error('Failed to update device status', error?.message ? error.message : String(error));
      }
      this._updateDebugLabels(null, null, error?.message || String(error));

      // Mark unavailable after 3 consecutive failures (same pattern as Connect driver)
      this._pollFailCount++;
      if (this._pollFailCount >= 3) {
        await this.setUnavailable(this.homey.__('error.device_offline')).catch(() => {});
      }
    }
  }

  async fetchDeviceData() {
    if (!this._userToken) throw new Error('No token in device store');
    return await this.makeAxiosCall(
      'get',
      `${this.baseUrl}/app/devdata/${this.getData().did}/latest`,
      null,
      this._userToken
    );
  }

  async updateOnlineStatus() {
    this.log('updateOnlineStatus started');
    if (!this._userToken) {
      this.log('No token in device store; cannot query /app/bindings');
      return;
    }
    try {
      const response = await axios.get(`${this.baseUrl}/app/bindings`, {
        headers: { ...this.headers, 'X-Gizwits-User-token': this._userToken },
      });
      // Log response
      try {
        this.log('HTTP GET /app/bindings response status:', response.status);
        this.log('HTTP GET /app/bindings response body:', JSON.stringify(response.data));
      } catch (e) {
        this.log('Failed to stringify /app/bindings response for logging');
      }

      const device = (response?.data && Array.isArray(response.data.devices))
        ? response.data.devices.find((d) => d.did === this.getData().did)
        : null;

      if (device) {
        if (device.is_online) await this.setAvailable();
        else await this.setUnavailable(this.homey.__('error.device_offline'));
      } else {
        this.log(`Device with did ${this.getData().did} not found`);
      }
    } catch (error) {
      this.log('Failed to update online status', error);
    }
  }

  /**
   * Axios wrapper with verbose logging for all requests and responses.
   */
  async makeAxiosCall(method, url, data = null, token = null) {
    const headers = { ...this.headers };
    if (token) headers['X-Gizwits-User-token'] = token;

    // Log outgoing request
    try {
      const logHeaders = { ...headers, 'X-Gizwits-User-token': token ? '[REDACTED]' : undefined };
      this.log('Using per-device auth:', {
        did: this.getData().did,
        baseUrl: this.baseUrl,
        hasToken: !!token,
        appIdHeader: this.headers['X-Gizwits-Application-Id'],
      });
      this.log('HTTP request:', {
        method: method.toUpperCase(),
        url,
        headers: logHeaders,
        body: data,
      });
    } catch (e) {
      this.log('Failed to stringify request for logging');
    }

    try {
      const response = await axios({ method, url, data, headers });

      // Log response status and body
      try {
        this.log('HTTP response:', {
          status: response.status,
          statusText: response.statusText,
          url: url,
          body: response.data,
        });
      } catch (e) {
        this.log('Failed to stringify response for logging');
      }

      return response.data;
    } catch (error) {
      // Log error details
      const status = error?.response?.status ?? 'unknown';
      const respBody = error?.response?.data;
      try {
        this.log('HTTP error:', {
          method: method.toUpperCase(),
          url,
          status,
          message: error?.message ? error.message : String(error),
          responseBody: respBody,
        });
      } catch (e) {
        this.log('Failed to stringify error for logging');
      }
      // Return null to keep callers resilient
      return null;
    }
  }

  async safeSetCapabilityValue(capability, value) {
    if (value === null || typeof value === 'undefined' || (typeof value === 'number' && Number.isNaN(value))) return;
    if (!this.hasCapability(capability)) return;
    await this.setCapabilityValue(capability, value)
      .catch(e => this.error(`Failed to update ${capability}`, e));
  }

  // Capability: target temperature
  async onCapabilityTargetTemperature(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('tempSet', value);
      this.log('Control payload (tempSet):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to set target temperature', error);
    }
  }

  // Capability: on/off (main power)
  async onCapabilityOnoff(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('power', value);
      this.log('Control payload (power):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to change on/off status', error);
    }
  }

  // Capability: heating on/off button
  async onCapabilityHeating(value) {
    return this.setHeatPower(value ? 1 : 0);
  }

  async setHeatPower(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('heat', value);
      this.log('Control payload (heat):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to set heating power status', error);
    }
  }

  // Capability: filter pump
  async onCapabilityPumpOnoff(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('filter', value);
      this.log('Control payload (filter):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to toggle filter pump', error);
    }
  }

  // Helper used by Flow actions to set the filter pump
 async setFilterPump(value) {
    return this.onCapabilityPumpOnoff(!!value);
  }
  

  // Capability: legacy wave/bubbles toggle (0/1)
  async onCapabilityMsgOnoff(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('wave', value);
      this.log('Control payload (wave):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to toggle massage function', error);
    }
  }

  // Capability: AirJet Low button (Hydrojet)
  async onCapabilityAirjetLow(value) {
    return this.onCapabilityMassageMode(value ? 'low' : 'off');
  }

  // Capability: AirJet High button (Hydrojet)
  async onCapabilityAirjetHigh(value) {
    return this.onCapabilityMassageMode(value ? 'high' : 'off');
  }

  // Capability: Hydrojet massage mode (off/low/high) → wave 0/42/100
  async onCapabilityMassageMode(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('waveLevel', value);
      this.log('Control payload (massage_mode):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to set massage mode', error);
    }
  }

  // Capability: Hydrojet main jet 0/1
  async onCapabilityJetOnoff(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('jet', value);
      this.log('Control payload (jet_onoff):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to toggle hydrojet', error);
    }
  }

  // Capability: lock/unlock the control panel
  async onCapabilityBestwayLocked(value) {
    try {
      if (!this._userToken) throw new Error('No token in device store');
      const body = this.adapter.encode('lock', value);
      this.log('Control payload (lock):', JSON.stringify(body));
      await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, body, this._userToken);
      await this.updateDeviceStatus();
    } catch (error) {
      this.error('Failed to set lock state', error);
    }
  }

  // Helpers for spa flow action cards
  async setFilter(value)     { return this.onCapabilityPumpOnoff(!!value); }
  async setHeating(value)    { return this.setHeatPower(value ? 1 : 0); }
  async setAirjetLow(value) {
    if (this.adapter?.id === 'Hydrojet_Pro') return this.onCapabilityAirjetLow(!!value);
    return this.onCapabilityMsgOnoff(!!value);
  }
  async setAirjetHigh(value) {
    if (this.adapter?.id === 'Hydrojet_Pro') return this.onCapabilityAirjetHigh(!!value);
    return this.onCapabilityMsgOnoff(!!value);
  }
  async setHydrojet(value)   {
    if (this.adapter?.id === 'Hydrojet_Pro') return this.onCapabilityJetOnoff(!!value);
    // Airjet has no hydrojet — no-op
  }

  _startPolling() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    const intervalSec = this.getSetting('poll_interval') || 60;
    // Only call updateDeviceStatus on each poll tick — availability is inferred
    // from success/failure inside updateDeviceStatus (no extra API call needed).
    this.updateInterval = setInterval(async () => {
      await this.updateDeviceStatus();
    }, intervalSec * 1000);
  }

  _calculatePower(n) {
    if (this.getSetting('power_sensor_enabled') !== 'yes') return 0;
    const isHydro = this.adapter?.id === 'Hydrojet_Pro';
    const airjetLow  = isHydro ? n.waveLevel === 'low'  : n.waveOn;
    const airjetHigh = isHydro ? n.waveLevel === 'high' : false;
    const hydrojet   = isHydro && n.jetOn;
    const heating    = n.heatOn && !n.heatReached;

    if (hydrojet && airjetHigh) return this.getSetting('power_hydrojet_airjet_high_w');
    if (hydrojet && airjetLow)  return this.getSetting('power_hydrojet_airjet_low_w');
    if (hydrojet)               return this.getSetting('power_hydrojet_w');
    if (airjetHigh)             return this.getSetting('power_airjet_high_w');
    if (airjetLow)              return this.getSetting('power_airjet_low_w');
    if (heating)                return this.getSetting('power_heating_w');
    if (n.filterOn)             return this.getSetting('power_filter_w');
    return this.getSetting('power_standby_w') ?? 0;
  }

  _updateDebugLabels(attr, n, errorMsg) {
    const region = (() => {
      const url = this.baseUrl || '';
      if (url.includes('euapi')) return 'EU';
      if (url.includes('usapi')) return 'US';
      if (url.includes('api.gizwits')) return 'Global';
      return url;
    })();

    const patch = {
      debug_last_sync: new Date().toLocaleString('sv-SE', { timeZone: this.homey.clock.getTimezone() }),
      debug_region:    region,
      debug_product:   `${this.getData()?.product_name || '?'} (${this.adapter?.id || '?'})`,
    };

    if (errorMsg) {
      patch.debug_status = `Error: ${errorMsg}`;
    } else if (n) {
      patch.debug_status = 'OK';
      patch.debug_errors = n.errors?.length ? n.errors.join(', ') : '–';
      if (attr) {
        const raw = JSON.stringify(attr);
        patch.debug_raw = raw.length > 500 ? raw.slice(0, 497) + '…' : raw;
      }
    }

    this.setSettings(patch).catch(e => this.error('Failed to update debug labels', e));
  }

  _updateEnergyApproximation(watts) {
    const now = Date.now();
    if (this._energyLastTs !== null) {
      const elapsedHours = (now - this._energyLastTs) / 3_600_000;
      const deltaKwh = (this._energyLastWatts / 1000) * elapsedHours;
      const current = this.getCapabilityValue('meter_power') ?? 0;
      this.safeSetCapabilityValue('meter_power', current + deltaKwh);
    }
    this._energyLastTs    = now;
    this._energyLastWatts = watts;
  }

  async onDeleted() {
    clearInterval(this.updateInterval);
    this.log('SpaDevice has been deleted');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', { oldSettings, newSettings, changedKeys });
    if (changedKeys.includes('power_control_enabled')) {
      await this.enableCapability('onoff', newSettings.power_control_enabled);
    }
    if (changedKeys.includes('filter_pump_control_enabled')) {
      await this.enableCapability('pump_onoff', newSettings.filter_pump_control_enabled);
    }
    if (changedKeys.includes('poll_interval')) {
      this._startPolling();
    }
    await this.updateDeviceStatus();
  }
}

module.exports = SpaDevice;
