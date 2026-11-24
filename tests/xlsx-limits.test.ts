import { strToU8, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { readXlsx, XlsxError } from '@/lib/import/xlsx';

const wrap = (sheet: string, shared?: string) =>
  zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), ...(shared ? { 'xl/sharedStrings.xml': strToU8(shared) } : {}) }, { level: 9 });
const time = (name: string, file: Uint8Array) => {
  const t = performance.now();
  let out = 'ok';
  try {
    readXlsx(file);
  } catch (e) {
    out = e instanceof XlsxError ? `rejected: ${e.message}` : `CRASH ${String(e)}`;
  }
  const ms = performance.now() - t;
  
  expect(out.startsWith('CRASH')).toBe(false);
  expect(ms).toBeLessThan(3000);
};
const M = 15 * 1024 * 1024;
// 한도 크기의 최악 입력에서도 읽는 시간이 입력 크기에 비례하는지 확인한다(이벤트 루프를 오래 막지 않는다).
it('한도 크기의 최악 입력도 3초 안에 읽거나 거부한다', () => {
  time('15MB of <c/> in one row', wrap('<worksheet><sheetData><row r="1">' + '<c/>'.repeat(M / 4) + '</row></sheetData></worksheet>'));
  time('15MB of valued cells past column cap', wrap('<worksheet><sheetData><row r="1">' + '<c r="A1" t="s"/>'.repeat(M / 17) + '</row></sheetData></worksheet>'));
  time('15MB of text+tags', wrap('<worksheet><sheetData><row r="1"><c r="A1"><v>' + '1<x/>'.repeat(M / 5) + '</v></c></row></sheetData></worksheet>'));
  time('15MB attrs near-miss', wrap('<worksheet><sheetData><row r="1"><c ' + 'xr="1" '.repeat(M / 7) + '><v>1</v></c></row></sheetData></worksheet>'));
  time('15MB entities', wrap('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>' + '&amp;'.repeat(M / 5) + '</t></is></c></row></sheetData></worksheet>'));
  time('unclosed quote', wrap('<worksheet><sheetData><row r="1"><c r="' + 'a'.repeat(M) + '</row>'));
  time('15MB shared strings', wrap('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>', '<sst>' + '<si><t>ab</t></si>'.repeat(M / 18) + '</sst>'));
  time('17MB sheet (over cap)', wrap('<worksheet>' + ' '.repeat(17 * 1024 * 1024) + '</worksheet>'));
  time('2000 rows x 40 cols legit', wrap('<worksheet><sheetData>' + Array.from({ length: 2001 }, (_, r) => `<row r="${r + 1}">` + Array.from({ length: 40 }, (_, c) => `<c r="${String.fromCharCode(65 + (c % 26))}${r + 1}" t="inlineStr"><is><t>value ${r}-${c}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>'));
});
