/** POSIX single-quote for embedding arbitrary paths/ids into a shell command line. */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
