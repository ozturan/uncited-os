'use client';

import React from 'react';
import type { Entry } from '@/lib/types';
import { detectCodeData } from '@/lib/paperExtras';
import { type Enrich, doiForEntry, getCachedEnrich, fetchEnrich } from '@/lib/paperEnrich';

function prettyLicense(license: string | null): string | undefined {
  if (!license) return undefined;
  if (license.startsWith('cc-')) return license.toUpperCase().replace(/-/g, ' ');
  return undefined; // publisher-specific labels are noisy; omit
}

const PILL = 'inline-flex items-center px-2 py-0.5 rounded-md whitespace-nowrap';
const pillStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  color: 'var(--color-ink-soft)',
  backgroundColor: 'var(--color-surface)',
};

function Pill({ url, title, children }: { url?: string; title?: string; children: React.ReactNode }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" title={title}
        className={PILL} style={{ ...pillStyle, textDecoration: 'none' }}>
        {children}
      </a>
    );
  }
  return <span className={PILL} style={pillStyle} title={title}>{children}</span>;
}

/** Open-access PDF + topics + code/data signals, shown under an expanded abstract. */
export default function PaperDetailExtras({ entry }: { entry: Entry }) {
  const doi = doiForEntry(entry);
  const [enrich, setEnrich] = React.useState<Enrich | null>(() => getCachedEnrich(doi));

  React.useEffect(() => {
    if (!doi) return;
    const cached = getCachedEnrich(doi);
    if (cached) { setEnrich(cached); return; }
    let alive = true;
    fetchEnrich(doi).then(d => { if (alive) setEnrich(d); });
    return () => { alive = false; };
  }, [doi]);

  const codeData = React.useMemo(
    () => detectCodeData(entry.abstract, [entry.link, entry.pdfLink]),
    [entry.abstract, entry.link, entry.pdfLink],
  );

  const oa = enrich?.oa;
  const isOa = !!oa?.isOa;
  const directPdf = oa?.pdfUrl || null;                 // a real free PDF link
  const oaLanding = isOa ? (oa?.landingUrl || null) : null; // OA but only a landing page
  const licenseLabel = prettyLicense(oa?.license ?? null);
  // Prefer OpenAlex topics; fall back to feed categories so chips show even
  // without a DOI / while the fetch is in flight.
  const topics = (enrich?.topics?.length ? enrich.topics.map(t => t.name) : (entry.categories || [])).slice(0, 4);

  const hasAnything = directPdf || oaLanding || entry.pdfLink || codeData.code || codeData.data || topics.length;
  if (!hasAnything) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2.5 text-xs">
      {directPdf ? (
        <a
          href={directPdf}
          target="_blank"
          rel="noopener noreferrer"
          title={licenseLabel ? `Open access · ${licenseLabel}` : 'Open-access PDF'}
          className={`${PILL} font-medium`}
          style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-accent-text)', textDecoration: 'none' }}
        >
          Free PDF
        </a>
      ) : oaLanding ? (
        <a
          href={oaLanding}
          target="_blank"
          rel="noopener noreferrer"
          title={licenseLabel ? `Open access · ${licenseLabel}` : 'Open access'}
          className={`${PILL} font-medium`}
          style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-accent-text)', textDecoration: 'none' }}
        >
          Open access
        </a>
      ) : entry.pdfLink ? (
        <Pill url={entry.pdfLink}>PDF</Pill>
      ) : null}
      {codeData.code && (
        <Pill url={codeData.code.url} title={`Code available${codeData.code.label ? ` (${codeData.code.label})` : ''}`}>
          Code{codeData.code.label ? ` · ${codeData.code.label}` : ''}
        </Pill>
      )}
      {codeData.data && (
        <Pill url={codeData.data.url} title={`Data available (${codeData.data.label})`}>
          Data · {codeData.data.label}
        </Pill>
      )}
      {topics.map((t, i) => (
        <span key={`${t}-${i}`} className={PILL} style={pillStyle}>{t}</span>
      ))}
    </div>
  );
}
