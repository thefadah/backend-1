import { describe, it, expect } from 'vitest';
import {
  getCurrencySymbol,
  formatCurrencyAmount,
  buildMultiCurrencyDetails,
} from '../currency.utils';

describe('Multi-Currency Support Utilities (#246)', () => {
  describe('getCurrencySymbol', () => {
    it('returns appropriate symbols for fiat and crypto currencies', () => {
      expect(getCurrencySymbol('USD')).toBe('$');
      expect(getCurrencySymbol('EUR')).toBe('€');
      expect(getCurrencySymbol('GBP')).toBe('£');
      expect(getCurrencySymbol('XLM')).toBe('XLM');
      expect(getCurrencySymbol('USDC')).toBe('USDC');
    });

    it('falls back gracefully to default or normalized code', () => {
      expect(getCurrencySymbol(null)).toBe('$');
      expect(getCurrencySymbol(undefined)).toBe('$');
      expect(getCurrencySymbol('jpy')).toBe('JPY');
    });
  });

  describe('formatCurrencyAmount', () => {
    it('formats fiat currency with prefix symbol', () => {
      expect(formatCurrencyAmount(25, 'USD')).toBe('$25.00');
      expect(formatCurrencyAmount(12.5, 'EUR')).toBe('€12.50');
      expect(formatCurrencyAmount(99.99, 'GBP')).toBe('£99.99');
    });

    it('formats crypto and other currencies with code suffix', () => {
      expect(formatCurrencyAmount(100, 'XLM')).toBe('100.00 XLM');
      expect(formatCurrencyAmount(50, 'USDC')).toBe('50.00 USDC');
    });
  });

  describe('buildMultiCurrencyDetails', () => {
    it('generates complete currency metadata without exchange rate', () => {
      const details = buildMultiCurrencyDetails(25, 'USD');
      expect(details).toEqual({
        currency: 'USD',
        currencyCode: 'USD',
        currencySymbol: '$',
        formattedAmount: '$25.00',
        exchangeRate: null,
        exchangeRateInfo: null,
      });
    });

    it('generates multi-currency details with exchangeRate and targetCurrency', () => {
      const details = buildMultiCurrencyDetails(100, 'EUR', 1.085, 'USD');
      expect(details).toEqual({
        currency: 'EUR',
        currencyCode: 'EUR',
        currencySymbol: '€',
        formattedAmount: '€100.00',
        exchangeRate: 1.085,
        exchangeRateInfo: {
          fromCurrency: 'EUR',
          toCurrency: 'USD',
          rate: 1.085,
        },
      });
    });
  });
});
