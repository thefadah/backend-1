# Multi-Currency Handling and Presentation

## Overview

The Dorisio backend provides multi-currency support across payment, refund, and tip transactions. Responses clearly distinguish between internal amounts, presentation symbols, currency codes, and exchange rate conversions.

## Supported Currencies

- **Fiat Currencies**: `USD` ($), `EUR` (€), `GBP` (£)
- **Stellar Assets**: `USDC` (USDC), `XLM` (XLM)

## Response Payload Fields

All payment, refund, and tip responses include explicit currency metadata:

| Field | Type | Description | Example |
|---|---|---|---|
| `amount` | `number` | Numeric amount of the transaction | `25.00` |
| `currency` | `string` | Canonical uppercase currency/asset code | `"USD"` |
| `currencyCode` | `string` | Canonical uppercase ISO/asset currency code | `"USD"` |
| `currencySymbol` | `string` | Display symbol for UI rendering | `"$"` |
| `formattedAmount` | `string` | Formatted human-readable amount with symbol | `"$25.00"` or `"50.00 XLM"` |
| `exchangeRate` | `number \| null` | Conversion rate if converted from a base currency | `1.08` |
| `exchangeRateInfo` | `object \| null` | Granular exchange rate breakdown | See below |

### `exchangeRateInfo` Structure

When applicable, `exchangeRateInfo` provides:
```json
{
  "fromCurrency": "EUR",
  "toCurrency": "USD",
  "rate": 1.085
}
```

## Utility Functions

Multi-currency normalization and formatting utilities are available in `src/domains/payments/currency.utils.ts`:
- `getCurrencySymbol(code)`: Resolves symbol for currency code (e.g. `USD` -> `$`, `EUR` -> `€`).
- `formatCurrencyAmount(amount, code)`: Formats amount with prefix or suffix depending on currency convention.
- `buildMultiCurrencyDetails(amount, currencyCode, exchangeRate, targetCurrency)`: Builds multi-currency payload fields for responses.
