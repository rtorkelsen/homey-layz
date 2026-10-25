'use strict';

/**
 * Bestway Smart Home (Gizwits AEP) API Client
 *
 * Handles communication with the newer Bestway "Smart Home" cloud gateway used
 * by the Bestway Connect app for 2025+ UltraFit-generation devices (Airjet V02
 * "UltraFit" pumps and similar). This is a THIRD backend, distinct from both
 * the Gizwits V01 client (BestwayClient.js) and the older SmartHub/AWS-IoT
 * client (BestwaySmarthubClient.js) — different host, different auth scheme,
 * different device-sharing model.
 *
 * Background: starting around July 2026, the Bestway Connect app's "Share
 * Device" QR code stopped producing an "RW_Share_" text code and instead
 * encodes a URL such as:
 *   https://smart-spa-eu-app.bestwaycorp.com/app/<app-id>/shareDevice/index.html?shareId=<hex>
 * The old grant_device endpoint (BestwaySmarthubClient) has no record of
 * these new shares and rejects them with business code 16009. This client
 * implements the correct endpoints for that new share/device model.
 *
 * Protocol notes (established by the ha-bestway Home Assistant integration,
 * verified against real UltraFit hardware — see
 * https://github.com/cdpuk/ha-bestway/pull/139):
 *   - Auth is an anonymous session token; no username/password required.
 *   - Every response is HTTP 200 with a business `code` in the JSON body
 *     ("200" on success) — errors are reported there, not via HTTP status.
 *   - The device shadow exposes the same raw field names as the older
 *     SmartHub/AWS-IoT backend (power_state, water_temperature, etc.), so no
 *     extra field-name translation is needed by callers of this client.
 *   - Bubbles (wave_state) on these UltraFit pumps are on/off only — write
 *     1/0, not the 50/100 low/high scale used by the older SmartHub backend.
 *
 * Regional gateways:
 *   EU: https://smart-spa-eu-app.bestwaycorp.com
 *   US: https://smart-spa-us-app.bestwaycorp.com
 */

const crypto = require('crypto');

const SMART_HOME_ROOTS = {
  eu: 'https://smart-spa-eu-app.bestwaycorp.com',
  us: 'https://smart-spa-us-app.bestwaycorp.com',
};

const SMART_HOME_APP_ID     = '39ef26ff404a4cb1b5652f336d4bc045';
const SMART_HOME_TIMEOUT_MS = 8_000;
const SMART_HOME_USER_AGENT = 'gizwitssuperapprn/131600000';

// A share id is a hex token; kept deliberately broad (16-64 hex chars) so
// minor backend changes to the id length don't reject an otherwise valid
// invitation.
const SHARE_ID_RE = /^[0-9a-fA-F]{16,64}$/;
// Host pattern for the new share URLs, e.g.
// https://smart-spa-eu-app.bestwaycorp.com/app/<appid>/shareDevice/index.html?shareId=<id>
const SHARE_HOST_RE = /^smart-spa-([a-z]{2})-app\.bestwaycorp\.com$/i;

// ── Structured error ─────────────────────────────────────────────────────────

class SmartHomeError extends Error {
  constructor(code, message) {
    super(message ?? `Smart Home error ${code}`);
    this.code = code;
  }
}

// ── Share input parsing ──────────────────────────────────────────────────────

/**
 * Parse a "Share Device" QR value into a { shareId, region } pair.
 *
 * Accepts either:
 *   - the full share URL scanned from the QR code (region is derived from
 *     the host, e.g. "smart-spa-eu-app.bestwaycorp.com" → "eu")
 *   - a bare share id (hex string, 16-64 chars) — region is left null and
 *     the caller should try all known regions
 *
 * @param {string} raw
 * @returns {{ shareId: string, region: string|null }}
 * @throws {Error} If no valid share id can be found. The message never
 *   includes the share id itself.
 */
function parseShareInput(raw) {
  const value = (raw ?? '').trim();
  if (!value) {
    throw new Error('Share code is empty.');
  }

  // Bare share id (not a URL).
  if (!value.includes('://') && !value.includes('/')) {
    if (SHARE_ID_RE.test(value)) {
      return { shareId: value, region: null };
    }
    throw new Error('Not a valid share id.');
  }

  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new Error('Not a valid share URL.');
  }

  const hostMatch = SHARE_HOST_RE.exec(url.hostname || '');
  const region     = hostMatch ? hostMatch[1].toLowerCase() : null;
  const shareId    = (url.searchParams.get('shareId') || '').trim();

  if (!shareId) {
    throw new Error('Share URL is missing a shareId.');
  }
  if (!SHARE_ID_RE.test(shareId)) {
    throw new Error('Share id has an unexpected format.');
  }

  return { shareId, region: SMART_HOME_ROOTS[region] ? region : null };
}

/**
 * Generate a stable, per-install pseudo-UUID for the anonymous session.
 * Format-compatible with the app's own phoneId (RFC 4122 v4 shape), but the
 * gateway treats it as an opaque identifier — exact conformance isn't
 * required, just uniqueness and stability across polls.
 */
function generatePhoneId() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Client ───────────────────────────────────────────────────────────────────

class BestwaySmartHomeClient {

  /**
   * @param {object} [opts]
   * @param {string} [opts.region='eu']  'eu' or 'us'
   * @param {string} [opts.phoneId]      Reuse a previously issued phone id
   */
  constructor({ region = 'eu', phoneId } = {}) {
    this.region  = SMART_HOME_ROOTS[region] ? region : 'eu'; // normalise to known region
    this.apiRoot = SMART_HOME_ROOTS[this.region];
    this.phoneId = phoneId ?? generatePhoneId();
    this._token  = null;
  }

