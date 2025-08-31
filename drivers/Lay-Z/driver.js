'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpaDriver extends Homey.Driver {

  async onInit() {
    this.log('SpaDriver has been initialized');
  
    // Keep your pairing state
    this.devices = [];
    this._lastSessionAuth = null; // keep auth from successful login for pairing flow
  
    // **** Flow cards: filter pump (actions + conditions) ****
    try {
      // Actions: these IDs must match your .homeycompose files
      const actionOn  = this.homey.flow.getActionCard('filter_pump_turn_on');
      const actionOff = this.homey.flow.getActionCard('filter_pump_turn_off');
      const actionTog = this.homey.flow.getActionCard('filter_pump_toggle');
  
      // Register run listeners for actions
      [actionOn, actionOff, actionTog].forEach(card => {
        card.registerRunListener(async ({ device }) => {
          // Safety: ensure device helper exists
          if (!device || typeof device.setFilterPump !== 'function') return false;
  
          // Map card → action
          if (card === actionOn)  return device.setFilterPump(true);
          if (card === actionOff) return device.setFilterPump(false);
  
          // Toggle: read current capability and invert
          const cur = !!device.getCapabilityValue('pump_onoff');
          return device.setFilterPump(!cur);
        });
      });
  
      // Conditions: is on / is off
      const condOn  = this.homey.flow.getConditionCard('filter_pump_is_on');
      const condOff = this.homey.flow.getConditionCard('filter_pump_is_off');
  
      condOn.registerRunListener(async ({ device }) => !!device?.getCapabilityValue('pump_onoff'));
      condOff.registerRunListener(async ({ device }) => !device?.getCapabilityValue('pump_onoff'));
  
      this.log('Flow cards for filter pump registered');
    } catch (e) {
      this.error('Failed to register filter pump flow cards', e);
    }
    // **** End Flow cards ****
  }
  

  async loginHandler(data) {
    const servers = [
      {
        baseUrl: 'https://usapi.gizwits.com',
        appId: '98754e684ec045528b073876c34c7348',
      },
      {
        baseUrl: 'https://euapi.gizwits.com',
        appId: '43424551921d4ee18dd279140e11e198',
      },
      {
        baseUrl: 'https://api.gizwits.com',
        appId: '43424551921d4ee18dd279140e11e198',
      },
    ];

    let response;
    let auth = null;

    for (const server of servers) {
      this.log('Trying login on server:', server.baseUrl);
      try {
        response = await axios.post(`${server.baseUrl}/app/login`, {
          username: data.username,
          password: data.password,
          lang: 'en',
        }, {
          headers: {
            'Content-Type': 'application/json',
            'X-Gizwits-Application-Id': server.appId,
          },
        });

        this.log(`Response code from ${server.baseUrl}:`, response.status);

        if (response.data?.error_code === 9005) {
          this.log('User does not exist on server:', server.baseUrl);
          continue;
        }

        const { token, uid, expire_at: expireAt } = response.data;
        auth = { token, uid, expireAt, baseUrl: server.baseUrl, appId: server.appId };

        // Get device list for this region/token
        const devicesResponse = await axios.get(`${server.baseUrl}/app/bindings`, {
          headers: {
            'X-Gizwits-Application-Id': server.appId,
            'X-Gizwits-User-token': token,
          },
        });

        const devices = Array.isArray(devicesResponse?.data?.devices)
          ? devicesResponse.data.devices
          : [];

        // Normalize devices for Homey pairing (include per-device store)
        this.devices = devices.map(d => ({
          name: `${d.dev_alias} - ${d.product_name}`,
          data: {
            did: d.did,
            product_name: d.product_name || 'Airjet',
          },
          store: {
            token,
            uid,
            expire_at: expireAt,
            baseUrl: server.baseUrl,
            appId: server.appId,
          },
          // keep original API fields in case we need them later
          _raw: d,
        }));

        this._lastSessionAuth = auth;
        break; // success for this region
      } catch (e) {
        this.log('Login failed for server:', server.baseUrl, e?.message || e);
      }
    }

    if (!auth) {
      this.log('Failed to log in on all servers');
      throw new Error('Login failed');
    }
  }

  onPair(session) {
    // Step 1: user submits credentials
    session.setHandler('login', async (data) => {
      await this.loginHandler(data);
      // Return mapped devices (with per-device store)
      return this.devices.map(d => ({
        name: d.name,
        data: d.data,
        store: d.store,
      }));
    });

    // Step 2: show list to pick from (if your flow uses list view)
    session.setHandler('list_devices', async () => {
      // If login has been called: we already have mapped devices with store
      if (Array.isArray(this.devices) && this.devices.length) {
        this.log('List devices (from cached login):', this.devices.map(x => x.data));
        return this.devices.map(d => ({
          name: d.name,
          data: d.data,
          store: d.store,
        }));
      }
      // Fallback empty
      this.log('List devices requested but no devices loaded yet.');
      return [];
    });

    // Step 3: custom retrieval (optional for your flow)
    session.setHandler('get_devices', async () => {
      return this.devices.map(d => d._raw || d);
    });

    // Step 4: add selected devices
    session.setHandler('add_devices', async (devices) => {
      this.log('Adding devices:', devices.map(d => ({ data: d.data, hasStore: !!d.store })));

      // Some pairing templates let Homey create devices automatically from previous step.
      // If not, create devices here with data + store.
      for (const dev of devices) {
        // 1) MUST have per-device store coming from the same login session
        let store = dev.store;
      
        // 2) If UI didn't carry store through, try to backfill from this.devices (built right after login for THIS session)
        if (!store) {
          const found = this.devices.find(x => x?.data?.did === dev?.data?.did);
          if (found?.store) store = found.store;
        }
      
        // 3) If we still don't have store: STOP and tell user to go back and login for that device.
        //    DO NOT fall back to _lastSessionAuth (can be wrong account/region)!
        if (!store || !store.token || !store.baseUrl || !store.appId) {
          this.error('Selected device is missing per-device credentials. Ask user to log in for this device first.', {
            did: dev?.data?.did,
            hasStore: !!store,
          });
          throw new Error('Missing device store (token/baseUrl/appId). Please go back, log in, and select the device again.');
        }
      
        // 4) Create device with its own store
        await this.addDevice({
          name: dev.name || 'Lay-Z',
          data: {
            did: dev.data.did,
            product_name: dev.data.product_name || 'Airjet',
          },
          store, // <- per-device credentials (unique token/baseUrl/appId)
        });
      }
      
      return true;
    });
  }
  onRepair(session, device) {
    session.setHandler('repair_login', async (data) => {
      // Kjør loginHandler med brukernavn/passord fra repair-dialogen
      const auth = await this.loginHandler(data);
  
      // Oppdater device.store med ny token/baseUrl/appId
      if (typeof device.setStore === 'function') {
        await device.setStore({
          token: auth.token,
          uid: auth.uid,
          expire_at: auth.expireAt,
          baseUrl: auth.baseUrl,
          appId: auth.appId,
        });
      }
  
      this.log('Device re-login successful for DID:', device.getData().did);
      return true;
    });
  }
}

module.exports = SpaDriver;
