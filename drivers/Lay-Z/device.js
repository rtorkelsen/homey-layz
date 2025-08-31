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
        // Errors: E01..E32
        errors: (() => {
          const a = [];
          for (let i = 1; i <= 32; i++) {
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
  
    // Remove legacy capability if present
    await this.removeCapability('system_error').catch(this.error);
  
    // *** Common capabilities (shared by all models) ****
    await this.enableCapability('onoff', this.getSetting('power_control_enabled'));
    await this.enableCapability('pump_onoff', this.getSetting('filter_pump_control_enabled'));
    await this.enableCapability('heat_temp_reach', true);
    await this.enableCapability('pump_state', true);
    await this.enableCapability('heat_state', true);
    await this.enableCapability('temp_now', true);
    await this.enableCapability('measure_power', true);
    await this.enableCapability('measure_temperature', true);
    await this.enableCapability('target_temperature', true);
    await this.enableCapability('thermostat_mode', true);
    await this.enableCapability('alarm_generic', true);
  
    // *** Model-specific capabilities ***
    const isHydro = this.adapter?.id === 'Hydrojet_Pro';
  
    // Airjet bubble toggle only on non-Hydrojet
    await this.enableCapability('msg_onoff', !isHydro && this.getSetting('wave_control_enabled'));
  
    // Hydrojet-only controls
    await this.enableCapability('massage_mode', isHydro);
    await this.enableCapability('jet_onoff', isHydro);
  
    // Register capability listeners (safe to register even if capability isn't present)
    this.log('Registering capability listeners...');
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('onoff',              this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('thermostat_mode',    this.onCapabilityThermostatMode.bind(this));
    this.registerCapabilityListener('pump_onoff',         this.onCapabilityPumpOnoff.bind(this));
    this.registerCapabilityListener('msg_onoff',          this.onCapabilityMsgOnoff.bind(this));
    this.registerCapabilityListener('massage_mode',       this.onCapabilityMassageMode.bind(this));
    this.registerCapabilityListener('jet_onoff',          this.onCapabilityJetOnoff.bind(this));
    this.log('Capability listeners registered');
  
    // Polling
    this.updateInterval = setInterval(async () => {
      await this.updateOnlineStatus();
      await this.updateDeviceStatus();
    }, 1 * 60 * 1000);
  
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
      await this.enableCapability('massage_mode', isHydro);
      await this.enableCapability('jet_onoff',     isHydro);
      await this.enableCapability('msg_onoff', !isHydro && this.getSetting('wave_control_enabled'));

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
      await this.safeSetCapabilityValue('target_temperature', n.heatOn ? n.tempSet : null);
      await this.safeSetCapabilityValue('measure_temperature', n.tempNow);
      await this.safeSetCapabilityValue('thermostat_mode', n.heatOn ? 'heat' : 'off');
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
      await this.safeSetCapabilityValue('heat_temp_reach', n.heatReached);
      await this.safeSetCapabilityValue('pump_state', n.filterOn);
      await this.safeSetCapabilityValue('heat_state', n.heatOn);

      // Hydrojet-only capability values
      await this.safeSetCapabilityValue('massage_mode', n.waveLevel);
      await this.safeSetCapabilityValue('jet_onoff',    n.jetOn);

      // Power estimate using settings
      const heaterWatts = this.getSetting('heater_power');
      const filterWatts = this.getSetting('filter_pump_power');
      const heaterActive = n.heatOn && !n.heatReached;
      const powerConsumption = (heaterActive ? heaterWatts : 0) + (n.filterOn ? filterWatts : 0);
      await this.safeSetCapabilityValue('measure_power', powerConsumption);

      // Errors / warnings
      const hasErrors = Array.isArray(n.errors) && n.errors.length > 0;
      await this.safeSetCapabilityValue('alarm_generic', hasErrors);
      if (hasErrors) {
        await this.setWarning(`System error(s): ${n.errors.join(', ')}`);
      } else {
        await this.unsetWarning();
      }

    } catch (error) {
      if (error?.response) {
        this.error(`Server responded with status code: ${error.response.status}`, error.message);
      } else if (error?.request) {
        this.error('No response received from the server', error.message);
      } else {
        this.error('Failed to update device status', error?.message ? error.message : String(error));
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
        else await this.setUnavailable();
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
    // Do not write undefined or NaN into a capability
    if (typeof value === 'undefined' || (typeof value === 'number' && Number.isNaN(value))) return;
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

  // Capability: thermostat mode -> translates to heat on/off
  async onCapabilityThermostatMode(value) {
    switch (value) {
      case 'heat':
        await this.setHeatPower(1);
        break;
      case 'off':
        await this.setHeatPower(0);
        break;
      default:
        this.log('Unsupported thermostat_mode value');
        break;
    }
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
    if (changedKeys.includes('wave_control_enabled')) {
      // Only applies to Airjet; Hydrojet uses massage_mode instead.
      const isHydro = this.adapter?.id === 'Hydrojet_Pro';
      await this.enableCapability('msg_onoff', !isHydro && newSettings.wave_control_enabled);
    }
    await this.updateDeviceStatus();
  }
}

module.exports = SpaDevice;
