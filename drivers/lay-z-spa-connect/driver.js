'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient } = require('../../lib/BestwaySmarthubClient');
const { BestwaySmartHomeClient, parseShareInput } = require('../../lib/BestwaySmartHomeClient');

class LaZSpaConnectDriver extends Homey.Driver {

  async onInit() {
    this.log('Lay-Z-Spa Connect driver initialized');

    this._triggerTempReached    = this.homey.flow.getDeviceTriggerCard('spa_temp_reached');
    this._triggerErrorTriggered = this.homey.flow.getDeviceTriggerCard('spa_error_triggered');

    this._triggerFilterPumpChanged   = this.homey.flow.getDeviceTriggerCard('filter_pump_changed');
    this._triggerFilterPumpTurnedOn  = this.homey.flow.getDeviceTriggerCard('filter_pump_turned_on');
    this._triggerFilterPumpTurnedOff = this.homey.flow.getDeviceTriggerCard('filter_pump_turned_off');
    // Flow card run listeners are registered centrally in the Lay-Z driver, which
    // initialises last and whose listeners handle both Lay-Z and Connect devices.
  }

  async onRepair(session, device) {
    this.log('Repair session started for:', device.getName());

    session.setHandler('link_code', async ({ code }) => {
      const raw = (code ?? '').trim();

      // RW_Share_ codes always belong to the legacy SmartHub (Gizwits
      // visitor) backend — route by format, not by the device's stored
      // backend, since a device originally paired on one backend could in
      // principle be re-shared via either app going forward.
      if (raw.startsWith('RW_Share_')) {
        const existingRegion = device.getStoreValue('region') ?? 'eu';
        const visitorId      = device.getStoreValue('visitorId');
        this.log('Repair: received legacy share code, trying regions…');

        const regionsToTry = [...new Set([existingRegion, existingRegion === 'eu' ? 'us' : 'eu'])];
        let client  = null;
        let lastErr = null;

        for (const region of regionsToTry) {
          try {
            const c = new BestwaySmarthubClient({ region, visitorId });
            await c.authenticate();
            await c.linkShareCode(raw);
            client = c;
            this.log(`Repair: share code accepted (${region}, SmartHub)`);
            break;
          } catch (err) {
            lastErr = err;
            this.log(`Repair: region "${region}" failed (SmartHub):`, err.message);
          }
        }

        if (!client) {
          this.error('Repair: all regions failed (SmartHub):', lastErr?.message);
          throw new Error(lastErr?.message ?? 'Repair failed');
        }

        await device.setStoreValue('token',     client._token);
        await device.setStoreValue('region',    client.region);
        await device.setStoreValue('visitorId', client.visitorId);
        await device.setStoreValue('backend',   'smarthub');

        device._initClient();
        device.setAvailable().catch(err => this.log('Repair: setAvailable failed:', err.message));
        this.log('Repair: credentials updated successfully (SmartHub).');
        return true;
      }

      // Otherwise: new Smart Home (Gizwits AEP) share URL or bare shareId.
      let shareId, urlRegion;
      try {
        ({ shareId, region: urlRegion } = parseShareInput(raw));
      } catch (err) {
        throw new Error(this.homey.__('pair.connect.error.invalid_code'));
      }

      const existingRegion = device.getStoreValue('region') ?? 'eu';
      const regionsToTry   = urlRegion ? [urlRegion] : [...new Set([existingRegion, 'eu', 'us'])];
      let smClient  = null;
      let smLastErr = null;

      this.log('Repair: received Smart Home share link, trying regions…');

      for (const region of regionsToTry) {
        try {
          const c = new BestwaySmartHomeClient({ region });
          await c.authenticate();
          await c.acceptShare(shareId);
          smClient = c;
          this.log(`Repair: share accepted (${region}, SmartHome)`);
          break;
        } catch (err) {
          smLastErr = err;
          this.log(`Repair: region "${region}" failed (SmartHome):`, err.message);
        }
      }

      if (!smClient) {
        this.error('Repair: all regions failed (SmartHome):', smLastErr?.message);
        throw new Error(smLastErr?.message ?? 'Repair failed');
      }

      await device.setStoreValue('token',   smClient._token);
      await device.setStoreValue('region',  smClient.region);
      await device.setStoreValue('phoneId', smClient.phoneId);
      await device.setStoreValue('backend', 'smart_home');

      device._initClient();
      device.setAvailable().catch(err => this.log('Repair: setAvailable failed:', err.message));
      this.log('Repair: credentials updated successfully (SmartHome).');
      return true;
    });
  }

