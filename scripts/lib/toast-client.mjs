// Minimal read-only Toast API client for ingestion scripts.
// Credentials are NEVER stored in this repository. They are resolved at runtime from:
//   1. Environment variables TOAST_CLIENT_ID / TOAST_CLIENT_SECRET
//   2. A local .env file next to the repo root (gitignored)
//   3. --allow-desktop-config: the operator's local Claude desktop config (dev machine only)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROD_HOST = 'https://ws-api.toasttab.com';

export function loadDotEnv(repoRoot) {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function resolveCredentials({ allowDesktopConfig = false } = {}) {
  let clientId = process.env.TOAST_CLIENT_ID;
  let clientSecret = process.env.TOAST_CLIENT_SECRET;
  if ((!clientId || !clientSecret) && allowDesktopConfig) {
    // Dev-machine fallback: reuse the credentials already configured for the
    // local read-only Toast MCP server. Never copied anywhere; read at runtime.
    const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const server of Object.values(cfg.mcpServers ?? {})) {
        const env = server.env ?? {};
        if (env.TOAST_CLIENT_ID && env.TOAST_CLIENT_SECRET) {
          clientId = clientId || env.TOAST_CLIENT_ID;
          clientSecret = clientSecret || env.TOAST_CLIENT_SECRET;
          break;
        }
      }
    }
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing Toast credentials. Set TOAST_CLIENT_ID and TOAST_CLIENT_SECRET in the environment or .env, ' +
      'or pass --allow-desktop-config on the operator dev machine.'
    );
  }
  return { clientId, clientSecret };
}

export class ToastClient {
  constructor({ clientId, clientSecret, restaurantGuid }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.restaurantGuid = restaurantGuid;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    const res = await fetch(`${PROD_HOST}/authentication/v1/authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        userAccessType: 'TOAST_MACHINE_CLIENT',
      }),
    });
    if (!res.ok) throw new Error(`Toast auth failed: HTTP ${res.status}`);
    const body = await res.json();
    this.token = body?.token?.accessToken;
    const ttl = body?.token?.expiresIn ?? 3600;
    this.tokenExpiresAt = Date.now() + (ttl - 120) * 1000;
    if (!this.token) throw new Error('Toast auth response contained no access token');
  }

  async get(pathname, params = {}) {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.authenticate();
    const url = new URL(`${PROD_HOST}${pathname}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Toast-Restaurant-External-ID': this.restaurantGuid,
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.get(pathname, params);
    }
    if (!res.ok) throw new Error(`GET ${pathname} failed: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Pull every order for a business date via the paginated bulk endpoint. */
  async ordersForBusinessDate(businessDate) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this.get('/orders/v2/ordersBulk', { businessDate, page, pageSize: 100 });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  employees() { return this.get('/labor/v1/employees'); }
  revenueCenters() { return this.get('/config/v2/revenueCenters', { pageSize: 200 }); }
  serviceAreas() { return this.get('/config/v2/serviceAreas', { pageSize: 200 }); }
  diningOptions() { return this.get('/config/v2/diningOptions', { pageSize: 200 }); }
  tables() { return this.get('/config/v2/tables', { pageSize: 500 }); }
}
