/**
 * The house writing rules, held mechanically over the words a person reads:
 * every string the engine and the widget spell out in src, and the markup,
 * strings and text of the examples. No em or en dash, no arrow, tick or
 * cross character standing in for a word, no emoji, and no "arm" wording in
 * the examples' UI (Live, On, Off and Active say it). 2.5.10 found dashes in
 * page titles, thrown messages and canvas placeholders, arrows in hints, a
 * camera emoji on a button and "Arm trading" on an order gate, none of which
 * any check had looked at. Comments are left alone; identifiers too.
 *
 * A deliberate exception goes in writing-rules-allow.json with its reason.
 */
/// <reference types="vite/client" />
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import allow from './writing-rules-allow.json';

type Sources = Record<string, string>;
type Glob = { glob(pattern: string | string[], options: { query: string; import: string; eager: true }): Sources };
const SRC = (import.meta as unknown as Glob).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const EXAMPLES = (import.meta as unknown as Glob).glob(['../examples/**/*.html', '../examples/**/*.js', '!../examples/**/tests/**'], { query: '?raw', import: 'default', eager: true });

/** Characters that stand in for words: dashes, arrows, ticks and crosses, pictographs. */
// Written by code point, so this file holds none of the characters it forbids:
// the en and em dash, the arrows block, and the tick and cross marks.
const FORBIDDEN = [[0x2013, 0x2014], [0x2190, 0x21ff], [0x2713, 0x2713], [0x2715, 0x2715]]
  .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('');
const SYMBOL = new RegExp(`[${FORBIDDEN}]|&mdash;|&ndash;|&rarr;|&larr;|${/\p{Extended_Pictographic}/u.source}`, 'u');
/** "Arm" in a reader's words; the examples say Live, On, Off or Active. */
const ARM = /\barm(?:ed|ing|s)?\b/i;

interface Finding { file: string; line: number; text: string }

/** String and template literal text in JS or TS source, with the line it starts on. */
function literals(file: string, text: string): { line: number; text: string }[] {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** An HTML page's reader-facing text: its markup outside comments, and its scripts' literals. */
function pageText(file: string, html: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lineAt = (index: number): number => html.slice(0, index).split('\n').length;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  // Scripts go through the parser; comments are blanked so line numbers hold.
  const markup = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (whole, body: string, at: number) => {
    const offset = lineAt(at + whole.indexOf(body)) - 1;
    for (const found of literals(`${file}.js`, body)) out.push({ line: found.line + offset, text: found.text });
    return blank(whole);
  }).replace(/<!--[\s\S]*?-->/g, blank).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank);
  markup.split('\n').forEach((text, index) => { if (text.trim() !== '') out.push({ line: index + 1, text }); });
  return out;
}

const allowed = (file: string, text: string): boolean =>
  (allow as { file: string; text: string; reason: string }[]).some(entry => file.endsWith(entry.file) && text.includes(entry.text));

/** Numeric character references as the characters a reader sees. */
const decoded = (text: string): string => text
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));

function scan(sources: Sources, read: (file: string, text: string) => { line: number; text: string }[], rule: RegExp): Finding[] {
  const found: Finding[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const item of read(file, text)) {
      if (rule.test(decoded(item.text)) && !allowed(file, item.text)) found.push({ file: file.replace(/^\.\.\//, ''), line: item.line, text: item.text.trim().slice(0, 120) });
    }
  }
  return found;
}

const read = (file: string, text: string): { line: number; text: string }[] => (file.endsWith('.html') ? pageText(file, text) : literals(file, text));

describe('the house writing rules', () => {
  it('finds the files it is meant to read', () => {
    expect(Object.keys(SRC).length).toBeGreaterThan(300);
    expect(Object.keys(EXAMPLES).some(file => file.endsWith('examples/yfinance/index.html'))).toBe(true);
    expect(Object.keys(EXAMPLES).some(file => file.includes('/tests/'))).toBe(false);
  });

  it('keeps dashes, arrows, ticks, crosses and emoji out of the strings src spells out', () => {
    expect(scan(SRC, literals, SYMBOL)).toEqual([]);
  });

  it('keeps them out of the examples too', () => {
    expect(scan(EXAMPLES, read, SYMBOL)).toEqual([]);
  });

  it('says Live, On, Off or Active in the examples, never arm', () => {
    expect(scan(EXAMPLES, read, ARM)).toEqual([]);
  });
});
