/* Source adapter contracts — the application depends on these interfaces,
   never on a specific ingestion method. Adapters currently implemented:

   ToastSource
     ToastApiAdapter        ✅ scripts/ingest-toast.mjs (live; pulled the pilot dataset)
     ToastCsvAdapter        ◐ Data Import page detects/validates selection CSVs;
                              row mapping finalizes when a real export sample exists
     ToastNightlyExportAdapter  ⛔ stub — needs Toast nightly-export/SFTP config
     ToastMcpAdapter        ⛔ deliberately NOT wired for production: the cloud
                              Toast MCP is an interactive tool; unattended
                              server-to-server use is unverified. Do not assume it.

   OpenTableSource
     OpenTableCsvAdapter    ◐ Data Import page detects/validates intent CSVs
     OpenTableSyncApiAdapter ⛔ stub — production API access not granted
                              (see docs/CREDENTIALS.md)

   Every adapter resolves to the same normalized shapes the engine consumes
   (see data/live/selections_*.json / checks_*.json and docs/DATA_DICTIONARY.md).
*/

/** @typedef {Object} IngestionResult
 *  @property {string} runId
 *  @property {'success'|'failed'|'partial'} status
 *  @property {Array}  selections  normalized selection rows
 *  @property {Array}  checks      normalized check rows
 *  @property {Array}  warnings
 */

export class ToastSource {
  /** @param {string} businessDate YYYYMMDD @returns {Promise<IngestionResult>} */
  async pull(businessDate) { throw new Error('ToastSource.pull not implemented'); }
}

export class OpenTableSource {
  /** @param {string} businessDate YYYYMMDD @returns {Promise<{intents: Array}>} */
  async pull(businessDate) { throw new Error('OpenTableSource.pull not implemented'); }
}

/** Preferred source order (first available wins). */
export const SOURCE_PREFERENCE = {
  toast: ['ToastApiAdapter', 'ToastNightlyExportAdapter', 'ToastCsvAdapter'],
  opentable: ['OpenTableSyncApiAdapter', 'OpenTableCsvAdapter'],
};

export class ToastNightlyExportAdapter extends ToastSource {
  constructor() {
    super();
    this.missing = 'TOAST_EXPORT_SFTP_HOST / TOAST_EXPORT_SFTP_KEY — see docs/CREDENTIALS.md';
  }
  async pull() { throw new Error(`ToastNightlyExportAdapter unconfigured: ${this.missing}`); }
}

export class OpenTableSyncApiAdapter extends OpenTableSource {
  constructor() {
    super();
    this.missing = 'OPENTABLE_CLIENT_ID / OPENTABLE_CLIENT_SECRET — production access not granted; see docs/CREDENTIALS.md';
  }
  async pull() { throw new Error(`OpenTableSyncApiAdapter unconfigured: ${this.missing}`); }
}
