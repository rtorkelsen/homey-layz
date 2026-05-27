'use strict';

const Homey = require('homey');
const {
  BestwayClient,
  GizwitsError,
  loginWithRegionFallback,
} = require('../../lib/BestwayClient');

class PoolFilterDriver extends Homey.Driver {

  async onInit() {
    this.log('Pool Filter driver initialized');

    this._triggerErrorTriggered  = this.homey.flow.getDeviceTriggerCard('pool_filter_error_triggered');
    this._triggerChangeTriggered = this.homey.flow.getDeviceTriggerCard('pool_filter_change_triggered');

    this.homey.flow.getConditionCard('pool_filter_error_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('alarm_generic') === true,
      );

    this.homey.flow.getConditionCard('pool_filter_change_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('bestway_filter_change') === true,
      );
  }

  async onRepair(session, device) {
    this.log('Repair session started for:', device.getName());

    session.setHandler('login', async ({ username, password }) => {
      try {
        const auth = await loginWithRegionFallback(username, password);
        await device.setStoreValue('username',    username);
        await device.setStoreValue('password',    password);
        await device.setStoreValue('region',      auth.region);
        await device.setStoreValue('userToken',   auth.userToken);
        await device.setStoreValue('userId',      auth.userId);
        await device.setStoreValue('tokenExpiry', auth.expiry);
        device._client = new BestwayClient({ region: auth.region });
        device._tokenRefreshPromise = null;
        await device.setSettings({ region: auth.region }).catch(() => {});
        device.setAvailable().catch(() => {});
        this.log('Repair: credentials updated, region:', auth.region);
        return true;
      } catch (err) {
        this.error('Repair: login failed:', err.message);
        const code   = err instanceof GizwitsError ? err.code : null;
        const msgKey = code === 9020 ? 'pair.error.wrong_password' : 'pair.error.login_failed';
        throw new Error(this.homey.__(msgKey));
      }
    });
  }

  async onPair(session) {
    let auth = null;

    session.setHandler('login', async ({ username, password }) => {
      try {
        auth = await loginWithRegionFallback(username, password);
        this.log('Pair: login ok, region:', auth.region);
        return true;
      } catch (err) {
        this.error('Pair: login failed:', err.message);
        const code   = err instanceof GizwitsError ? err.code : null;
        const msgKey = code === 9020 ? 'pair.error.wrong_password' : 'pair.error.login_failed';
        throw new Error(this.homey.__(msgKey));
      }
    });

    session.setHandler('list_devices', async () => {
      if (!auth) throw new Error(this.homey.__('pair.error.not_authenticated'));

      const client = new BestwayClient({ region: auth.region });
      let rawDevices;
      try {
        rawDevices = await client.getDevices(auth.userToken);
      } catch (err) {
        this.error('Pair: failed to list devices:', err.message);
        throw new Error(this.homey.__('pair.error.fetch_devices_failed'));
      }

      if (!rawDevices.length) throw new Error(this.homey.__('pair.error.no_devices'));

      this.log(`Pair: found ${rawDevices.length} device(s)`);

      return rawDevices.map(device => ({
        name: device.dev_alias || device.did,
        data: {
          id:          device.did,
          productName: device.product_name ?? '–',
          fwMcuSoft:   device.mcu_soft_version  ?? '–',
          fwMcuHard:   device.mcu_hard_version  ?? '–',
          fwWifiSoft:  device.wifi_soft_version ?? '–',
          fwWifiHard:  device.wifi_hard_version ?? '–',
        },
        store: {
          username:    auth.username,
          password:    auth.password,
          region:      auth.region,
          userToken:   auth.userToken,
          userId:      auth.userId,
          tokenExpiry: auth.expiry,
        },
      }));
    });
  }

}

module.exports = PoolFilterDriver;
