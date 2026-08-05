// Pure date-range resolution for the operations pages. Extracted from the
// browser page module so range validation is unit-testable.
//
// resolveRange(state, availableDates) → {
//   dates: string[] (YYYYMMDD, ascending, within available data),
//   label: string   (human description of the selection),
//   invalid: null | { message }  — set when a custom range is impossible
//                                  (From after To). Invalid ranges resolve to
//                                  NO dates and the UI must show the message
//                                  instead of silently rendering emptiness.
// }

function D(yyyymmdd) {
  return new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
}
function K(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

export function fmtDateShort(yyyymmdd) {
  const s = String(yyyymmdd ?? '');
  return s.length === 8 ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : '—';
}

export function resolveRange(state, avail) {
  if (!avail.length) return { dates: [], label: 'no data', invalid: null };
  const latest = avail[avail.length - 1];
  const latestD = D(latest);
  const inRange = (from, to) => avail.filter((x) => x >= from && x <= to);
  switch (state.preset) {
    case 'yesterday': return { dates: [latest], label: `latest day (${fmtDateShort(latest)})`, invalid: null };
    case 'week': {
      const start = new Date(latestD); start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      return { dates: inRange(K(start), latest), label: 'current week', invalid: null };
    }
    case 'prevweek': {
      const start = new Date(latestD); start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      return { dates: inRange(K(start), K(end)), label: 'previous week', invalid: null };
    }
    case 'month': return { dates: avail.filter((x) => x.slice(0, 6) === latest.slice(0, 6)), label: 'current month', invalid: null };
    case 'prevmonth': {
      const pm = new Date(latestD); pm.setUTCMonth(pm.getUTCMonth() - 1);
      const key = K(pm).slice(0, 6);
      return { dates: avail.filter((x) => x.slice(0, 6) === key), label: 'previous month', invalid: null };
    }
    case 'custom': {
      const from = state.from ?? latest, to = state.to ?? latest;
      if (from > to) {
        return {
          dates: [], label: `custom ${fmtDateShort(from)}–${fmtDateShort(to)}`,
          invalid: {
            message: `The start date (${fmtDateShort(from)}) is after the end date (${fmtDateShort(to)}). `
              + 'Swap them or pick a new range — nothing is shown until the range makes sense.',
          },
        };
      }
      return { dates: inRange(from, to), label: `custom ${fmtDateShort(from)}–${fmtDateShort(to)}`, invalid: null };
    }
    case 'pilot': default:
      return { dates: avail.filter((x) => x >= '20260731' && x <= '20260802'), label: 'pilot weekend', invalid: null };
  }
}
