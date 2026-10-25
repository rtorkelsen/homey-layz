'use strict';

/**
 * Bestway Gizwits V01 API Client
 *
 * Authentication via Bestway Smart Hub account (username/password).
 * Backend: Gizwits V01 – https://euapi.gizwits.com
 *
 * API reference derived from https://github.com/cdpuk/ha-bestway
 */

const API_APP_ID = '98754e684ec045528b073876c34c7348';
const API_TIMEOUT_MS = 8000;

const API_ROOTS = {
  eu:     'https://euapi.gizwits.com',
  us:     'https://usapi.gizwits.com',
  global: 'https://api.gizwits.com',
};

// Error codes where retrying another region will never help.
const PERMANENT_ERROR_CODES = new Set([9020]); // 9020 = wrong password

// Gizwits error codes relevant to authentication
const GIZWITS_ERRORS = {
  9004: 'Invalid token.',
  9005: 'Account not found. Check your email address or try a different region.',
  9015: 'Request rejected by the server. The account may be on a different region.',
  9020: 'Wrong password.',
  9042: 'Device is offline.',
};

/** Structured error that carries the raw Gizwits error code. */
class GizwitsError extends Error {
  constructor(code, httpStatus) {
    const msg = GIZWITS_ERRORS[code] ?? `Unknown error (code ${code})`;
    super(`HTTP ${httpStatus} – ${msg}`);
    this.code       = code;
    this.httpStatus = httpStatus;
  }
}

// ── Attribute name maps per device type ─────────────────────────────────────

/**
 * Returns the correct attribute names for the given Gizwits product_name.
 *
 * Mapping based on ha-bestway source analysis:
 *   - "Airjet"          – basic AirJet spa
 *   - "Airjet_V01"      – V01 AirJet spa
 *   - "Hydrojet"        – HydroJet spa
 *   - "Hydrojet_Pro"    – HydroJet Pro spa
 */
function getAttrMap(productName) {
  switch (productName) {
    case 'Airjet':
      return {
        isUnknown:   false,
        power:       'spa_power',    // 0 / 1  (Airjet uses spa_power, not power)
        currentTemp: 'temp_now',     // read-only (Airjet uses temp_now, not Tnow)
        targetTemp:  'temp_set',     // r/w
        filter:      'filter_power', // 0 / 1
        heat:        'heat_power',   // 0 / 1
        heatOn:      1,
        heatOff:     0,
        wave:        'wave_power',   // 0 / 1 (basic: only on/off)
        jet:         null,           // not available
        locked:      'locked',       // write attr  (0 / 1)
        lockedBit:   'bit2',         // read attr
        supportsLock: true,          // Gizwits API accepts 'locked' write for this model
        // Bubble values for basic Airjet
        waveOff:    0,
        waveLow:    1,
        waveHigh:   1,               // no medium on basic model – on is max
        filterOn:   1,
        filterOff:  0,
      };

    case 'Airjet_V01':
      return {
        isUnknown:   false,
        power:       'power',   // 0 / 1
        currentTemp: 'Tnow',
        targetTemp:  'Tset',
        filter:      'filter',  // 0 / 2
        heat:        'heat',    // 0 / 3
        heatOn:      3,
        heatOff:     0,
        wave:        'wave',    // 0 / 50 / 100  (read: 40,41,50,51 = medium)
        jet:         null,
        locked:      'locked',  // write attr  (0 / 1)
        lockedBit:   'bit2',    // read attr
        supportsLock: false,    // Gizwits API rejects 'locked' write for V01 models
        waveOff:    0,
        waveLow:    50,
        waveHigh:   100,
        filterOn:   2,
        filterOff:  0,
      };

    case 'Hydrojet':
    case 'Hydrojet_Pro':
    default: {
      // isUnknown=true for any product_name not explicitly listed above.
      // The Hydrojet_Pro mapping is used as best-effort fallback, but
      // attribute names and values may differ on unsupported models.
      const isUnknown = productName !== 'Hydrojet' && productName !== 'Hydrojet_Pro';
      return {
        isUnknown,
        power:       'power',   // 0 / 1
        currentTemp: 'Tnow',
        targetTemp:  'Tset',
        filter:      'filter',  // 0 / 2
        heat:        'heat',    // 0 / 3
        heatOn:      3,
        heatOff:     0,
        wave:        'wave',    // 0 / 40 / 100
        jet:         'jet',     // 0 / 1
        locked:      'locked',  // write attr  (0 / 1)
        lockedBit:   'bit2',    // read attr
        supportsLock: false,    // Gizwits API rejects 'locked' write for HydroJet models
        waveOff:    0,
        waveLow:    40,
        waveHigh:   100,
        filterOn:   2,
        filterOff:  0,
      };
    }
  }
}

// ── Bubble level helpers ─────────────────────────────────────────────────────

