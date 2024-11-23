'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpaDevice extends Homey.Device {
    async onInit() {
        this.log('SpaDevice has been initialized');

        this.headers = {
            'X-Gizwits-Application-Id': this.homey.settings.get('appId'),
            'Content-Type': 'application/json; charset=UTF-8',
        };

        this.baseUrl = this.homey.settings.get('baseUrl');

        this.updateInterval = setInterval(() => {
            this.updateOnlineStatus();
            this.updateDeviceStatus();
        }, 5 * 60 * 1000); // Update every 5 minutes
        this.updateOnlineStatus();
        this.updateDeviceStatus();

        // Register Capability Listeners
        this.log('Registering capability listeners...');
        this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
        this.registerCapabilityListener('pump_onoff', this.onCapabilityPumpOnoff.bind(this));
        this.registerCapabilityListener('msg_onoff', this.onCapabilityMsgOnoff.bind(this));
        this.registerCapabilityListener('system_error', this.onCapabilitySystemError.bind(this));
        this.log('Capability listeners registered');
    }

    async updateDeviceStatus() {
        this.log('updateDeviceStatus started');

        try {
            const token = this.homey.settings.get('token');
            const data = await this.makeAxiosCall('get', `${this.baseUrl}/app/devdata/${this.getData().did}/latest`, null, token);
            const { attr } = data;

            if (!attr) {
                throw new Error("attr field missing in response data");
            }

            const temp_now = attr.temp_now;
            const temp_set = attr.temp_set;
            const units = attr.temp_set_unit === '华氏' ? '°F' : '°C';

            // Update temp_now directly
            this.safeSetCapabilityValue('temp_now', temp_now);
            this.safeSetCapabilityValue('target_temperature', temp_set);

            // Dynamically set units and ranges for capabilities
            const options = {
                units: {
                    en: units,
                    no: units
                },
                min: units === '°F' ? 68 : 20,
                max: units === '°F' ? 104 : 40,
                step: 1
            };
            
            this.setCapabilityOptions('target_temperature', options);
            


            this.safeSetCapabilityValue('onoff', !!attr.power);
            this.safeSetCapabilityValue('thermostat_mode', attr.heat_power ? 'heat' : 'cool');
            this.safeSetCapabilityValue('pump_onoff', !!attr.filter_power);
            this.safeSetCapabilityValue('msg_onoff', !!attr.wave_power);
            this.safeSetCapabilityValue('heat_temp_reach', !!attr.heat_temp_reach);
            this.safeSetCapabilityValue('pump_state', !!attr.filter_power);
            this.safeSetCapabilityValue('heat_state', !!attr.heat_power);

            this.log('Setting initial system_error value');
            this.safeSetCapabilityValue('system_error', false);

            this.updateSystemErrors(attr);

        } catch (error) {
            if (error.response) {
                this.error(`Server responded with status code: ${error.response.status}`, error.message);
            } else if (error.request) {
                this.error("No response received from the server", error.message);
            } else {
                this.error('Failed to update device status', error.message);
            }
        }
    }

    updateSystemErrors(attr) {
        this.log('updateSystemErrors started');
        let errors = [];
        for (let i = 1; i <= 9; i++) {
            if (attr[`system_err${i}`] === 1) {
                errors.push(`E0${i}`);
            }
        }
        const hasErrors = errors.length > 0;
        this.safeSetCapabilityValue('system_error', hasErrors);

        if (hasErrors) {
            this.setWarning('System error(s): ' + errors.join(', '));
        } else {
            this.setWarning('');
        }
    }

    async updateOnlineStatus() {
        this.log('updateOnlineStatus started');
        const token = this.homey.settings.get('token');

        try {
            const response = await axios.get(`${this.baseUrl}/app/bindings`, {
                headers: { ...this.headers, 'X-Gizwits-User-token': token },
            });

            const device = response.data.devices.find(device => device.did === this.getData().did);
            if (device) {
                if (device.is_online) {
                    this.setAvailable();
                } else {
                    this.setUnavailable();
                }
            } else {
                this.log(`Device with did ${this.getData().did} not found`);
            }
        } catch (error) {
            this.log('Failed to update online status', error);
        }
    }

    async makeAxiosCall(method, url, data, token) {
        try {
            const response = await axios({ method, url, data, headers: { ...this.headers, 'X-Gizwits-User-token': token } });
            return response.data;
        } catch (error) {
            this.log(`Failed to make ${method} request`, error);
        }
    }

    safeSetCapabilityValue(capability, value) {
        if (value !== undefined && value !== null) {
            try {
                this.setCapabilityValue(capability, value);
            } catch (error) {
                this.error(`Failed to update ${capability}`, error);
            }
        } else {
            this.error(`Value for ${capability} is missing or null.`);
        }
    }

    async onCapabilityTargetTemperature(value) {
        try {
            const token = this.homey.settings.get('token');
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, { attrs: { temp_set: value } }, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to set target temperature', error);
        }
    }

    async onCapabilityOnoff(value) {
        try {
            const token = this.homey.settings.get('token');
            if (!token) {
                throw new Error('No token found in settings');
            }

            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, { attrs: { power: value ? 1 : 0 } }, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to change on/off status', error);
        }
    }

    async onCapabilityThermostatMode(value) {
        try {
            const token = this.homey.settings.get('token');
            if (!token) {
                throw new Error('No token found in settings');
            }

            const data = await this.makeAxiosCall('get', `${this.baseUrl}/app/devdata/${this.getData().did}/latest`);
            if (!data || !data.attr || data.attr.heat_power === undefined) {
                throw new Error('Invalid data received from server');
            }

            switch (value) {
                case 'auto':
                case 'heat':
                    if (!data.attr.heat_power) {
                        await this.setHeatPowerStatus(1, token);
                    }
                    break;
                case 'cool':
                    if (data.attr.heat_power) {
                        await this.setHeatPowerStatus(0, token);
                    }
                    break;
                case 'off':
                    await this.onCapabilityPumpOnoff(false);
                    break;
            }

            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to change thermostat mode', error);
        }
    }

    async setHeatPowerStatus(value, token) {
        try {
            if (!token) {
                throw new Error('No token found in settings');
            }

            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, { attrs: { heat_power: value } }, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to set heating power status', error);
        }
    }

    async onCapabilityPumpOnoff(value) {
        try {
            const token = this.homey.settings.get('token');
            if (!token) {
                throw new Error('No token found in settings');
            }

            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, { attrs: { filter_power: value ? 1 : 0 } }, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to toggle filter pump', error);
        }
    }

    async onCapabilityMsgOnoff(value) {
        try {
            const token = this.homey.settings.get('token');
            if (!token) {
                throw new Error('No token found in settings');
            }

            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, { attrs: { wave_power: value ? 1 : 0 } }, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to toggle massage function', error);
        }
    }

    async onCapabilitySystemError(value) {
        this.log(`System error status changed to ${value}`);
        // Additional logic to handle system error changes if needed
    }

    async onDeleted() {
        clearInterval(this.updateInterval);
        this.log('SpaDevice has been deleted');
    }

    async onPoll() {
        this.log('Polling for new data');
        this.log(`Polling device ${this.getData().did}`);

        this.updateOnlineStatus();
        this.updateDeviceStatus();
    }
}

module.exports = SpaDevice;
