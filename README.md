# Horizon

A private, local-first financial planner for UK households, with Scottish and rest-of-UK
tax rules. Inspired by tools like ProjectionLab, but nothing you enter ever leaves your
browser: there is no server, no account and no tracking, and the page is blocked from
making network requests.

**Try it:** [tmmv.github.io/Horizon](https://tmmv.github.io/Horizon/). It runs entirely in your
browser; your plan is saved only on your device (use **Data → Save to a file** to keep a copy).

![Home](screenshots/light-home.png)

## How it's organised

You set the plan up once, then review it once a year.

| Tab | What's there |
|---|---|
| **Home** | Your portfolio *today*: a donut and every account, grouped by when the money can be used (available now, locked in pensions and Lifetime ISAs, property, owed), estimated from your last figures (or a balance you updated since), with your estimated net worth and the change since your last update. The chart of where you're heading shows each part growing and adding up to your net worth, by account or by access, up to an age you choose (85 by default; the plan itself runs to each person's end age). Your goals as badges, where you're heading, what to invest each month this year, what's coming up, and suggestions worth a look. |
| **One tab per goal** | How it's tracking (its range of outcomes against the target), the chance by year, what moves it, what it would take, levers to try and how it does if history repeated. The retirement tab also replays the plan through every starting year since 1928. Add a goal with **+**. |
| **Finances** | All your inputs, with their prediction alongside and a "What your changes do" panel that shows every goal's chance move as you edit: **Portfolio** (accounts and how each grows), **Income**, **Spending** (with **Future costs**: children, cars, home repairs, care), **Saving & investing** (your own monthly amounts for Lifetime ISAs, ISAs, a general account and extra pension, or automatic; a suggested UK order with amounts for your household; and where the money goes year by year), **Cash flow & tax**, **Assumptions** (household, markets, tax rules and how things vary in the simulations) and **Past reviews**. At the top: the date your figures are as at. |
| **Scenarios** | Every scenario against every goal in one table (chance and expected year, compared with the one you have open), common choices compared side by side, and ready-made what-ifs to add. |

The **bell** at the top reminds you when it's time for the yearly review and when your figures
are a month old (update a few balances, or do a full review). Charts that look ahead have an **Adjust for inflation** switch: on, future amounts are in
today's money; off, they're the actual pounds of each year.

**Figures "as at" a date.** Balances, pay and spending describe one date (shown at the top of
Finances). From there Horizon estimates every account for any later day: Home shows today's
estimate, and the yearly review starts from the estimate for the review date, so you only type
over what's different. Between reviews, **Update balances** records a figure from your banking
app with its date; it shows on Home and feeds the next review.

## What it does

- **Household plan for one or two people.** Salaries (gross or take-home), workplace
  pensions with employer contributions and salary sacrifice, rental and other income,
  State Pension, spending, one-off events, and accounts: cash, ISAs, general investment
  account, pensions, bonds and gilts, property and mortgages.
- **UK tax, 2026/27.** Scottish or rest-of-UK income tax bands, personal allowance taper,
  National Insurance, capital gains tax, 25% tax-free pension cash, minimum pension age 57,
  frozen thresholds until April 2031, and the salary sacrifice NI cap from April 2029.
- **Year-by-year projection** of every account, with cash flow showing where money comes
  from and where it goes.
- **Saving strategy.** Surplus fills a cash buffer, then optional mortgage overpayments,
  then ISAs (up to the allowance), then a general investment account. In retirement it draws
  tax-efficiently: pensions within the personal allowance first, then GIA, ISA, and more pension.
- **Monte Carlo simulation of a whole economy.** Each simulated future draws its own stock
  and bond returns, inflation (with persistence), salary growth, house prices and interest
  rates (mortgages move after their fixed period ends). Fan charts show the range for each,
  and every one can be switched off or tuned.
