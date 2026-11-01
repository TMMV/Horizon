// Fetches the latest UK market data from official sources and rewrites data/market.js.
// Run locally with `npm run update-market`, or weekly via .github/workflows/market-data.yml.
// The app never fetches anything itself; it only reads the bundled file.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'horizon-planner market data updater' };

function boeUrl(series, from) {
  const d = from.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '/');
  return `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${d}&Dateto=now&SeriesCodes=${series}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
}

// Latest (date, value) from a Bank of England IADB CSV export.
async function boeLatest(series) {
  const from = new Date(Date.now() - 120 * 864e5);
  const res = await fetch(boeUrl(series, from), { headers: UA });
  if (!res.ok) throw new Error(`BoE ${series}: HTTP ${res.status}`);
  const rows = (await res.text()).trim().split(/\r?\n/).map(l => l.split(',')).filter(r => r.length === 2 && !Number.isNaN(parseFloat(r[1])));
  if (!rows.length) throw new Error(`BoE ${series}: no data`);
  const [date, value] = rows[rows.length - 1];
  return { date: new Date(`${date} UTC`).toISOString().slice(0, 10), value: parseFloat(value) };
}

async function onsCpi() {
  const res = await fetch('https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23/data', { headers: UA });
  if (!res.ok) throw new Error(`ONS CPI: HTTP ${res.status}`);
  const months = (await res.json()).months;
  const last = months[months.length - 1];
  const monthNo = String(new Date(`${last.month} 1, 2000`).getMonth() + 1).padStart(2, '0');
  return { date: `${last.year}-${monthNo}`, value: parseFloat(last.value) };
}

const round1 = v => Math.round(v * 10) / 10;

async function main() {
  const [bank, gilt, cpi] = await Promise.all([boeLatest('IUDBEDR'), boeLatest('IUDMNPY'), onsCpi()]);

  // Long-run planning assumptions, deliberately simple and explainable.
  const inflation = round1(Math.min(4, Math.max(2, 2 + (cpi.value - 2) / 3)));
  const cashRate = round1(Math.max(0, bank.value - 0.25));
  const bondReturn = round1(Math.max(1, gilt.value - 0.3));

  const data = {
    asOf: new Date().toISOString().slice(0, 10),
    updatedBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'script',
    series: {
      bankRate: { label: 'Bank of England Bank Rate', value: bank.value, date: bank.date, source: 'https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate' },
      cpi: { label: 'CPI inflation (12 months)', value: cpi.value, date: cpi.date, source: 'https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23' },
      gilt10y: { label: '10-year gilt yield', value: Math.round(gilt.value * 100) / 100, date: gilt.date, source: 'https://www.bankofengland.co.uk/statistics/yield-curves' },
    },
    suggested: {
      inflation: { value: inflation, why: `CPI is ${cpi.value}%; the Bank of England targets 2%. The suggestion assumes a third of today's gap persists on average.` },
      cashRate: { value: cashRate, why: `Easy-access savings typically pay a little below Bank Rate (${bank.value}%).` },
      bondReturn: { value: bondReturn, why: `Starting yields are the best guide to long-run bond returns; 10-year gilts yield about ${round1(gilt.value)}%.` },
    },
  };

  const body = `// Latest UK market data, bundled with the app so the page itself never calls the network.
// Refreshed by scripts/update-market-data.mjs (run by .github/workflows/market-data.yml).
// "suggested" values are long-run planning assumptions derived from the latest data,
// not forecasts. The user chooses whether to apply them.
window.MARKET_DATA = ${JSON.stringify(data, null, 2)};
`;
  await writeFile(path.join(ROOT, 'data', 'market.js'), body);
  console.log(`Bank Rate ${bank.value}% (${bank.date}) · CPI ${cpi.value}% (${cpi.date}) · 10y gilt ${gilt.value}% (${gilt.date})`);
  console.log(`Suggested: inflation ${inflation}%, cash ${cashRate}%, bonds ${bondReturn}%`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
