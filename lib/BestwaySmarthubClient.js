'use strict';

/**
 * Bestway SmartHub API Client
 *
 * Handles communication with the Bestway SmartHub cloud for V02-generation
 * devices (Airjet V02, Hydrojet V02, Ultrafit, etc.).
 *
 * Unlike the Gizwits-based V01 client, V02 devices use a custom Bestway cloud
 * that wraps AWS IoT device shadows. Authentication is credential-free — a
 * persistent visitor ID is issued once and used to re-authenticate indefinitely.
 * Device pairing happens via a share code generated in the Bestway Smart Hub app.
 *
 * Control commands are AES-256-CBC encrypted before transmission. The key is
 * derived from the per-request HMAC signature so every command uses a unique key.
 *
 * Regional endpoints:
 *   EU: https://smarthub-eu.bestwaycorp.com
 *   US: https://smarthub-us.bestwaycorp.com
 */

const crypto = require('crypto');

const SMARTHUB_ROOTS = {
  eu: 'https://smarthub-eu.bestwaycorp.com',
  us: 'https://smarthub-us.bestwaycorp.com',
};

const SMARTHUB_APP_ID     = 'AhFLL54HnChhrxcl9ZUJL6QNfolTIB';
const SMARTHUB_APP_SECRET = '4ECvVs13enL5AiYSmscNjvlaisklQDz7vWPCCWXcEFjhWfTmLT';
const SMARTHUB_TIMEOUT_MS = 10_000;

// Fixed initialisation vector — sourced from the decompiled Bestway Android
// app (com/rongwei/library/utils/AESEncrypt.java). Never changes between calls.
const AES_IV = Buffer.from([56, 110, 58, 168, 76, 255, 94, 159, 237, 215, 171, 181, 150, 40, 74, 166]);

// ── Structured error ─────────────────────────────────────────────────────────

