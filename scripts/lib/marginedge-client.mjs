// MarginEdge Public API client — server-side only.
//
// Contract verified against the MarginEdge developer-portal Swagger export
// (see C:\Users\dombo\marginedge-mcp-read-only\docs\api-reference\). Every
// documented operation is GET; the public API has no mutation endpoints. This
// client sends GET only and refuses any other method, so an ACE bug can never
// write to MarginEdge.
//
// Credentials come from the environment (MARGINEDGE_API_KEY) and are never
// logged, echoed in errors, or shipped to the browser. The dashboard is a static
// GitHub Pages site — MarginEdge is reached exclusively from GitHub Actions.
//
// Read the module-level notes in src/marginedge-cost.mjs for why this client
// fetches PRODUCTS and INVOICE LINE ITEMS and not recipes: the public API
// exposes no recipe endpoints at all.
import fs from 'node:fs';
import path from 'node:path';

export const MARGINEDGE_BASE_URL = 'https://api.marginedge.com/public';
const RATE_LIMIT_MS = 1000;          // official limit: 1 request/second per key
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** Minimal .env loader mirroring scripts/lib/toast-client.mjs. */
export function loadDotEnv(root) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/\s+#.*$/, '').trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Required MarginEdge secrets that are absent from the environment. */
export function missingMarginEdgeSecrets(env = process.env) {
  const need = ['MARGINEDGE_API_KEY', 'MARGINEDGE_RESTAURANT_UNIT_ID'];
  return need.filter((k) => !env[k] || /^__/.test(env[k]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip anything credential-shaped out of a message before it is logged. */
export function sanitizeError(message, apiKey) {
  let s = String(message ?? '');
  if (apiKey) s = s.split(apiKey).join('[REDACTED]');
  return s.replace(/x-api-key['":\s=]+[^\s'",}]+/gi, 'x-api-key=[REDACTED]');
}

export class MarginEdgeClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey        MARGINEDGE_API_KEY
   * @param {number} opts.restaurantUnitId
   * @param {function} [opts.fetchImpl] injected for tests
   * @param {number}  [opts.rateLimitMs]
   * @param {function} [opts.log]
   */
  constructor({ apiKey, restaurantUnitId, fetchImpl, rateLimitMs = RATE_LIMIT_MS, log = () => {} } = {}) {
    if (!apiKey) throw new Error('MarginEdgeClient requires an apiKey (MARGINEDGE_API_KEY)');
    if (!restaurantUnitId) throw new Error('MarginEdgeClient requires a restaurantUnitId');
    // Non-enumerable so a stray console.log(client) / JSON.stringify(client)
    // can never print the key.
    Object.defineProperty(this, 'apiKey', { value: String(apiKey), enumerable: false, writable: false });
    this.restaurantUnitId = Number(restaurantUnitId);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.rateLimitMs = rateLimitMs;
    this.log = log;
    this.requestCount = 0;
    this._lastRequestAt = 0;
  }

  async _throttle() {
    const wait = this._lastRequestAt + this.rateLimitMs - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  /** One GET with throttling, bounded retries and sanitized errors. */
  async _get(pathname, params = {}) {
    const url = new URL(MARGINEDGE_BASE_URL + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this._throttle();
      this.requestCount++;
      let res;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
          // Never follow a redirect: the public API does not redirect, and a
          // cross-origin redirect would carry the x-api-key header to a third
          // host (fetch only strips Authorization on redirect, not custom headers).
          redirect: 'error',
        });
      } catch (e) {
        lastErr = new Error(`network error calling ${pathname}: ${sanitizeError(e.message, this.apiKey)}`);
        if (attempt === MAX_ATTEMPTS) throw lastErr;
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (e) {
          throw new Error(`${pathname} returned a non-JSON body: ${sanitizeError(e.message, this.apiKey)}`);
        }
      }
      // 401/403 → bad or unscoped key. 400/404 → our request is wrong. Never retry those.
      if (!RETRYABLE.has(res.status)) {
        const hint = res.status === 401 || res.status === 403
          ? ' — check MARGINEDGE_API_KEY and that the key is scoped to MARGINEDGE_RESTAURANT_UNIT_ID'
          : '';
        throw new Error(`MarginEdge ${pathname} failed: HTTP ${res.status}${hint}`);
      }
      lastErr = new Error(`MarginEdge ${pathname} failed: HTTP ${res.status}`);
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
    }
    throw lastErr ?? new Error(`MarginEdge ${pathname} failed`);
  }

  /**
   * Follow the cursor to completion. The public API uses an opaque `nextPage`
   * cursor and a fixed 100-record page size with no page-size parameter, so a
   * full catalogue read is simply "loop until nextPage is absent".
   *
   * maxPages exists as a runaway guard only; it defaults high enough to read
   * the whole Falls Church catalogue (observed > 4,100 products), unlike the
   * MCP's interactive 50-page cap.
   */
  async _getAllPages(pathname, params, collectionKey, { maxPages = 500 } = {}) {
    const out = [];
    let nextPage;
    let pages = 0;
    do {
      const body = await this._get(pathname, { ...params, nextPage });
      const chunk = body?.[collectionKey];
      if (chunk !== undefined && !Array.isArray(chunk)) {
        throw new Error(`${pathname}: expected "${collectionKey}" to be an array`);
      }
      if (Array.isArray(chunk)) out.push(...chunk);
      nextPage = body?.nextPage ?? undefined;
      pages++;
      if (pages >= maxPages && nextPage) {
        throw new Error(`${pathname}: exceeded the ${maxPages}-page runaway guard — refusing to return a partial catalogue`);
      }
    } while (nextPage);
    return out;
  }

  /* ------------------------------------------------------------- endpoints */

  /** GET /restaurantUnits — also the cheapest credential check. */
  async restaurantUnits() {
    const body = await this._get('/restaurantUnits');
    const list = body?.restaurants;
    if (!Array.isArray(list)) throw new Error('/restaurantUnits: expected a "restaurants" array');
    return list.map((u) => ({ id: Number(u.id), name: String(u.name ?? '') }));
  }

  /** GET /categories — normalized, with a food flag derived from categoryType. */
  async categories() {
    const raw = await this._getAllPages('/categories', { restaurantUnitId: this.restaurantUnitId }, 'categories');
    return raw.map((c) => ({
      categoryId: String(c.categoryId),
      categoryName: String(c.categoryName ?? ''),
      categoryType: String(c.categoryType ?? ''),
      accountingCode: c.accountingCode == null ? null : String(c.accountingCode),
      isFood: String(c.categoryType ?? '').toUpperCase() === 'FOOD',
    }));
  }

  /**
   * GET /products — the ingredient price source.
   * `latestPrice` is the ONLY price the API exposes; there is no history
   * endpoint (see productPriceHistory below for the invoice-derived version).
   */
  async products({ categories } = {}) {
    const raw = await this._getAllPages('/products', { restaurantUnitId: this.restaurantUnitId }, 'products');
    const catById = new Map((categories ?? []).map((c) => [c.categoryId, c]));
    return raw.map((p) => {
      const cats = Array.isArray(p.categories) ? p.categories : [];
      const resolved = cats.map((c) => catById.get(String(c.categoryId))).filter(Boolean);
      return {
        productId: String(p.companyConceptProductId),
        centralProductId: p.centralProductId == null || p.centralProductId === 'null'
          ? null : String(p.centralProductId),
        productName: String(p.productName ?? ''),
        latestPrice: p.latestPrice == null ? null : Number(p.latestPrice),
        reportByUnit: p.reportByUnit == null ? null : String(p.reportByUnit),
        taxExempt: Boolean(p.taxExempt),
        itemCount: Number(p.itemCount ?? 0),
        categoryIds: cats.map((c) => String(c.categoryId)),
        categoryNames: resolved.map((c) => c.categoryName),
        // A product is food when ANY allocated category is a FOOD category.
        isFood: resolved.some((c) => c.isFood),
      };
    });
  }

  /** GET /orders — invoice/credit summaries. MarginEdge "orders" are invoices. */
  async orders({ startDate, endDate, orderStatus } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate ?? ''))) {
      throw new Error('orders() requires startDate and endDate as YYYY-MM-DD');
    }
    const raw = await this._getAllPages('/orders', {
      restaurantUnitId: this.restaurantUnitId, startDate, endDate, orderStatus,
    }, 'orders');
    return raw.map((o) => ({
      orderId: String(o.orderId),
      invoiceNumber: o.invoiceNumber == null ? null : String(o.invoiceNumber),
      vendorId: o.vendorId == null ? null : String(o.vendorId),
      vendorName: String(o.vendorName ?? ''),
      invoiceDate: o.invoiceDate == null ? null : String(o.invoiceDate),
      createdDate: o.createdDate == null ? null : String(o.createdDate),
      orderTotal: o.orderTotal == null ? null : Number(o.orderTotal),
      status: String(o.status ?? ''),
    }));
  }

  /** GET /orders/{orderId} — line items carry the per-unit price and the product id. */
  async orderDetail(orderId) {
    const body = await this._get(`/orders/${encodeURIComponent(orderId)}`, {
      restaurantUnitId: this.restaurantUnitId,
    });
    const lines = Array.isArray(body?.lineItems) ? body.lineItems : [];
    return {
      orderId: String(body?.orderId ?? orderId),
      invoiceDate: body?.invoiceDate == null ? null : String(body.invoiceDate),
      isCredit: Boolean(body?.isCredit),
      vendorName: String(body?.vendorName ?? ''),
      lineItems: lines.map((l) => ({
        productId: l.companyConceptProductId == null || l.companyConceptProductId === 'null'
          ? null : String(l.companyConceptProductId),
        vendorItemCode: l.vendorItemCode == null ? null : String(l.vendorItemCode),
        vendorItemName: String(l.vendorItemName ?? ''),
        quantity: l.quantity == null ? null : Number(l.quantity),
        unitPrice: l.unitPrice == null ? null : Number(l.unitPrice),
        linePrice: l.linePrice == null ? null : Number(l.linePrice),
        packagingId: l.packagingId == null ? null : String(l.packagingId),
        categoryId: l.categoryId == null ? null : String(l.categoryId),
      })),
    };
  }

  /**
   * Invoice-derived price history for a set of products.
   *
   * MarginEdge exposes no price-history endpoint, so real effective dates come
   * from invoice line items: (invoiceDate, productId) → unitPrice. This is the
   * only trustworthy source of "what did this ingredient cost on that date",
   * and it is what ACE uses for historical cost records instead of pretending
   * today's latestPrice always applied.
   *
   * HEAVY: one request per invoice. Bounded by the caller's date range.
   * Credit memos are skipped — negative quantities are not price observations.
   */
  async productPriceHistory({ startDate, endDate, productIds, onProgress } = {}) {
    const wanted = productIds ? new Set([...productIds].map(String)) : null;
    const invoices = await this.orders({ startDate, endDate });
    const byProduct = new Map();
    let scanned = 0;
    for (const inv of invoices) {
      const detail = await this.orderDetail(inv.orderId);
      scanned++;
      onProgress?.({ scanned, total: invoices.length, orderId: inv.orderId });
      if (detail.isCredit) continue;
      const date = detail.invoiceDate ?? inv.invoiceDate;
      if (!date) continue;
      for (const line of detail.lineItems) {
        if (!line.productId) continue;
        if (wanted && !wanted.has(line.productId)) continue;
        if (!Number.isFinite(line.unitPrice) || line.unitPrice <= 0) continue;
        if (Number.isFinite(line.quantity) && line.quantity < 0) continue; // credit line
        if (!byProduct.has(line.productId)) byProduct.set(line.productId, []);
        byProduct.get(line.productId).push({
          date, unitPrice: line.unitPrice, vendorName: detail.vendorName,
          orderId: detail.orderId, packagingId: line.packagingId,
        });
      }
    }
    for (const obs of byProduct.values()) obs.sort((a, b) => a.date.localeCompare(b.date));
    return { invoicesScanned: scanned, byProduct };
  }
}

/** Build a client from the environment. Throws with an actionable message. */
export function clientFromEnv({ fetchImpl, log } = {}) {
  const absent = missingMarginEdgeSecrets();
  if (absent.length) {
    throw new Error(
      `Missing required MarginEdge secret(s): ${absent.join(', ')}. `
      + 'Set them as GitHub Actions repository secrets (see docs/CREDENTIALS.md) '
      + 'or in a local .env — never in committed files.');
  }
  return new MarginEdgeClient({
    apiKey: process.env.MARGINEDGE_API_KEY,
    restaurantUnitId: Number(process.env.MARGINEDGE_RESTAURANT_UNIT_ID),
    fetchImpl, log,
  });
}

/** Index products by id for cost derivation. */
export function indexProducts(products) {
  return new Map(products.map((p) => [String(p.productId), p]));
}
