/**
 * Decode HTML entities that show up in feed titles/abstracts. Scientific text
 * is full of named entities the old whitelist missed — inequalities (&ge; &le;),
 * math operators (&times; &plusmn;), Greek letters, and typography — which
 * rendered literally as "&ge;". This covers the common named entities plus all
 * numeric (&#NNN;) and hex (&#xNN;) forms. Unknown entities are left intact
 * (non-destructive), so it never mangles text like "AT&T".
 *
 * Shared by the title and abstract render paths so both decode identically.
 */

const NAMED_ENTITIES: Record<string, string> = {
  // core
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  // dashes / quotes / typography
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', sdot: '⋅',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  prime: '′', Prime: '″', trade: '™', reg: '®', copy: '©',
  deg: '°', micro: 'µ', para: '¶', sect: '§', dagger: '†', Dagger: '‡',
  // inequalities / math
  ge: '≥', le: '≤', ne: '≠', equiv: '≡', approx: '≈', asymp: '≈', sim: '∼',
  times: '×', divide: '÷', plusmn: '±', minus: '−', frasl: '⁄',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  infin: '∞', radic: '√', prop: '∝', part: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', ang: '∠', perp: '⊥',
  // arrows
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  // set theory
  isin: '∈', notin: '∉', cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', empty: '∅',
  // greek lower
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', sigmaf: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // greek upper
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Theta: 'Θ',
  Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

export function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf('&') === -1) return input;
  return input
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const v = NAMED_ENTITIES[name as string];
      return v !== undefined ? v : m; // leave unknown entities untouched
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    });
}
