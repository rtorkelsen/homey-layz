'use strict';

const Homey = require('homey');
const {
  BestwayClient,
  GizwitsError,
} = require('../../lib/BestwayClient');

const E_CODE_DESCRIPTIONS = {
  E01: { en: 'Flow sensor error (paddle stuck)',   de: 'Durchflusssensor-Fehler (Paddel blockiert)' },
  E02: { en: 'Insufficient water flow',            de: 'Unzureichender Wasserfluss' },
  E05: { en: 'Temperature sensor error',           de: 'Temperatursensor-Fehler' },
  E06: { en: 'Pump test failed',                   de: 'Pumpentest fehlgeschlagen' },
  E08: { en: 'Thermal cutoff triggered (>55 °C)',  de: 'Thermoschutz ausgelöst (>55 °C)' },
};

const DEFAULT_POLL_INTERVAL_S = 60;
const MAX_POLL_INTERVAL_S     = 300;
const TOKEN_REFRESH_BUFFER_S  = 5 * 60;
const CONTROL_MAX_ATTEMPTS    = 2;
const CONTROL_RETRY_DELAY_MS  = 2000;

class PoolFilterDevice extends Homey.Device {

  async onInit() {
    this.log('Pool Filter device init:', this.getName());

    this._client              = new BestwayClient({ region: this._resolveRegion() });
    this._pollTimer           = null;
    this._pollFailCount       = 0;
    this._tokenRefreshPromise = null;
    this._prevAlarmActive     = false;
    this._prevChangeRequired  = false;

    await this.setSettings({ region: this._resolveRegion() }).catch(() => {});

    const REQUIRED = [
      'onoff', 'bestway_filter_timer', 'bestway_filter_change',
      'alarm_generic', 'bestway_error_message',
    ];
    for (const cap of REQUIRED) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err =>
          this.error(`Failed to add capability "${cap}":`, err.message),
        );
      }
    }

    this.registerCapabilityListener('onoff',                this._onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('bestway_filter_timer', this._onCapabilityTimer.bind(this));

    const d = this.getData();
    if (d.fwMcuSoft && d.fwMcuSoft !== '–') {
      await this.setSettings({
        debug_fw_mcu_soft:  d.fwMcuSoft,
        debug_fw_mcu_hard:  d.fwMcuHard  ?? '–',
        debug_fw_wifi_soft: d.fwWifiSoft ?? '–',
        debug_fw_wifi_hard: d.fwWifiHard ?? '–',
      }).catch(() => {});
    } else {
      this._fetchAndStoreFirmwareInfo().catch(err =>
        this.log('Could not fetch firmware info:', err.message),
      );
    }

    await this._syncStatus().catch(err => this.error('Initial sync failed:', err.message));
    this._startPolling();
  }

  async onUninit() { this._stopPolling(); }
  async onDeleted() { this._stopPolling(); }

  async onSettings({ newSettings }) {
    const raw     = Number(newSettings.poll_interval);
    const clamped = Number.isFinite(raw) ? Math.max(10, Math.min(300, raw)) : DEFAULT_POLL_INTERVAL_S;
    if (clamped !== raw) this.setSettings({ poll_interval: clamped }).catch(() => {});
    this._client = new BestwayClient({ region: newSettings.region ?? 'eu' });
    this._pollFailCount = 0;
    this._startPolling();
  }

  _getPollIntervalMs() {
    const base   = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL_S;
    const factor = Math.min(this._pollFailCount, 3);
    return Math.round(Math.min(base * (2 ** factor), MAX_POLL_INTERVAL_S)) * 1000;
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
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  }

  async _getValidToken() {
    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = this.getStoreValue('tokenExpiry') ?? 0;
    const token  = this.getStoreValue('userToken');

    if (token && expiry > nowSec + TOKEN_REFRESH_BUFFER_S) return token;

    if (this._tokenRefreshPromise) return this._tokenRefreshPromise;

    const username = this.getStoreValue('username');
    const password = this.getStoreValue('password');
    if (!username || !password) throw new Error(this.homey.__('error.credentials_missing'));

    this._tokenRefreshPromise = this._client.login(username, password)
      .then(async auth => {
        await this.setStoreValue('userToken',   auth.userToken);
        await this.setStoreValue('userId',      auth.userId);
        await this.setStoreValue('tokenExpiry', auth.expiry);
        return auth.userToken;
      })
      .finally(() => { this._tokenRefreshPromise = null; });

    return this._tokenRefreshPromise;
  }

  async _setCapability(cap, value) {
    if (!this.hasCapability(cap)) return;
    await this.setCapabilityValue(cap, value).catch(e => this.error(`set ${cap}:`, e));
  }

  async _syncStatus() {
    try {
      const token    = await this._getValidToken();
      const deviceId = this.getData().id;
      const status   = await this._client.getDeviceStatus(token, deviceId);
      const attrs    = status.attr ?? status.attrs ?? {};

      this.log('Pool filter status attrs:', JSON.stringify(attrs));

      if (attrs.power !== undefined) {
        await this._setCapability('onoff', attrs.power === 1 || attrs.power === true);
      }

      if (typeof attrs.time === 'number') {
        await this._setCapability('bestway_filter_timer', attrs.time);
      }

      // 'filter' attribute is truthy when the filter cartridge needs replacing.
      const changeRequired = !!attrs.filter;
      await this._setCapability('bestway_filter_change', changeRequired);

      if (changeRequired && !this._prevChangeRequired) {
        this.driver._triggerChangeTriggered
          .trigger(this)
          .catch(e => this.error('Flow trigger pool_filter_change_triggered failed:', e));
      }
      this._prevChangeRequired = changeRequired;

      const lang = this.homey.i18n.getLanguage();
      const activeCodes = Object.entries(attrs)
        .filter(([key, val]) => /^E\d{2}$/.test(key) && val !== 0)
        .map(([key]) => {
          const entry = E_CODE_DESCRIPTIONS[key];
          return `${key}: ${entry ? (entry[lang] ?? entry.en) : key}`;
        });

      await this._setCapability('alarm_generic', activeCodes.length > 0);
      await this._setCapability(
        'bestway_error_message',
        activeCodes.length > 0 ? activeCodes.join(' | ') : '–',
      );

      if (activeCodes.length > 0 && !this._prevAlarmActive) {
        this.driver._triggerErrorTriggered
          .trigger(this, { error_message: activeCodes.join(' | ') })
          .catch(e => this.error('Flow trigger pool_filter_error_triggered failed:', e));
      }
      this._prevAlarmActive = activeCodes.length > 0;

      this._updateDebugSettings(attrs);
      this._pollFailCount = 0;
      this.setAvailable().catch(() => {});

    } catch (err) {
      const gizCode = err instanceof GizwitsError ? err.code : null;

      if (gizCode === 9004) {
        this.setStoreValue('tokenExpiry', 0).catch(() => {});
      }

      if (gizCode === 9042) {
        this._updateDebugSettings(null, this.homey.__('error.device_offline'));
        this.setUnavailable(this.homey.__('error.device_offline')).catch(() => {});
        throw err;
      }

      this._pollFailCount++;
      this.error(`Sync failed (consecutive: ${this._pollFailCount}):`, err.message);
      this._updateDebugSettings(null, err.message);
      if (this._pollFailCount >= 3) this.setUnavailable(err.message).catch(() => {});
      throw err;
    }
  }

  async _onCapabilityOnoff(value) {
    this.log('Set onoff →', value);
    await this._sendControl({ power: value ? 1 : 0 });
  }

  async _onCapabilityTimer(value) {
    const hours = Math.round(Math.max(0, Math.min(24, value)));
    this.log('Set bestway_filter_timer →', hours, 'h');
    await this._sendControl({ time: hours });
  }

  _updateDebugSettings(attrs, error = null) {
    const timestamp = new Date().toLocaleString('sv-SE', { timeZone: this.homey.clock.getTimezone() });
    const updates = {
      debug_last_sync: timestamp,
      debug_status:    error ? `Error: ${error}` : 'OK ✓',
      debug_product:   this.getData().productName ?? '–',
      debug_region:    this._resolveRegion(),
    };
    if (attrs) {
      const activeCodes = Object.entries(attrs)
        .filter(([k, v]) => /^E\d{2}$/.test(k) && v !== 0)
        .map(([k]) => k);
      updates.debug_errors = activeCodes.length > 0 ? activeCodes.join(', ') : '–';
      updates.debug_raw    = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join(' | ');
    }
    this.setSettings(updates).catch(() => {});
  }

  async _fetchAndStoreFirmwareInfo() {
    const token = await this._getValidToken();
    const info  = await this._client.getDeviceInfo(token, this.getData().id);
    if (!info) return;
    await this.setSettings({
      debug_fw_mcu_soft:  info.mcu_soft_version  ?? '–',
      debug_fw_mcu_hard:  info.mcu_hard_version  ?? '–',
      debug_fw_wifi_soft: info.wifi_soft_version ?? '–',
      debug_fw_wifi_hard: info.wifi_hard_version ?? '–',
    }).catch(() => {});
  }

  _resolveRegion() {
    return this.getSetting('region') || this.getStoreValue('region') || 'eu';
  }

  async _sendControl(attrs) {
    let lastErr;
    for (let attempt = 1; attempt <= CONTROL_MAX_ATTEMPTS; attempt++) {
      try {
        const token    = await this._getValidToken();
        const deviceId = this.getData().id;
        this.log(`Control (attempt ${attempt}) →`, JSON.stringify(attrs));
        await this._client.control(token, deviceId, attrs);
        return;
      } catch (err) {
        lastErr = err;
        const isPermanent = err instanceof GizwitsError && err.code === 9020;
        if (isPermanent || attempt >= CONTROL_MAX_ATTEMPTS) break;
        await new Promise(r => setTimeout(r, CONTROL_RETRY_DELAY_MS));
      }
    }
    this.error('Control failed after retry:', lastErr.message);
    throw new Error(this.homey.__('error.control_failed'));
  }

}

module.exports = PoolFilterDevice;