  // ── HTTP helper ────────────────────────────────────────────────────────

  _headers(authed) {
    const headers = {
      'X-Gizwits-Application-Id': SMART_HOME_APP_ID,
      'Content-Type':             'application/json',
      'Accept':                   'application/json; charset=utf-8',
      'version':                  '1.0',
      'User-Agent':                SMART_HOME_USER_AGENT,
    };
    if (authed) {
      if (!this._token) throw new Error('No session token available');
      headers['Authorization']        = this._token;
      headers['X-Gizwits-User-Token'] = this._token;
    }
    return headers;
  }

  /**
   * Perform a request and return the `data` field of the validated response.
   *
   * The gateway always answers HTTP 200; success/failure is encoded in a
   * business `code` field inside the JSON body ("200" = success), so a plain
   * `response.ok` check is not enough.
   */
  async _request(method, path, { body, authed = true } = {}) {
    const opts = {
      method,
      headers: this._headers(authed),
      signal:  AbortSignal.timeout(SMART_HOME_TIMEOUT_MS),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res  = await fetch(`${this.apiRoot}${path}`, opts);
    const json = await res.json();

    const code = String(json?.code);
    if (json?.error || code !== '200') {
      // Map the auth/session codes to a distinguishable error so callers can
      // trigger re-authentication rather than a generic failure.
      if (code === '505' || code === '401' || code === '403') {
        throw new SmartHomeError(code, `Session rejected (code ${code})`);
      }
      throw new SmartHomeError(code, json?.message || `API error (code ${code})`);
    }
    return json.data;
  }

  // ── Authentication ─────────────────────────────────────────────────────

  /**
   * Create or refresh the anonymous session.
   *
   * @returns {string} Session token for subsequent requests
   */
  async authenticate() {
    const data = await this._request('POST', '/app/smart_home/login/anonymous', {
      authed: false,
      body: {
        appKey:  SMART_HOME_APP_ID,
        data:    { phoneId: this.phoneId, homeName: 'Homey', lang: 'en' },
        version: '1.0',
      },
    });

    const token = data?.userToken;
    if (!token) throw new Error('No token in login response');
    this._token = token;
    return token;
  }

  // ── Device sharing ──────────────────────────────────────────────────────

  /**
   * Redeem a "Share Device" invitation for the current session.
   * The share id travels in the URL path; the request body is empty.
   *
   * @param {string} shareId
   */
  async acceptShare(shareId) {
    try {
      await this._request('POST', `/app/smartHome/homes/singleDeviceShareV2/${shareId}`);
    } catch (err) {
      const code = err instanceof SmartHomeError ? err.code : null;
      if (code === '2000066') {
        // "You have already shared this device" — the owner re-scanned their
        // own invitation. Treat as already-linked, not fatal.
        return;
      }
      if (code === '4000002' || code === '4000001') {
        throw new Error('Share code is invalid or has expired.');
      }
      if (code === '2000001' || code === '2000021') {
        throw new Error('Device not found for this share code.');
      }
      throw new Error(err.message || 'Could not redeem share code.');
    }
  }

  // ── Device discovery ───────────────────────────────────────────────────

  /**
   * Return all devices bound to the current session, normalized to the same
   * shape BestwaySmarthubClient.getDevices() callers already expect.
   *
   * @returns {Array<{device_id: string, product_id: string, device_alias: string, is_online: boolean}>}
   */
  async getDevices() {
    const data = await this._request('GET', '/app/smartHome/v2/users/devices');
    const list = Array.isArray(data) ? data : [];

    return list
      .filter(d => d?.mac && d?.productKey)
      .map(d => ({
        device_id:    d.mac,
        product_id:   d.productKey,
        device_alias: d.name || d.mac,
        is_online:    d.onlineStatus === 1,
      }));
  }

  // ── Device status ───────────────────────────────────────────────────────

  /**
   * Fetch the latest device shadow.
   *
   * Field names match what BestwaySmarthubClient.getDeviceStatus() returns
   * (power_state, water_temperature, temperature_setting, heater_state,
   * filter_state, wave_state, hydrojet_state, locked, warning, error_code,
   * …) — callers do not need to branch on backend to read status.
   *
   * @param {string} deviceId   MAC address (used as device_id)
   * @param {string} productId  Product key
   * @returns {object}
   */
  async getDeviceStatus(deviceId, productId) {
    const data = await this._request('GET', `/app/device/shadow/${productId}/${deviceId}`);
    return data ?? {};
  }

  // ── Device control ─────────────────────────────────────────────────────

  /**
   * Send one or more state updates to the device.
   *
   * Unlike the legacy SmartHub backend, this gateway uses plaintext JSON (no
   * AES encryption) but wraps the update object as a JSON *string* inside
   * the request envelope's `data` field.
   *
   * Note: bubbles (wave_state) are on/off only on this backend — pass 1/0,
   * not the 50/100 low/high values used by BestwaySmarthubClient.
   *
   * @param {string} deviceId
   * @param {string} productId
   * @param {object} updates  e.g. { power_state: 1 } or { heater_state: 0 }
   */
  async control(deviceId, productId, updates) {
    await this._request('POST', `/app/device/control/${productId}/${deviceId}`, {
      body: {
        appKey:  SMART_HOME_APP_ID,
        data:    JSON.stringify(updates),
        version: '1.0',
      },
    });
  }

}

module.exports = { BestwaySmartHomeClient, SmartHomeError, SMART_HOME_ROOTS, parseShareInput };
