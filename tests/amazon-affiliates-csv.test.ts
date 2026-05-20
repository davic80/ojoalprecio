import { describe, it, expect } from 'vitest';
import { parseAmazonCsv } from '../src/marketplaces/amazon-affiliates/csv-import';

describe('Amazon affiliates CSV parser', () => {
  it('parses the EN earnings report header set', () => {
    const csv = [
      'Date,Tracking ID,Earnings,Currency,Items Ordered,Items Returned',
      '2026-05-20,canidrone-21,12.34,EUR,3,0',
      '2026-05-21,canidrone-21,5.00,EUR,2,1',
    ].join('\n');
    const { rows, errors } = parseAmazonCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      trackingId:   'canidrone-21',
      asin:         '*',
      day:          '2026-05-20',
      earnings:     12.34,
      currency:     'EUR',
      itemsOrdered: 3,
      itemsReturned: 0,
    });
  });

  it('parses the ES locale variant (semicolon delimiter, comma decimals, accents)', () => {
    const csv = [
      'Fecha;Tracking ID;Comisión;Moneda',
      '20/05/2026;canidrone-21;12,34;EUR',
      '21/05/2026;canidrone-21;5,00;EUR',
    ].join('\n');
    const { rows, errors } = parseAmazonCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(2);
    expect(rows[0].day).toBe('2026-05-20');
    expect(rows[0].earnings).toBe(12.34);
  });

  it('captures ASIN when the per-item report has the column', () => {
    const csv = [
      'Date,Tracking ID,ASIN,Earnings,Items Ordered',
      '2026-05-20,canidrone-21,B00ABCD123,5.50,1',
      '2026-05-20,canidrone-21,B00ZZZ999,1.20,1',
    ].join('\n');
    const { rows, errors } = parseAmazonCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(2);
    expect(rows[0].asin).toBe('B00ABCD123');
    expect(rows[1].asin).toBe('B00ZZZ999');
  });

  it('handles the Spanish-style amount format "1.234,56"', () => {
    const csv = [
      'Date,Tracking ID,Earnings',
      '2026-05-20,t1,"1.234,56"',
    ].join('\n');
    const { rows } = parseAmazonCsv(csv);
    expect(rows[0].earnings).toBe(1234.56);
  });

  it('handles the English-style "1,234.56"', () => {
    const csv = [
      'Date,Tracking ID,Earnings',
      '2026-05-20,t1,"1,234.56"',
    ].join('\n');
    const { rows } = parseAmazonCsv(csv);
    expect(rows[0].earnings).toBe(1234.56);
  });

  it('strips €/$ and whitespace from amount cells', () => {
    const csv = [
      'Date,Tracking ID,Earnings',
      '2026-05-20,t1,"€ 12,34"',
    ].join('\n');
    const { rows } = parseAmazonCsv(csv);
    expect(rows[0].earnings).toBe(12.34);
  });

  it('strips BOM from the first header so synonyms still match', () => {
    const csv = '﻿Date,Tracking ID,Earnings\n2026-05-20,t1,1.00';
    const { rows, errors } = parseAmazonCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(1);
  });

  it('skips only rows missing the required date; tracking defaults to "default"', () => {
    const csv = [
      'Date,Tracking ID,Earnings',
      ',canidrone-21,1.00',           // missing date → skipped
      '2026-05-20,,1.00',              // missing tracking → goes through as 'default'
      '2026-05-20,canidrone-21,1.00',  // good
    ].join('\n');
    const { rows, errors } = parseAmazonCsv(csv);
    expect(rows.length).toBe(2);  // 1 missing-date skipped, 2 kept
    expect(errors.length).toBe(1);
    const fallback = rows.find(r => r.trackingId === 'default');
    expect(fallback).toBeDefined();
  });

  it('returns a helpful error when no date column is found', () => {
    const csv = 'foo,bar\nx,y';
    const { rows, errors } = parseAmazonCsv(csv);
    expect(rows.length).toBe(0);
    expect(errors[0]).toMatch(/columna de fecha/);
  });

  it('falls back trackingId to "default" when the column is missing', () => {
    // Amazon "Linked Products" / "Categories" reports omit Tracking ID
    // when the account has a single tracking — every row attributes to the
    // same default tracking.
    const csv = [
      'Date,Category,Product Title,Asin,Clicks,Items Ordered,Total Earnings',
      '2026-05-19,others,others,others,230,13,884.13',
      '2026-05-19,electronics,Sony WH-1000XM5,B09Y2KZP1G,40,2,12.50',
    ].join('\n');
    const { rows, errors } = parseAmazonCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(2);
    // The aggregate "others" row maps to '*' sentinel + default tracking
    expect(rows[0].trackingId).toBe('default');
    expect(rows[0].asin).toBe('*');
    expect(rows[0].clicks).toBe(230);
    expect(rows[0].itemsOrdered).toBe(13);
    expect(rows[0].earnings).toBe(884.13);
    // The real ASIN row goes through unchanged with default tracking
    expect(rows[1].trackingId).toBe('default');
    expect(rows[1].asin).toBe('B09Y2KZP1G');
    expect(rows[1].earnings).toBe(12.5);
  });

  it('handles negative earnings (returns/adjustments)', () => {
    const csv = [
      'Date,Tracking ID,Earnings',
      '2026-05-20,t1,"-3,50"',
    ].join('\n');
    const { rows } = parseAmazonCsv(csv);
    expect(rows[0].earnings).toBe(-3.5);
  });
});