- **Goals at the centre.** Retirement, emergency fund, mortgage-free, financial independence,
  an amount by a year, passive income, house deposit, university fund, big purchase, leaving
  an inheritance, or saving for anything else. Each goal has its own name, colour and icon
  badge, used on every chart; Home leads with them and each has its own tab (chance,
  progress, expected date, range of outcomes). Add or remove goals at any time; each has "what would it take" (the overpayment share,
  spending cut, cash buffer or retirement spending that gets you there).
- **What moves your goals.** Each goal's tab shows how typical choices (retire later or
  earlier, spend less now or in retirement, pay more into pensions, overpay the mortgage) and
  risks (weaker markets, higher inflation, a crash next year) change its chance, in points. Only
  changes that can affect that goal are shown: a goal dated before you retire isn't asked about
  retirement. Each goal's badge names its biggest help and biggest risk.
- **Scenario ideas.** One click adds a ready-made "what if" as a scenario: retire earlier or
  later, part-time work, a year out, six months out of work, a new baby, a market crash,
  lower returns, higher inflation, a higher rate when the mortgage fix ends, overpaying,
  spending less, selling a property, or care costs later in life.
- **Levers with trade-offs** (on each goal's tab, and in the add-goal wizard). Sliders for retirement ages, spending in retirement, spending
  now, extra pension saving, mortgage overpayments and lump sums, stock allocation, selling a
  property, and stress tests. A side-by-side table shows how every goal moves, so you can see
  that paying the mortgage off faster costs investing, and apply the result or save it as a
  scenario.
- **Workings under every input.** Each Finances page shows its prediction as a chart and a
  spreadsheet-style table: assumptions, income, spending, tax per person and each account's
  roll-forward (start + growth + in − out = end, checked on every
  row), each downloadable as CSV. Income items show their typical trend range.
- **Scenarios.** Duplicate the plan and change anything, or add a ready-made what-if.
  "Compare two choices" works out common decisions on every goal without saving anything:
  salary sacrifice or a Lifetime ISA (for the same take-home pay), pension or ISA, overpaying
  the mortgage or investing, retiring earlier or later, weaker or stronger markets, and the
  mortgage rate after a fix. Suggestions on Home link straight to the matching comparison.
- **Yearly review (every October).** A guided walk through every balance, income and
  spending item, each prefilled with Horizon's estimate for the review date (or a balance you
  updated since) so you only correct what changed. The review date becomes the date your
  figures are as at. It shows how far you are ahead of or behind last year's prediction, which accounts
  made the difference, and how each goal moved. It then rolls every scenario forward,
  growing amounts the way the plan expected and keeping each scenario's own assumptions,
  and gives this year's "invest each month" figure. The bell reminds you from October. Snapshots,
  past reviews and hand-entered past years are still there.
- **Charts you can check.** Every chart has a Chart/Table switch showing the exact numbers
  behind it (with CSV download), legend items that hide and show series, hover and keyboard
  tooltips, goal lines and milestone markers.
- **Plan check.** "Worth a look" tests the plan against common UK rules of thumb and
  2026/27 rules: emergency fund, saving rate, Child Benefit and the £60k–£80k charge,
  Tax-Free Childcare, the £100k tax trap, ISA allowances, overpaying vs investing, PLSA
  retirement living standards and how much wealth is tied up in property.
- **Future costs** (Finances → Spending). A questionnaire for the big costs that come with time:
  children (school, university, first car, wedding, house deposit), replacing cars, major
  home repairs, active early retirement, spending less later on, care in later life and
  helping family. Answers become dated spending items and events you can review.
- **Flexible income.** Salaries before tax or take-home, rent with exchange rate, costs and a
  flat tax, gifts with no tax, and defined benefit pensions (USS, NHS, teachers): what is
  built up so far plus what each further year adds, with any automatic lump sum. Tax can be
  switched off for the whole household.
