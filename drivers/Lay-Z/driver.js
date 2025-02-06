'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpaDriver extends Homey.Driver {

    async onInit() {
        this.log('SpaDriver has been initialized');
        this.devices = [];
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
        for (const server of servers) {
            // Log the username being sent
            this.log('Login attempt failed:', {
                username: data.username,
                password: '[REDACTED]',
            });

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
                // Log the HTTP status code for the response
                this.log(`Response code from ${server.baseUrl}:`, response.status);

                if (response.data.error_code && response.data.error_code === 9005) {
                    // User does not exist error, continue to try the next server
                    this.log('User does not exist for server:', server.baseUrl);
                    continue;
                }

                const { token, uid, expire_at: expireAt } = response.data;

                // Save token, uid, and expire_at into Homey Manager Settings
                this.homey.settings.set('token', token);
                this.homey.settings.set('uid', uid);
                this.homey.settings.set('expire_at', expireAt);
                this.homey.settings.set('baseUrl', server.baseUrl);
                this.homey.settings.set('appId', server.appId);

                const devicesResponse = await axios.get(`${server.baseUrl}/app/bindings`, {
                    headers: {
                        'X-Gizwits-Application-Id': server.appId,
                        'X-Gizwits-User-token': token,
                    },
                });

                this.devices = devicesResponse.data.devices;
                break; // If successful, break out of the loop
            } catch (e) {
                // If an error other than "user does not exist" occurs, we'll log it.
                this.log('Attempted login failed for server:', server.baseUrl, e.message);
            }
        }

        if (!response || !response.data.token) {
            this.log('Failed to log in on both servers');
            throw new Error('Failed to log in on both servers');
        }
    }

    onPair(session) {
        // Handle the login event sent from the Homey app during pairing
        session.setHandler('login', async (data, callback) => {
            await this.loginHandler(data);
            return this.devices.map((device) => ({
                name: `${device.dev_alias} - ${device.product_name}`,
                data: {did: device.did}, // Save the did as data for this device
            }));
        });

        // Handle the list_devices event to show a list of devices to the user
        session.setHandler('list_devices', async (data, callback) => {
            const devicesList = this.devices.map((device) => ({
                name: `${device.dev_alias} - ${device.product_name}`,
                data: { did: device.did }, // Save the did as data for this device
            }));
            this.log('list devices', devicesList);
            return devicesList;
        });

        // Handle the get_devices event - når det skal listes opp i custom_list
        session.setHandler('get_devices', async () => {
            return this.devices;
        });

        // Handle the add_devices event
        session.setHandler('add_devices', async (devices, callback) => {
            this.log('Adding devices', devices); // Log the devices that we are trying to add
            this.log('Devices from the pairing process', devices);
            for (const device of devices) {
                const deviceData = this.devices.find((d) => d.did === device.data.did);
                this.log('Device data', deviceData); // Log the device data that we found
                if (!deviceData) {
                    throw new Error('Device not found');
                }
                await this.addDevice(deviceData);
            }
            return true;
        });
    }

}
module.exports = SpaDriver;