  async onPair(session) {
    let _pendingDevices = [];

    session.setHandler('link_code', async ({ code }) => {
      const raw = (code ?? '').trim();

      if (raw.startsWith('RW_Share_')) {
        // Legacy SmartHub (Gizwits visitor) backend.
        this.log('Pair: received legacy share code, trying regions…');

        let client  = null;
        let lastErr = null;

        for (const region of ['eu', 'us']) {
          try {
            const c = new BestwaySmarthubClient({ region });
            await c.authenticate();
            await c.linkShareCode(raw);
            client = c;
            this.log(`Pair: share code accepted on region "${region}" (SmartHub)`);
            break;
          } catch (err) {
            lastErr = err;
            this.log(`Pair: region "${region}" failed (SmartHub):`, err.message);
          }
        }

        if (!client) {
          this.error('Pair: all regions failed (SmartHub):', lastErr?.message);
          throw new Error(lastErr?.message ?? this.homey.__('pair.connect.error.link_failed'));
        }

        const rawDevices = await client.getDevices();
        this.log(`Pair: found ${rawDevices.length} device(s) (SmartHub)`);

        if (!rawDevices.length) {
          throw new Error(this.homey.__('pair.connect.error.no_devices'));
        }

        _pendingDevices = rawDevices.map(device => ({
          name: device.device_alias || device.device_name || 'Lay-Z-Spa',
          data: {
            id: device.device_id,
          },
          store: {
            productId: device.product_id,
            visitorId: client.visitorId,
            token:     client._token,
            region:    client.region,
            backend:   'smarthub',
          },
        }));

        return true;
      }

      // New Smart Home (Gizwits AEP) backend — share URL or bare shareId.
      // Used by the Bestway Connect app for 2025+ UltraFit devices, whose
      // "Share Device" QR code no longer produces an RW_Share_ text code.
      this.log('Pair: received Smart Home share link, trying regions…');

      let shareId, urlRegion;
      try {
        ({ shareId, region: urlRegion } = parseShareInput(raw));
      } catch (err) {
        throw new Error(this.homey.__('pair.connect.error.invalid_code'));
      }

      const regionsToTry = urlRegion ? [urlRegion] : ['eu', 'us'];
      let smClient  = null;
      let smLastErr = null;

      for (const region of regionsToTry) {
        try {
          const c = new BestwaySmartHomeClient({ region });
          await c.authenticate();
          await c.acceptShare(shareId);
          smClient = c;
          this.log(`Pair: share accepted on region "${region}" (SmartHome)`);
          break;
        } catch (err) {
          smLastErr = err;
          this.log(`Pair: region "${region}" failed (SmartHome):`, err.message);
        }
      }

      if (!smClient) {
        this.error('Pair: all regions failed (SmartHome):', smLastErr?.message);
        throw new Error(smLastErr?.message ?? this.homey.__('pair.connect.error.link_failed'));
      }

      const rawDevices = await smClient.getDevices();
      this.log(`Pair: found ${rawDevices.length} device(s) (SmartHome)`);

      if (!rawDevices.length) {
        throw new Error(this.homey.__('pair.connect.error.no_devices'));
      }

      _pendingDevices = rawDevices.map(device => ({
        name: device.device_alias || 'Lay-Z-Spa',
        data: {
          id: device.device_id,
        },
        store: {
          productId: device.product_id,
          phoneId:   smClient.phoneId,
          token:     smClient._token,
          region:    smClient.region,
          backend:   'smart_home',
        },
      }));

      return true;
    });

    session.setHandler('list_devices', async () => _pendingDevices);
  }

}

module.exports = LaZSpaConnectDriver;