class SmarthubError extends Error {
  constructor(code, message) {
    super(message ?? `SmartHub error ${code}`);
    this.code = code;
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

class BestwaySmarthubClient {

  /**
   * @param {object} [opts]
   * @param {string} [opts.region='eu']    'eu' or 'us'
   * @param {string} [opts.visitorId]      Reuse a previously issued visitor ID
   */
  constructor({ region = 'eu', visitorId } = {}) {
    this.region    = SMARTHUB_ROOTS[region] ? region : 'eu'; // normalise to known region
    this.apiRoot   = SMARTHUB_ROOTS[this.region];
    this.visitorId = visitorId ?? crypto.randomBytes(8).toString('hex');
    this._token    = null;
  }

  // ── Request signing ────────────────────────────────────────────────────

  /**
   * Build signed request headers.
   * Sign = MD5(appId + appSecret + nonce + timestamp).toUpperCase()
   *
   * The sign value is also returned because control() needs it for AES key
   * derivation — the key is unique per request, tied to the same sign.
   *
   * @returns {{ headers: object, sign: string }}
   */
  _buildHeaders() {
    const nonce = crypto.randomBytes(16).toString('hex').slice(0, 32);
    const ts    = String(Math.floor(Date.now() / 1000));
    const sign  = crypto
      .createHash('md5')
      .update(SMARTHUB_APP_ID + SMARTHUB_APP_SECRET + nonce + ts)
      .digest('hex')
      .toUpperCase();

    const headers = {
      'pushtype':        'fcm',
      'appid':           SMARTHUB_APP_ID,
      'nonce':           nonce,
      'ts':              ts,
      'accept-language': 'en',
      'sign':            sign,
      'Content-Type':    'application/json; charset=UTF-8',
      'Authorization':   this._token ? `token ${this._token}` : 'token',
    };

    return { headers, sign };
  }

  // ── HTTP helper ────────────────────────────────────────────────────────

  async _request(method, path, body) {
    const { headers } = this._buildHeaders();

    const opts = {
      method,
      headers,
      signal: AbortSignal.timeout(SMARTHUB_TIMEOUT_MS),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res  = await fetch(`${this.apiRoot}${path}`, opts);
    const json = await res.json();

    // SmartHub returns code=0 for success; anything else is an error.
    if (json.code !== undefined && json.code !== 0) {
      throw new SmarthubError(json.code, json.message);
    }

    return json.data ?? json;
  }

  // ── Authentication ─────────────────────────────────────────────────────

  /**
   * Obtain a visitor bearer token.
   *
   * No username or password is required. The persistent visitorId acts as
   * the account identity. Re-calling this method with the same visitorId
   * refreshes the token without any user interaction.
   *
   * @returns {string}  Bearer token for subsequent requests
   */
  async authenticate() {
    const data = await this._request('POST', '/api/enduser/visitor', {
      app_id:                 SMARTHUB_APP_ID,
      brand:                  '',
      lan_code:               'en',
      location:               'GB',
      marketing_notification: 0,
      push_type:              'fcm',
      timezone:               'GMT',
      visitor_id:             this.visitorId,
      registration_id:        '',
      client_id:              crypto.randomBytes(8).toString('hex'),
    });

    this._token = data.token;
    return this._token;
  }

  // ── Device linking ─────────────────────────────────────────────────────

  /**
   * Claim a share code from the Bestway Smart Hub app.
   *
   * The code can be generated inside the Bestway app under
   * Device → Share Device. It must start with "RW_Share_".
   *
   * @param {string} shareCode
   */
  async linkShareCode(shareCode) {
    if (!shareCode.startsWith('RW_Share_')) {
      throw new Error('Share code must start with "RW_Share_".');
    }
    await this._request('POST', '/api/enduser/grant_device', {
      vercode:   shareCode,
      push_type: 'android',
    });
  }

  // ── Device discovery ───────────────────────────────────────────────────

  /**
   * Return all devices by traversing Homes → Rooms → Devices.
   *
   * @returns {Array<object>}  Raw device objects from the SmartHub API
   */
  async getDevices() {
    const homesData = await this._request('GET', '/api/enduser/homes');
    const devices   = [];

    for (const home of (homesData.list ?? [])) {
      const roomsData = await this._request('GET', `/api/enduser/home/rooms?home_id=${home.id}`);
      for (const room of (roomsData.list ?? [])) {
        const devsData = await this._request('GET', `/api/enduser/home/room/devices?room_id=${room.id}`);
        devices.push(...(devsData.list ?? []));
      }
    }

    return devices;
  }

  // ── Device status ──────────────────────────────────────────────────────

  /**
   * Fetch the latest state from the device's AWS IoT shadow.
   *
   * The response is unwrapped from the shadow envelope so callers receive
   * a plain object with keys like power_state, water_temperature, etc.
   *
   * @param {string} deviceId
   * @param {string} productId
   * @returns {object}
   */
  async getDeviceStatus(deviceId, productId) {
    const data = await this._request('POST', '/api/device/thing_shadow/', {
      device_id:  deviceId,
      product_id: productId,
    });
    // Unwrap AWS shadow: reported > desired > state > raw
    return data?.state?.reported
      ?? data?.state?.desired
      ?? data?.state
      ?? data;
  }

  // ── Device control ─────────────────────────────────────────────────────

  /**
   * Send one or more state updates to the device via the encrypted V2 API.
   *
   * Encryption: AES-256-CBC
   *   Key  = SHA-256(sign + "," + appSecret).hex[:32] as UTF-8 bytes
   *   IV   = fixed 16-byte array (from Bestway Android app)
   *   Body = base64(IV || ciphertext)
   *
   * @param {string} deviceId
   * @param {string} productId
   * @param {object} updates  e.g. { power_state: 1 } or { heater_state: 0 }
   */
  async control(deviceId, productId, updates) {
    const { headers, sign } = this._buildHeaders();

    // Derive a per-request AES key from the sign value of this call.
    const keyHex = crypto
      .createHash('sha256')
      .update(`${sign},${SMARTHUB_APP_SECRET}`)
      .digest('hex')
      .slice(0, 32);
    const key = Buffer.from(keyHex, 'utf8');

    const payload = JSON.stringify({
      device_id:  deviceId,
      product_id: productId,
      // "desired" must be a JSON-stringified string (not an object) per the API spec
      desired: JSON.stringify({ state: { desired: updates } }),
    });

    const cipher    = crypto.createCipheriv('aes-256-cbc', key, AES_IV);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);

    const res  = await fetch(`${this.apiRoot}/api/v2/device/command`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ encrypted_data: Buffer.concat([AES_IV, encrypted]).toString('base64') }),
      signal:  AbortSignal.timeout(SMARTHUB_TIMEOUT_MS),
    });

    const json = await res.json();
    if (json.code !== 0) throw new SmarthubError(json.code, json.message);
  }

}

module.exports = { BestwaySmarthubClient, SmarthubError, SMARTHUB_ROOTS };
