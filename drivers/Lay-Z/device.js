'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpaDevice extends Homey.Device {

    async onInit() {
        this.log('SpaDevice is initializing...');
        this.headers = {
            'X-Gizwits-Application-Id': this.homey.settings.get('appId'),
            'Content-Type': 'application/json; charset=UTF-8',
        };
        this.baseUrl = this.homey.settings.get('baseUrl');
        
        //Remove legacy capabilities
        await this.removeCapability('system_error').catch(this.error);
        
        //Setup capabilities
        await this.enableCapability('onoff', this.getSetting('power_control_enabled'));
        await this.enableCapability('pump_onoff', this.getSetting('filter_pump_control_enabled'));
        await this.enableCapability('msg_onoff', this.getSetting('wave_control_enabled'));
        await this.enableCapability('heat_temp_reach', true);
        await this.enableCapability('pump_state', true);
        await this.enableCapability('heat_state', true);
        await this.enableCapability('temp_now', true);
        await this.enableCapability('measure_power', true);
        await this.enableCapability('measure_temperature', true);
        await this.enableCapability('target_temperature', true);
        await this.enableCapability('thermostat_mode', true);
        await this.enableCapability('alarm_generic', true);

        // Register Capability Listeners
        this.log('Registering capability listeners...');
        this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
        this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
        this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
        this.registerCapabilityListener('pump_onoff', this.onCapabilityPumpOnoff.bind(this));
        this.registerCapabilityListener('msg_onoff', this.onCapabilityMsgOnoff.bind(this));
        this.log('Capability listeners registered');

        // Start the update interval
        this.updateInterval = setInterval(async () => {
            await this.updateOnlineStatus();
            await this.updateDeviceStatus();
        }, 1 * 60 * 1000); // Update every 1 minutes
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
            const {attr} = data;

            if (!attr) {
                throw new Error('attr field missing in response data');
            }
            
            const powerOn = attr.power === 1;
            const thermostatOn = attr.heat_power === 1;
            const heatTempReached = attr.heat_temp_reach === 1;
            const heaterActive = thermostatOn & !heatTempReached;
            const filterPumpOn = attr.filter_power === 1;
            const wavePowerOn = attr.wave_power === 1;
            const heaterWatts = this.getSetting('heater_power');
            const filterPumpWatts = this.getSetting('filter_pump_power');
            const powerConsumption = heaterActive * heaterWatts + filterPumpOn * filterPumpWatts;

            const {
                temp_now: currentTemperature,
                temp_set: temperatureSetpoint,
            } = attr;
            
            const units = attr.temp_set_unit === '华氏' ? '°F' : '°C';
            // Dynamically set units and ranges for capabilities
            const options = {
                units: {
                    en: units, no: units,
                }, 
                min: units === '°F' ? 68 : 20, max: units === '°F' ? 104 : 40, step: 1,
                decimals: 0,
            };
            await this.setCapabilityOptions('target_temperature', options);
            await this.safeSetCapabilityValue('target_temperature', thermostatOn ? temperatureSetpoint : null);
            await this.safeSetCapabilityValue('measure_temperature', currentTemperature);
            await this.safeSetCapabilityValue('thermostat_mode', thermostatOn ? 'heat' : 'off');
            await this.safeSetCapabilityValue('temp_now', currentTemperature);
            
            await this.safeSetCapabilityValue('onoff', powerOn);
            await this.safeSetCapabilityValue('pump_onoff', filterPumpOn);
            await this.safeSetCapabilityValue('msg_onoff', wavePowerOn);
            await this.safeSetCapabilityValue('heat_temp_reach', heatTempReached);
            await this.safeSetCapabilityValue('pump_state', filterPumpOn);
            await this.safeSetCapabilityValue('heat_state', thermostatOn);
            await this.safeSetCapabilityValue('measure_power', powerConsumption);

            await this.updateSystemErrors(attr);
        } catch (error) {
            if (error.response) {
                this.error(`Server responded with status code: ${error.response.status}`, error.message);
            } else if (error.request) {
                this.error('No response received from the server', error.message);
            } else {
                this.error('Failed to update device status', error.message);
            }
        }
    }

    async fetchDeviceData() {
        const token = this.homey.settings.get('token');
        if (!token) {
            throw new Error('No token found in settings');
        }
        return await this.makeAxiosCall('get', `${this.baseUrl}/app/devdata/${this.getData().did}/latest`, null, token);
    }

    async updateSystemErrors(attr) {
        const errors = [];
        for (let i = 1; i <= 9; i++) {
            if (attr[`system_err${i}`] === 1) {
                errors.push(`E0${i}`);
            }
        }
        const hasErrors = errors.length > 0;
        await this.safeSetCapabilityValue('alarm_generic', hasErrors);
        if (hasErrors) {
            await this.setWarning(`System error(s): ${errors.join(', ')}`);
        } else {
            await this.unsetWarning();
        }
    }

    async updateOnlineStatus() {
        this.log('updateOnlineStatus started');
        const token = this.homey.settings.get('token');
        try {
            const response = await axios.get(`${this.baseUrl}/app/bindings`, {
                // eslint-disable-next-line node/no-unsupported-features/es-syntax
                headers: {...this.headers, 'X-Gizwits-User-token': token},
            });

            const device = response.data.devices.find((device) => device.did === this.getData().did);
            if (device) {
                if (device.is_online) {
                    await this.setAvailable();
                } else {
                    await this.setUnavailable();
                }
            } else {
                this.log(`Device with did ${this.getData().did} not found`);
            }
        } catch (error) {
            this.log('Failed to update online status', error);
        }
    }

    async makeAxiosCall(method, url, data = null, token = null) {
        try {
            const headers = { ...this.headers };
            if (token) {
                headers['X-Gizwits-User-token'] = token;
            }
            const response = await axios({ method, url, data, headers });
            return response.data;
        } catch (error) {
            const status = error.response?.status || 'unknown';
            this.log(`Failed to make ${method} request to ${url} (Status: ${status})`, error.message);
            return null; // Ensures failure handling in calling code
        }
    }

    async safeSetCapabilityValue(capability, value) {
        if (!this.hasCapability(capability)) {
            return;
        }
        await this.setCapabilityValue(capability, value)
            .catch(e => this.error(`Failed to update ${capability}`, e));
    }

    async onCapabilityTargetTemperature(value) {
        try {
            const token = this.homey.settings.get('token');
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, {attrs: {temp_set: value}}, token);
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
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, {attrs: {power: value ? 1 : 0}}, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to change on/off status', error);
        }
    }

    async onCapabilityThermostatMode(value) {
        switch (value) {
            case 'heat':
                await this.setHeatPower(1);
                break;
            case 'off':
                await this.setHeatPower(0);
                break;
            default:
                this.log('Unsupported value');
                break;
        }
    }

    async setHeatPower(value) {
        try {
            const token = this.homey.settings.get('token');
            if (!token) {
                throw new Error('No token found in settings');
            }
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, {attrs: {heat_power: value}}, token);
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
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, {attrs: {filter_power: value ? 1 : 0}}, token);
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
            await this.makeAxiosCall('post', `${this.baseUrl}/app/control/${this.getData().did}`, {attrs: {wave_power: value ? 1 : 0}}, token);
            await this.updateDeviceStatus();
        } catch (error) {
            this.error('Failed to toggle massage function', error);
        }
    }

    async onDeleted() {
        clearInterval(this.updateInterval);
        this.log('SpaDevice has been deleted');
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        console.log('Settings changed:', {oldSettings, newSettings, changedKeys});
        if (changedKeys.includes('power_control_enabled')) {
            await this.enableCapability('onoff', newSettings.power_control_enabled);
        }
        if (changedKeys.includes('filter_pump_control_enabled')) {
            await this.enableCapability('pump_onoff', newSettings.filter_pump_control_enabled);
        }
        if (changedKeys.includes('wave_control_enabled')) {
            await this.enableCapability('msg_onoff', newSettings.wave_control_enabled);
        }
        await this.updateDeviceStatus();
    }

}

module.exports = SpaDevice;
