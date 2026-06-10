'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Entry } from '@/lib/types';
import {
    ReferenceManager,
    exportToReferenceManager,
    getReferenceManagerName,
    getReferenceManagerIcon,
} from '@/lib/referenceManager';
import { getOrFetchAffiliation, formatAffiliationForShare } from '@/lib/affiliation';
import { doiForEntry, getCachedEnrich, subscribeEnrich } from '@/lib/paperEnrich';
import { directPdfUrl } from '@/lib/pdfLink';

interface Props {
    entry: Entry;
    defaultReferenceManager: ReferenceManager;
    abstractExpanded: boolean;
    onToggleAbstract: () => void;
    authorLastName: string | null;
}

function renderMarkdown(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
        if (match[1]) parts.push(<strong key={key++}>{match[1]}</strong>);
        else if (match[2]) parts.push(<em key={key++}>{match[2]}</em>);
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts;
}

const btnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: 'var(--color-ink-soft)',
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 400,
    transition: 'color 0.15s ease',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
};

const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: 'var(--color-bg)',
    color: 'var(--color-ink)',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: 13,
    fontWeight: 400,
    textDecoration: 'none',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
};

const IconShareCopy = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);
const IconSparkle = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
        <path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8L16.5 19.5l1.8-.7z" />
    </svg>
);
const IconAbstract = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="17" y1="10" x2="3" y2="10" />
        <line x1="21" y1="6" x2="3" y2="6" />
        <line x1="21" y1="14" x2="3" y2="14" />
        <line x1="17" y1="18" x2="3" y2="18" />
    </svg>
);
const IconShareArrow = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="11.49" />
    </svg>
);
const IconX = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.244 2H21l-6.56 7.49L22 22h-6.828l-5.35-7.02L3.6 22H1l7.06-8.06L2 2h6.828l4.89 6.43L18.244 2zm-2.41 18h2.103L8.27 4H6.06l9.774 16z" />
    </svg>
);
const IconBsky = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 9.5c1.7-3.6 5-6.5 7.5-7.3.9-.3 1.8.6 1.5 1.5-.8 2.5-3.7 5.8-7.3 7.5 3.6 1.7 6.5 5 7.3 7.5.3.9-.6 1.8-1.5 1.5-2.5-.8-5.8-3.7-7.5-7.3-1.7 3.6-5 6.5-7.5 7.3-.9.3-1.8-.6-1.5-1.5.8-2.5 3.7-5.8 7.3-7.5-3.6-1.7-6.5-5-7.3-7.5C2.2 2.8 3.1 1.9 4 2.2 6.5 3 9.8 5.9 11.5 9.5z" />
    </svg>
);
const IconLink = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
);
const IconFile = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
);
const IconPdf = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <path d="M12 18v-6" />
        <path d="m9 15 3 3 3-3" />
    </svg>
);