/**
 * Convert raw API wave value → 'off' | 'low' | 'high'
 * Handles the quirk where some devices report medium as 40,41,50,51.
 */
function waveToAirjet(rawValue) {
  if (rawValue === 0) return 'off';
  if (rawValue >= 90) return 'high';
  return 'low';
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function apiRequest(method, url, { token, body } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Gizwits-Application-Id': API_APP_ID,
  };

  if (token) {
    headers['X-Gizwits-User-token'] = token;
  }

  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    try {
      const json = await response.json();
      if (json.error_code) throw new GizwitsError(json.error_code, response.status);
    } catch (e) {
      if (e instanceof GizwitsError) throw e;
    }
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

// ── BestwayClient class ──────────────────────────────────────────────────────

class BestwayClient {

  /**
   * @param {object} options
   * @param {string} [options.region='eu']  'eu', 'us', or 'global'
   */
  constructor({ region = 'eu' } = {}) {
    this.region  = region;
    this.apiRoot = API_ROOTS[region] ?? API_ROOTS.eu;
  }

  // ── Authentication ──────────────────────────────────────────────────────

  /**
   * Login with username/password.
   *
   * @param {string} username  E-mail address
   * @param {string} password
   * @returns {{ userId: string, userToken: string, expiry: number }}
   */
  async login(username, password) {
    const data = await apiRequest('POST', `${this.apiRoot}/app/login`, {
      body: { username, password, lang: 'en' },
    });

    return {
      userId:    data.uid,
      userToken: data.token,
      expiry:    data.expire_at,
    };
  }

  // ── Device discovery ────────────────────────────────────────────────────

  /**
   * Returns all spa devices bound to the authenticated account.
   *
   * @param {string} token  User token from login()
   * @returns {Array<object>}  Raw device objects from the Gizwits API
   */
  async getDevices(token) {
    const data = await apiRequest('GET', `${this.apiRoot}/app/bindings`, { token });

    const devices = [];

    // Hierarchical structure: items[] → rooms[] → devices[]
    for (const home of (data.items ?? [])) {
      for (const room of (home.rooms ?? [])) {
        for (const device of (room.devices ?? [])) {
          devices.push(device);
        }
      }
    }

    // Some API versions return a flat devices[] at top level
    for (const device of (data.devices ?? [])) {
      if (!devices.find(d => d.did === device.did)) {
        devices.push(device);
      }
    }

    return devices;
  }

  // ── Device info (firmware versions) ────────────────────────────────────

  /**
   * Return the raw device object for a single device from /app/bindings.
   * Used to retrieve firmware version fields that are not part of the status poll.
   *
   * @param {string} token     User token
   * @param {string} deviceId  Device DID
   * @returns {object|null}  Raw device object, or null if not found
   */
  async getDeviceInfo(token, deviceId) {
    const devices = await this.getDevices(token);
    return devices.find(d => d.did === deviceId) ?? null;
  }

  // ── Device status ───────────────────────────────────────────────────────

  /**
   * Fetch the latest device status.
   *
   * @param {string} token     User token
   * @param {string} deviceId  Device DID
   * @returns {object}  Raw status with `attr` object
   */
  async getDeviceStatus(token, deviceId) {
    return apiRequest(
      'GET',
      `${this.apiRoot}/app/devdata/${deviceId}/latest`,
      { token },
    );
  }

  // ── Device control ──────────────────────────────────────────────────────

  /**
   * Send one or more attribute changes to the device.
   *
   * @param {string} token     User token
   * @param {string} deviceId  Device DID
   * @param {object} attrs     e.g. { power: 1 } or { wave: 40 }
   */
  async control(token, deviceId, attrs) {
    return apiRequest(
      'POST',
      `${this.apiRoot}/app/control/${deviceId}`,
      { token, body: { attrs } },
    );
  }

}

// ── Multi-region login helper ────────────────────────────────────────────────

/**
 * Attempt login across all regions (EU → US → Global) until one succeeds.
 * Stops early on permanent errors (e.g. wrong password — code 9020).
 *
 * @param {string} username
 * @param {string} password
 * @returns {{ userId, userToken, expiry, username, password, region }}
 * @throws {GizwitsError|Error} Last error encountered if all regions fail.
 */
async function loginWithRegionFallback(username, password) {
  const regions = Object.keys(API_ROOTS);
  let lastError = null;

  for (const region of regions) {
    const client = new BestwayClient({ region });
    try {
      const result = await client.login(username, password);
      return { ...result, username, password, region };
    } catch (err) {
      lastError = err;
      if (err instanceof GizwitsError && PERMANENT_ERROR_CODES.has(err.code)) break;
    }
  }

  throw lastError;
}

module.exports = {
  BestwayClient,
  GizwitsError,
  API_ROOTS,
  PERMANENT_ERROR_CODES,
  getAttrMap,
  waveToAirjet,
  loginWithRegionFallback,
};
