/**
 * Cheap, dependency-free detection of code/data availability for a paper,
 * derived from the abstract text and the paper's own links. No API call, no
 * storage: it runs on whatever the card already has, so it works on every
 * existing paper immediately. Patterns are high-precision (specific hosts and
 * accession formats) to avoid false "has code/data" badges on normal prose.
 */

export type CodeDataHit = { kind: 'code' | 'data'; label: string; url?: string };

const CODE_HOSTS: { re: RegExp; label: string }[] = [
  { re: /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:[/#?][^\s)>\]]*)?/i, label: 'GitHub' },
  { re: /https?:\/\/(?:www\.)?gitlab\.com\/[\w.-]+\/[\w.-]+/i, label: 'GitLab' },
  { re: /https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+/i, label: 'Bitbucket' },
  { re: /https?:\/\/codeberg\.org\/[\w.-]+\/[\w.-]+/i, label: 'Codeberg' },
];

const DATA_HOSTS: { re: RegExp; label: string }[] = [
  { re: /https?:\/\/(?:www\.)?zenodo\.org\/[^\s)>\]]+/i, label: 'Zenodo' },
  { re: /https?:\/\/osf\.io\/[\w]+/i, label: 'OSF' },
  { re: /https?:\/\/(?:www\.)?figshare\.com\/[^\s)>\]]+/i, label: 'figshare' },
  { re: /https?:\/\/datadryad\.org\/[^\s)>\]]+/i, label: 'Dryad' },
];

const DATA_DOIS: { re: RegExp; label: string }[] = [
  { re: /\b10\.5281\/zenodo\.\d+/i, label: 'Zenodo' },
  { re: /\b10\.5061\/dryad\.[\w.]+/i, label: 'Dryad' },
  { re: /\b10\.6084\/m9\.figshare\.[\w.]+/i, label: 'figshare' },
];

// High-precision repository accession formats (data deposition).
const ACCESSIONS: { re: RegExp; label: string }[] = [
  { re: /\bGSE\d{3,}\b/, label: 'GEO' },
  { re: /\bPRJ(?:NA|EB|DB)\d+\b/, label: 'BioProject' },
  { re: /\bSR[APRSXZ]\d{4,}\b/, label: 'SRA' },
  { re: /\bE-[A-Z]{4}-\d+\b/, label: 'ArrayExpress' },
  { re: /\bphs\d{6}\b/, label: 'dbGaP' },
  { re: /\bEMPIAR-\d+\b/, label: 'EMPIAR' },
  { re: /\bPXD\d{4,}\b/, label: 'PRIDE' },
];

function cleanUrl(u: string): string {
  return u.replace(/[.,;:)\]]+$/, '');
}

export function detectCodeData(
  text?: string,
  extraUrls: (string | undefined)[] = [],
): { code?: CodeDataHit; data?: CodeDataHit } {
  const hay = [text || '', ...extraUrls.filter(Boolean)].join(' \n ');
  if (!hay.trim()) return {};

  let code: CodeDataHit | undefined;
  for (const h of CODE_HOSTS) {
    const m = hay.match(h.re);
    if (m) { code = { kind: 'code', label: h.label, url: cleanUrl(m[0]) }; break; }
  }

  let data: CodeDataHit | undefined;
  for (const h of DATA_HOSTS) {
    const m = hay.match(h.re);
    if (m) { data = { kind: 'data', label: h.label, url: cleanUrl(m[0]) }; break; }
  }
  if (!data) for (const h of DATA_DOIS) {
    const m = hay.match(h.re);
    if (m) { data = { kind: 'data', label: h.label, url: `https://doi.org/${m[0]}` }; break; }
  }
  if (!data) for (const a of ACCESSIONS) {
    const m = hay.match(a.re);
    if (m) { data = { kind: 'data', label: `${a.label} ${m[0]}` }; break; }
  }

  return { code, data };
}