- **More goal types.** Save for something by a year (e.g. university), passive income
  of £X a year by a year (a withdrawal rate on investments plus rent and pensions), and an
  emergency fund (months of spending and mortgage payments, in cash only or counting ISAs
  and investments, with the risk that markets are down when you need them).
- **Retirement questionnaire.** Retirement ages for each person, spending in retirement
  (your list, the PLSA minimum/moderate/comfortable standards, or your own figure), extra
  for the active early years, spending less later, and State Pension forecasts, with a live
  chance of success, range chart, earliest age and affordable spending.
- **Mortgage renewal.** When a fixed rate ends: the expected new rate, and whether the
  payment stays the same (the end date moves) or is reset to keep the end date. A Scenarios
  range and a slider try other rates.
- **Pension estimates.** For defined benefit schemes (USS, SAUL, LGPS Scotland, Scottish
  teachers, NHS Scotland) estimate what is built up from the year you joined and your salary.
- **Fees.** Fund and platform charges are taken off investment and pension growth.
- **Replaying history.** The plan is run from every starting year since 1928 using that
  period's real share and bond returns (US market, Damodaran/NYU) with UK inflation (ONS
  RPI) from the same years: how many starts the money survives, the toughest and kindest,
  famous stretches (1929, 1966, 1973, 2000, 2008) against the range, and each goal.
  `npm run update-history` refreshes `data/history.js`.
- **Lifetime ISA.** 25% bonus on up to £4,000 a year inside the ISA allowance, paid in until
  50 (opened before 40), for retirement from 60 or a first home; other withdrawals lose 25%.
- **Higher-rate pension relief.** Extra pension saving from take-home pay claims back tax
  above 20% (Scottish 21–48%, or 40–45%), including the £100k personal allowance trap.
- **Gilts in an ISA.** Bonds and gilts can be marked as held in an ISA, so maturing money
  stays sheltered without using the year's allowance.
