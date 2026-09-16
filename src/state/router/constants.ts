export const ZEMPTY = '_';
export const ZARRAYSEP = '~';
export const ZFIELDSEP = '*';
export const ZTRUE = '1';
export const ZFALSE = '0';
export const ZESCAPE = '!';

/**
 * Escape sequences for free text fields. Covers the separators, the delimiters
 * the zipped format uses to build its query string, and `%`, which the bare
 * url parser would otherwise try to decode.
 */
export const ZESCAPES: Record<string, string> = {
  [ZESCAPE]: `${ZESCAPE}s`,
  [ZFIELDSEP]: `${ZESCAPE}f`,
  [ZARRAYSEP]: `${ZESCAPE}a`,
  ['&']: `${ZESCAPE}n`,
  ['=']: `${ZESCAPE}e`,
  ['%']: `${ZESCAPE}p`,
};