const ArticleActions: React.FC<Props> = ({
    entry,
    defaultReferenceManager,
    abstractExpanded,
    onToggleAbstract,
    authorLastName,
}) => {
    const [tldr, setTldr] = useState<string>('');
    const [tldrState, setTldrState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
    const [tldrCollapsed, setTldrCollapsed] = useState<boolean>(false);
    const [shareLabel, setShareLabel] = useState<'share' | 'generating…' | 'copied!'>('share');
    const [copyLinkLabel, setCopyLinkLabel] = useState<'copy link' | 'copied!'>('copy link');
    const [refLabel, setRefLabel] = useState<string>(`export to ${getReferenceManagerName(defaultReferenceManager)}`);
    const [menuOpen, setMenuOpen] = useState(false);
    // Screen-space position for the portaled menu (fixed coords from the trigger
    // rect). The menu is rendered into <body> to escape the article card's
    // transform/stacking context — otherwise zIndex can't lift it above the next
    // card (mobile cards are transformed, so each is its own stacking context).
    const [menuPos, setMenuPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
    const menuRef = useRef<HTMLSpanElement | null>(null);
    const menuPanelRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    // Direct-to-PDF link, shown ONLY when we actually have a PDF URL (never a
    // publisher landing page). Two complementary sources: a deterministic
    // per-publisher transform (arXiv/Nature/Springer/bioRxiv/Frontiers/PLOS, no
    // network) and the open-access PDF the visible-card enrich prefetch resolves
    // via Unpaywall (read from the shared cache, never fetched here on render).
    const doi = doiForEntry(entry);
    const patternPdf = entry.pdfLink || directPdfUrl(entry) || null;
    // OA PDF from the DOI->PDF resolver in /api/paper-enrich (Crossref + Unpaywall
    // + OpenAlex, open-access-gated server-side), read from the shared enrich cache.
    const [oaPdf, setOaPdf] = useState<string | null>(() => getCachedEnrich(doi)?.oa?.pdfUrl ?? null);
    useEffect(() => {
        if (!doi || patternPdf) return; // already have a direct link
        const read = () => { const u = getCachedEnrich(doi)?.oa?.pdfUrl; if (u) setOaPdf(u); };
        read();
        return subscribeEnrich(doi, read);
    }, [doi, patternPdf]);
    const pdfUrl = patternPdf || oaPdf || null;

    useEffect(() => {
        if (!menuOpen) { setMenuPos(null); return; }
        // Compute fixed screen coords from the trigger, choosing left/right so the
        // menu stays inside the viewport.
        const place = () => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const menuWidth = 220;
            const vw = window.innerWidth;
            const top = rect.bottom + 6;
            if (rect.left + menuWidth > vw - 8) {
                setMenuPos({ top, right: Math.max(8, vw - rect.right) });
            } else {
                setMenuPos({ top, left: rect.left });
            }
        };
        place();
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node;
            // The menu is portaled out of menuRef, so check the panel ref too —
            // otherwise clicking a menu item reads as "outside" and closes early.
            if (menuRef.current?.contains(t) || menuPanelRef.current?.contains(t)) return;
            setMenuOpen(false);
        };
        // A fixed menu would detach from a scrolling trigger; just close it.
        const onDismiss = () => setMenuOpen(false);
        document.addEventListener('click', onDocClick);
        window.addEventListener('scroll', onDismiss, true);
        window.addEventListener('resize', onDismiss);
        return () => {
            document.removeEventListener('click', onDocClick);
            window.removeEventListener('scroll', onDismiss, true);
            window.removeEventListener('resize', onDismiss);
        };
    }, [menuOpen]);

    const ensureTldr = useCallback(async (): Promise<string> => {
        if (tldr) return tldr;
        if (!entry.canonicalId || !entry.abstract) return '';
        setTldrState('loading');
        try {
            const res = await fetch('/api/tldr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ canonicalId: entry.canonicalId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'failed');
            const t = data.tldr || '';
            setTldr(t);
            setTldrState('done');
            return t;
        } catch {
            setTldrState('error');
            return '';
        }
    }, [tldr, entry.canonicalId, entry.abstract]);

    const handleShareCopy = useCallback(async () => {
        setShareLabel('generating…');
        const [t, aff] = await Promise.all([
            ensureTldr(),
            getOrFetchAffiliation({
                canonicalId: entry.canonicalId,
                doi: entry.doi,
                arxivId: entry.arxivId,
                title: entry.title,
                parentAuthorsRaw: entry.authors || null,
                parentPublished: entry.published || null,
            }),
        ]);
        const authorLine = formatAffiliationForShare(aff, entry.authors || null, authorLastName);
        const lines = [entry.title, authorLine, entry.link].filter(Boolean).join('\n');
        const text = t ? `${lines}\n\nTL;DR: ${t}` : lines;
        try {
            await navigator.clipboard.writeText(text);
            setShareLabel('copied!');
            setTimeout(() => setShareLabel('share'), 1500);
        } catch {
            setShareLabel('share');
        }
    }, [ensureTldr, entry.title, entry.authors, entry.link, entry.canonicalId, entry.doi, entry.arxivId, entry.published, authorLastName]);

    // TL;DR and abstract behave like tabs: opening one closes the other so they
    // never stack. Opening the abstract collapses the TL;DR (effect below);
    // opening/showing the TL;DR collapses the abstract here.
    const handleTldrClick = useCallback(async () => {
        if (tldrState === 'loading') return;
        if (tldrState === 'done') {
            const willShow = tldrCollapsed; // currently collapsed -> about to show
            setTldrCollapsed(!tldrCollapsed);
            if (willShow && abstractExpanded) onToggleAbstract();
            return;
        }
        if (abstractExpanded) onToggleAbstract();
        await ensureTldr();
    }, [ensureTldr, tldrState, tldrCollapsed, abstractExpanded, onToggleAbstract]);

    // Collapse the TL;DR whenever the abstract is opened, so only one shows.
    useEffect(() => {
        if (abstractExpanded) setTldrCollapsed(true);
    }, [abstractExpanded]);

    const handleCopyLink = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(entry.link);
            setCopyLinkLabel('copied!');
            setTimeout(() => setCopyLinkLabel('copy link'), 1500);
        } catch { /* ignore */ }
        setMenuOpen(false);
    }, [entry.link]);

    const handleExportRefManager = useCallback(() => {
        exportToReferenceManager(entry, defaultReferenceManager);
        if (defaultReferenceManager === 'bibtex') {
            setRefLabel('copied!');
            setTimeout(() => setRefLabel(`export to ${getReferenceManagerName(defaultReferenceManager)}`), 1500);
        }
        setMenuOpen(false);
    }, [entry, defaultReferenceManager]);

    const shareText = entry.title;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(entry.link)}`;
    const bskyUrl = `https://bsky.app/intent/compose?text=${encodeURIComponent(`${entry.title} ${entry.link}`)}`;

    return (
        <div className="article-actions">
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 14,
                    marginTop: 4,
                }}
            >
                {pdfUrl && (
                    <a
                        href={pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ ...btnStyle, textDecoration: 'none' }}
                        title="Open the PDF"
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
                    >
                        <IconPdf />
                        <span>pdf</span>
                    </a>
                )}

                <button
                    type="button"
                    onClick={handleShareCopy}
                    style={btnStyle}
                    disabled={shareLabel === 'generating…'}
                    title="Copy title + authors + link + TL;DR"
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
                >
                    <IconShareCopy />
                    <span>{shareLabel}</span>
                </button>

                {entry.abstract && entry.canonicalId && (
                    <button
                        type="button"
                        onClick={handleTldrClick}
                        style={btnStyle}
                        disabled={tldrState === 'loading'}
                        title={tldrState === 'error' ? 'TL;DR unavailable' : tldrState === 'done' ? 'Toggle TL;DR' : 'Generate AI summary'}
                        onMouseEnter={(e) => { if (tldrState !== 'loading') e.currentTarget.style.color = 'var(--color-ink)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
                    >
                        <IconSparkle />
                        <span>
                            {tldrState === 'loading'
                                ? 'generating…'
                                : tldrState === 'error'
                                    ? 'tl;dr unavailable'
                                    : tldrState === 'done'
                                        ? (tldrCollapsed ? 'tl;dr' : 'hide tl;dr')
                                        : 'tl;dr'}
                        </span>
                    </button>
                )}

                {entry.abstract && (
                    <button
                        type="button"
                        onClick={onToggleAbstract}
                        style={btnStyle}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
                    >
                        <IconAbstract />
                        <span>{abstractExpanded ? 'hide abstract' : 'abstract'}</span>
                    </button>
                )}

                <span
                    ref={menuRef}
                    style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
                >
                    <button
                        ref={triggerRef}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
                        style={btnStyle}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
                    >
                        <IconShareArrow />
                        <span>share to ▾</span>
                    </button>
                    {menuOpen && menuPos && typeof document !== 'undefined' && createPortal(
                        <div
                            ref={menuPanelRef}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                position: 'fixed',
                                top: menuPos.top,
                                ...(menuPos.right !== undefined ? { right: menuPos.right } : { left: menuPos.left }),
                                background: 'var(--color-surface)',
                                border: '1px solid var(--color-border)',
                                borderRadius: 6,
                                padding: 6,
                                zIndex: 1000,
                                minWidth: 200,
                                maxWidth: 'calc(100vw - 16px)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                                boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
                            }}
                        >
                            <a
                                href={twitterUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setMenuOpen(false)}
                                style={menuItemStyle}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                            >
                                <IconX />
                                <span>X</span>
                            </a>
                            <a
                                href={bskyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setMenuOpen(false)}
                                style={menuItemStyle}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                            >
                                <IconBsky />
                                <span>Bluesky</span>
                            </a>
                            <button
                                type="button"
                                onClick={handleCopyLink}
                                style={menuItemStyle}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                            >
                                <IconLink />
                                <span>{copyLinkLabel}</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleExportRefManager}
                                style={menuItemStyle}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                                title={`Export to ${getReferenceManagerName(defaultReferenceManager)}`}
                            >
                                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14 }}>
                                    <IconFile />
                                </span>
                                <span>{refLabel}</span>
                                <span style={{ marginLeft: 'auto', fontSize: 14 }}>{getReferenceManagerIcon(defaultReferenceManager)}</span>
                            </button>
                        </div>,
                        document.body,
                    )}
                </span>
            </div>

            {tldrState === 'done' && tldr && !tldrCollapsed && (
                <div
                    className="text-sm leading-relaxed"
                    style={{
                        color: 'var(--color-ink)',
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                        padding: '8px 10px',
                        margin: '6px 0',
                    }}
                >
                    <span
                        style={{
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: 'var(--color-ink-soft)',
                            background: 'var(--color-bg)',
                            padding: '1px 6px',
                            borderRadius: 3,
                            border: '1px solid var(--color-border)',
                            marginRight: 8,
                        }}
                    >
                        TL;DR
                    </span>
                    {renderMarkdown(tldr)}
                </div>
            )}
        </div>
    );
};

export default ArticleActions;