- **Spending check-up.** A guided questionnaire that walks through home, food, transport,
  children, personal, subscriptions and holidays, pre-filled from your current spending.
  Each question shows a typical UK range scaled to your household (ONS Family Spending,
  Ofgem's price cap and common rules of thumb), and the summary compares your spending
  with the 50/30/20 guide and the average UK household.
- **Latest market data.** Bank Rate, CPI and 10-year gilt yields are bundled in
  `data/market.js` and refreshed weekly by a GitHub Action, with suggested planning
  assumptions you can apply in one click.

## Run it on your computer

Horizon is a set of plain files: nothing to build and no account. Your plan stays on your
computer either way.

### 1. Get the files

- **With Git:** `git clone https://github.com/TMMV/Horizon.git`
- **Without Git:** on the [GitHub page](https://github.com/TMMV/Horizon), click **Code →
  Download ZIP**, then unzip it somewhere you'll find it again (e.g. Documents\Horizon).

### 2. Start it

| On | Do this |
|---|---|
| **Windows** | Double-click **`start-horizon.bat`** in the Horizon folder. |
| **macOS / Linux** | In a terminal in the Horizon folder: `./start-horizon.sh` |
| **Anywhere with Node.js** | `npm start` |

Your browser opens **http://localhost:8765**. Keep the small window that appears open while
you use Horizon; close it (or press Ctrl+C) to stop. The scripts use
[Node.js](https://nodejs.org) if it is installed, otherwise Python, and only this computer can
reach the page. If you have neither, they open `index.html` straight from the folder, which
also works.

Tip (Windows): right-click `start-horizon.bat` → **Send to → Desktop (create shortcut)** to start
Horizon from your desktop.

### 3. Load your plan

It opens with a fictional example household. Use **Data → Open a saved file** to load a plan you
saved before, or **Data → Start a blank plan** to begin your own.

### Where your plan is kept

- Your plan is saved in your browser, **for that address**. The start scripts always use the
  same address (http://localhost:8765) so it is there next time. Opening `index.html` directly, or
  the [online copy](https://tmmv.github.io/Horizon/), keeps a separate plan.
- **Data → Save to a file** saves everything (scenarios, goals, check-ins, balance updates and
  settings) to one JSON file in your downloads. The Data menu shows when you last saved.
  Clearing your browser's data
  would delete the plan kept in the browser, so keep the file somewhere safe.
- **Carrying on on another computer** (or next year on a new one): save to a file, copy it
  across (USB stick, cloud drive, email to yourself), open Horizon there and use **Data → Open a
  saved file**. The same works between the local copy and the online one.
- `plans/example.json` is the fictional example. Keep your own export next to it as
  `plans/my-plan.json`: that name (and any `horizon-plan-*.json` export) is in `.gitignore`, so
  real figures never end up in the repository.

### Updating

With Git: `git pull` in the Horizon folder. Without Git: download the ZIP again and replace the
files (keep your `plans/my-plan.json`). Your plan stays in the browser either way, but save it
to a file first to be safe.

### Matching a spreadsheet

To reproduce a simple spreadsheet exactly, use the same simplifications it does:

- Finances → Assumptions → switch **Work out UK tax** off and enter take-home pay.
- Finances → Assumptions → Markets → **Use your own return** for investments and pensions (e.g. 10% and 7%).
- Set cash interest to 0 and the cash buffer to 0 so every penny of surplus is invested.
- Enter rent with its exchange rate, costs (%) and a flat tax rate, as in the sheet.

The tables under each Finances page then show the same year-by-year numbers, with a CSV download
to compare.

## Develop

```sh
npm install
npm test               # unit tests (Node's built-in runner)
npm run test:e2e       # browser tests with Playwright
npm run screenshots    # capture every view, light and dark, desktop and phone
npm run update-market  # refresh data/market.js from the Bank of England and ONS
npm run update-history # refresh data/history.js (market history since 1928)
npm start              # run it locally at http://localhost:8765 and open the browser
```

On Windows the browser tests use the installed Microsoft Edge. Elsewhere run
`npx playwright install chromium` once first.

### Layout

| Path | What it is |
|---|---|
| `index.html` | The page |
| `src/uk-rules.js` | Every UK tax number for the tax year, in one place |
| `src/engine.js` | Economy model, projection, Monte Carlo, goals, solvers, sweeps and check-ins. Pure functions, no DOM |
| `src/spending-wizard.js` | Spending check-up questions and how answers map to expenses |
| `src/benchmarks.js` | Typical UK spending ranges and the plan check ("worth a look") |
| `src/scenario-ideas.js` | "What moves your goals" drivers and the ready-made scenario ideas |
| `src/review.js` | The yearly review: roll forward, expected values, comparison, apply to scenarios |
| `src/life-wizard.js` | Future costs: the big costs that come with time |
| `src/levers.js` | The levers, how they change a plan, and goal-by-goal comparisons |
| `src/chart.js` | Small canvas chart library (stacked columns, bands, lines, areas, tooltips, table view) |
| `src/app.js` | The interface |
| `data/market.js` | Bundled market data |
| `scripts/update-market-data.mjs` | Fetches Bank Rate, CPI and gilt yields |
| `scripts/update-history-data.mjs` | Builds `data/history.js` from Damodaran (NYU), FRED and ONS |
| `scripts/serve.mjs`, `start-horizon.bat`, `start-horizon.sh` | Run it locally at http://localhost:8765 |
| `test/unit`, `test/e2e` | Tests |

### Updating for a new tax year

Change the numbers in `src/uk-rules.js`, update the expectations in
`test/unit/uk-rules.test.js`, and run the tests.

## Limitations

Horizon is a planning model, not financial advice. It does not model dividend or savings
interest tax, property income tax, inheritance tax (including pensions from April 2027),
the tapered annual allowance, the Pension Tax Allowance, or the effect of mortality. Stocks
and bonds are drawn independently of each other and of inflation, all properties share one
house-price swing per year, and mortgage payments stay fixed when rates change.
