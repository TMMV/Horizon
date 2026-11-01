// Latest UK market data, bundled with the app so the page itself never calls the network.
// Refreshed by scripts/update-market-data.mjs (run by .github/workflows/market-data.yml).
// "suggested" values are long-run planning assumptions derived from the latest data,
// not forecasts. The user chooses whether to apply them.
window.MARKET_DATA = {
  "asOf": "2026-11-01",
  "updatedBy": "script",
  "series": {
    "bankRate": {
      "label": "Bank of England Bank Rate",
      "value": 3.75,
      "date": "2026-10-29",
      "source": "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate"
    },
    "cpi": {
      "label": "CPI inflation (12 months)",
      "value": 3.5,
      "date": "2026-09",
      "source": "https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23"
    },
    "gilt10y": {
      "label": "10-year gilt yield",
      "value": 5.31,
      "date": "2026-10-28",
      "source": "https://www.bankofengland.co.uk/statistics/yield-curves"
    }
  },
  "suggested": {
    "inflation": {
      "value": 2.5,
      "why": "CPI is 3.5%; the Bank of England targets 2%. The suggestion assumes a third of today's gap persists on average."
    },
    "cashRate": {
      "value": 3.5,
      "why": "Easy-access savings typically pay a little below Bank Rate (3.75%)."
    },
    "bondReturn": {
      "value": 5,
      "why": "Starting yields are the best guide to long-run bond returns; 10-year gilts yield about 5.3%."
    }
  }
};
