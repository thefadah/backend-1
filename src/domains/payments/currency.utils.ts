/**
 * currency.utils.ts — @dorisio/payments
 *
 * Utilities for multi-currency presentation, symbols, formatting,
 * and exchange rate information across all payment and tip endpoints.
 */

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  XLM: 'XLM',
  USDC: 'USDC',
};

/**
 * Returns the presentation symbol for a given currency code.
 * Falls back to the uppercase currency code if no specific symbol is mapped.
 */
export function getCurrencySymbol(currencyCode?: string | null): string {
  if (!currencyCode) return '$';
  const normalized = currencyCode.trim().toUpperCase();
  return CURRENCY_SYMBOLS[normalized] ?? normalized;
}

/**
 * Formats a monetary amount with its currency symbol/code for unambiguous display.
 * Examples:
 *   formatCurrencyAmount(25, 'USD') -> "$25.00"
 *   formatCurrencyAmount(50, 'EUR') -> "€50.00"
 *   formatCurrencyAmount(100, 'XLM') -> "100.00 XLM"
 */
export function formatCurrencyAmount(amount: number, currencyCode: string): string {
  const code = (currencyCode || 'USD').toUpperCase();
  const symbol = getCurrencySymbol(code);
  const formattedNumber = amount.toFixed(2);

  if (symbol === '$' || symbol === '€' || symbol === '£') {
    return `${symbol}${formattedNumber}`;
  }
  return `${formattedNumber} ${code}`;
}

export interface ExchangeRateInfo {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
}

export interface MultiCurrencyFields {
  currency: string;
  currencyCode: string;
  currencySymbol: string;
  formattedAmount: string;
  exchangeRate: number | null;
  exchangeRateInfo: ExchangeRateInfo | null;
}

/**
 * Enriches payment responses with unambiguous currency fields, symbols,
 * formatted display amounts, and optional exchange rate conversion details.
 */
export function buildMultiCurrencyDetails(
  amount: number,
  currencyCode: string = 'USD',
  exchangeRate?: number | null,
  targetCurrency?: string | null
): MultiCurrencyFields {
  const code = (currencyCode || 'USD').toUpperCase();
  const symbol = getCurrencySymbol(code);
  const formatted = formatCurrencyAmount(amount, code);

  let exchangeRateInfo: ExchangeRateInfo | null = null;
  if (exchangeRate && targetCurrency && targetCurrency.toUpperCase() !== code) {
    exchangeRateInfo = {
      fromCurrency: code,
      toCurrency: targetCurrency.toUpperCase(),
      rate: exchangeRate,
    };
  }

  return {
    currency: code,
    currencyCode: code,
    currencySymbol: symbol,
    formattedAmount: formatted,
    exchangeRate: exchangeRate ?? null,
    exchangeRateInfo,
  };
}
