// Latest UK market data, bundled with the app so the page itself never calls the network.
// Refreshed by scripts/update-market-data.mjs (run by .github/workflows/market-data.yml).
// "suggested" values are long-run planning assumptions derived from the latest data,
// not forecasts. The user chooses whether to apply them.
window.MARKET_DATA = {
  "asOf": "2026-11-09",
  "updatedBy": "github-actions",
  "series": {
    "bankRate": {
      "label": "Bank of England Bank Rate",
      "value": 4,
      "date": "2026-11-06",
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
      "value": 5.14,
      "date": "2026-11-05",
      "source": "https://www.bankofengland.co.uk/statistics/yield-curves"
    }
  },
  "suggested": {
    "inflation": {
      "value": 2.5,
      "why": "CPI is 3.5% today. Over a long plan inflation has mostly averaged near the Bank of England's 2% target, so the suggestion is 2% plus a third of today's gap above it."
    },
    "cashRate": {
      "value": 3.8,
      "why": "Easy-access savings typically pay a little below Bank Rate (4%)."
    },
    "bondReturn": {
      "value": 4.8,
      "why": "Starting yields are the best guide to long-run bond returns; 10-year gilts yield about 5.1%."
    }
  }
};
