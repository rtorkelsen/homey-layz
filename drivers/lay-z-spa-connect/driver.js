'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient } = require('../../lib/BestwaySmarthubClient');

function _getAllSpaDevices(homey) {
  const devices = [];
  for (const id of ['Lay-Z', 'lay-z-spa-connect']) {
    try { devices.push(...homey.drivers.getDriver(id).getDevices()); } catch (_) {}
  }
  return devices;
}

class LaZSpaConnectDriver extends Homey.Driver {

  async onInit() {
    this.log('Lay-Z-Spa Connect driver initialized');

    this._triggerTempReached    = this.homey.flow.getDeviceTriggerCard('spa_temp_reached');
    this._triggerErrorTriggered = this.homey.flow.getDeviceTriggerCard('spa_error_triggered');

    this._triggerFilterPumpChanged   = this.homey.flow.getDeviceTriggerCard('filter_pump_changed');
    this._triggerFilterPumpTurnedOn  = this.homey.flow.getDeviceTriggerCard('filter_pump_turned_on');
    this._triggerFilterPumpTurnedOff = this.homey.flow.getDeviceTriggerCard('filter_pump_turned_off');

    // Registering conditions here ensures they work for Connect devices even if the
    // V01 driver initialises after this one. The last registration always wins safely.

    this.homey.flow.getConditionCard('spa_error_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('alarm_generic') === true,
      );

    this.homey.flow.getConditionCard('spa_temp_above')
      .registerRunListener((args) => {
        const current = args.device.getCapabilityValue('measure_temperature');
        return typeof current === 'number' && current > args.temperature;
      });

    this.homey.flow.getConditionCard('spa_temp_below')
      .registerRunListener((args) => {
        const current = args.device.getCapabilityValue('measure_temperature');
        return typeof current === 'number' && current < args.temperature;
      });

    this.homey.flow.getConditionCard('spa_temp_reached_condition')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('bestway_temp_reached') === true,
      );

    this.homey.flow.getConditionCard('spa_airjet_active')
      .registerRunListener((args) => {
        const d = args.device;
        // Connect devices use onoff.airjet_low/high; Lay-Z devices use airjet_low/high or msg_onoff
        return d.getCapabilityValue('onoff.airjet_low') === true ||
               d.getCapabilityValue('onoff.airjet_high') === true ||
               d.getCapabilityValue('airjet_low') === true ||
               d.getCapabilityValue('airjet_high') === true ||
               d.getCapabilityValue('msg_onoff') === true;
      });

    this.homey.flow.getConditionCard('spa_locked')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('bestway_locked') === true,
      );

    const runSpa = (cap, method) => async (args) => {
      const val = args.onoff === 'true';
      for (const d of _getAllSpaDevices(this.homey)) {
        if (typeof d[method] === 'function') {
          await d[method](val).catch(() => {});
        } else {
          await d.triggerCapabilityListener(cap, val).catch(() => {});
        }
      }
    };

    this.homey.flow.getActionCard('spa_set_filter')
      .registerRunListener(runSpa('onoff.filter', 'setFilter'));

    this.homey.flow.getActionCard('spa_set_heating')
      .registerRunListener(runSpa('onoff.heating', 'setHeating'));

    this.homey.flow.getActionCard('spa_set_airjet_low')
      .registerRunListener(runSpa('onoff.airjet_low', 'setAirjetLow'));

    this.homey.flow.getActionCard('spa_set_airjet_high')
      .registerRunListener(runSpa('onoff.airjet_high', 'setAirjetHigh'));

    this.homey.flow.getActionCard('spa_set_hydrojet')
      .registerRunListener(runSpa('onoff.hydrojet', 'setHydrojet'));

    // Filter pump conditions — cover Connect devices (pump_onoff not present; use onoff.filter)
    this.homey.flow.getConditionCard('filter_pump_is_on')
      .registerRunListener(async ({ device }) => {
        return !!(device?.getCapabilityValue('pump_onoff') ?? device?.getCapabilityValue('onoff.filter'));
      });
    this.homey.flow.getConditionCard('filter_pump_is_off')
      .registerRunListener(async ({ device }) => {
        return !(device?.getCapabilityValue('pump_onoff') ?? device?.getCapabilityValue('onoff.filter'));
      });

    // Filter pump actions — cover Connect devices via setFilterPump()
    const fpAction = (turnOn) => async ({ device }) => {
      if (!device || typeof device.setFilterPump !== 'function') return false;
      return device.setFilterPump(turnOn);
    };
    this.homey.flow.getActionCard('filter_pump_turn_on').registerRunListener(fpAction(true));
    this.homey.flow.getActionCard('filter_pump_turn_off').registerRunListener(fpAction(false));
    this.homey.flow.getActionCard('filter_pump_toggle').registerRunListener(async ({ device }) => {
      if (!device || typeof device.setFilterPump !== 'function') return false;
      const cur = !!(device.getCapabilityValue('pump_onoff') ?? device.getCapabilityValue('onoff.filter'));
      return device.setFilterPump(!cur);
    });
  }

  async onRepair(session, device) {
    this.log('Repair session started for:', device.getName());

    session.setHandler('link_code', async ({ code }) => {
      const shareCode      = (code ?? '').trim();
      const existingRegion = device.getStoreValue('region') ?? 'eu';
      const visitorId      = device.getStoreValue('visitorId');

      this.log('Repair: received share code, trying regions…');

      const regionsToTry = [...new Set([existingRegion, existingRegion === 'eu' ? 'us' : 'eu'])];
      let client  = null;
      let lastErr = null;

      for (const region of regionsToTry) {
        try {
          const c = new BestwaySmarthubClient({ region, visitorId });
          await c.authenticate();
          await c.linkShareCode(shareCode);
          client = c;
          this.log(`Repair: share code accepted (${region})`);
          break;
        } catch (err) {
          lastErr = err;
          this.log(`Repair: region "${region}" failed:`, err.message);
        }
      }

      if (!client) {
        this.error('Repair: all regions failed:', lastErr?.message);
        throw new Error(lastErr?.message ?? 'Repair failed');
      }

      await device.setStoreValue('token',     client._token);
      await device.setStoreValue('region',    client.region);
      await device.setStoreValue('visitorId', client.visitorId);

      device._initClient();
      device.setAvailable().catch(err => this.log('Repair: setAvailable failed:', err.message));
      this.log('Repair: credentials updated successfully.');
      return true;
    });
  }

  async onPair(session) {
    let _pendingDevices = [];

    session.setHandler('link_code', async ({ code }) => {
      const shareCode = (code ?? '').trim();
      this.log('Pair: received share code, trying regions…');

      let client  = null;
      let lastErr = null;

      for (const region of ['eu', 'us']) {
        try {
          const c = new BestwaySmarthubClient({ region });
          await c.authenticate();
          await c.linkShareCode(shareCode);
          client = c;
          this.log(`Pair: share code accepted on region "${region}"`);
          break;
        } catch (err) {
          lastErr = err;
          this.log(`Pair: region "${region}" failed:`, err.message);
        }
      }

      if (!client) {
        this.error('Pair: all regions failed:', lastErr?.message);
        throw new Error(lastErr?.message ?? this.homey.__('pair.connect.error.link_failed'));
      }

      const rawDevices = await client.getDevices();
      this.log(`Pair: found ${rawDevices.length} device(s)`);

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
        },
      }));

      return true;
    });

    session.setHandler('list_devices', async () => _pendingDevices);
  }

}

module.exports = LaZSpaConnectDriver;
