// Supabase Edge Function: scheduled Toast ingestion (~6:00 AM America/New_York,
// processing the PRIOR completed business day).
//
// Schedule (Supabase Cron), note UTC offset — 10:00 UTC = 6:00 AM EDT:
//   select cron.schedule('toast-nightly', '0 10 * * *',
//     $$select net.http_post(url:='https://<PROJECT>.functions.supabase.co/ingest-toast',
//       headers:='{"Authorization":"Bearer <SERVICE_ROLE_JWT>"}'::jsonb)$$);
//
// STATUS: scaffold. The pull/normalize logic is proven in scripts/ingest-toast.mjs;
// this function ports it server-side once SUPABASE_URL/keys are configured.
// It must NEVER run with the anon key, and the service-role key never leaves
// the function environment.
//
// Contract (mirrors the brief):
//  1. insert ingestion_runs (status=running)
//  2. pull Toast ordersBulk for the prior business date (America/New_York)
//  3. store raw payload to private storage bucket (immutable)
//  4. upsert orders/checks/item_selections/menu_items by source GUID (idempotent)
//  5. recalc materialized aggregates
//  6. finish run with counts; on ANY failure mark failed and leave the previous
//     published snapshot untouched — a corrupt run is never partially published.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '__unset__')) {
    return new Response('forbidden', { status: 403 });
  }
  const missing = ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((k) => !Deno.env.get(k));
  if (missing.length) {
    return new Response(JSON.stringify({
      status: 'unconfigured',
      missing,
      note: 'Scaffold only — see scripts/ingest-toast.mjs for the proven pull/normalize implementation to port here.',
    }), { status: 501, headers: { 'content-type': 'application/json' } });
  }
  // TODO(port): scripts/ingest-toast.mjs logic — kept out until credentials are
  // provisioned so this function can never pretend to have synced.
  return new Response(JSON.stringify({ status: 'not_implemented' }), { status: 501 });
});
