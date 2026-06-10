'use client';

import React, { memo, useState, useEffect, useCallback } from 'react';
import { Entry } from '@/lib/types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar as faStarSolid, faInbox } from '@fortawesome/free-solid-svg-icons';
import { faStar as faStarRegular, faSquare } from '@fortawesome/free-regular-svg-icons';
import { InlineMath, BlockMath } from 'react-katex';
import PaperThumbnail from './PaperThumbnail';
import ArticleActions from './ArticleActions';
import AuthorAffiliation from './AuthorAffiliation';
import PaperDetailExtras from './PaperDetailExtras';
import { isNewSinceLastVisit } from '@/lib/paperUtils';
import { decodeHtmlEntities } from '@/lib/htmlEntities';

interface ArticleCardContentProps {
  entry: Entry;
  isStarred: boolean;
  isRead: boolean;
  showThumbnails: boolean;
  defaultReferenceManager: 'mendeley' | 'zotero' | 'bibtex' | 'endnote';
  lastVisit?: string;
  paperType: string | undefined;
  badgeColor: { bg: string; text: string };
  authorLastName: string | null;
  formattedDate: string;
  logo: string;
  expandedAbstracts: Set<string>;
  setExpandedAbstracts: React.Dispatch<React.SetStateAction<Set<string>>>;
  copiedLinkForId: string | null;
  setCopiedLinkForId: React.Dispatch<React.SetStateAction<string | null>>;
  copiedRefManagerForId: string | null;
  showStarCount?: boolean;
  starCount?: number;
  onJournalClick: (journalId: string) => void;
  disableJournalClick?: boolean;
  onToggleStar: (id: string, canonicalId?: string) => void;
  onToggleRead: (id: string, canonicalId?: string) => void;
}

const ArticleCardContent: React.FC<ArticleCardContentProps> = ({
  entry,
  isStarred,
  isRead,
  showThumbnails,
  defaultReferenceManager,
  lastVisit,
  paperType,
  badgeColor,
  authorLastName,
  formattedDate,
  logo,
  expandedAbstracts,
  setExpandedAbstracts,
  copiedLinkForId,
  setCopiedLinkForId,
  copiedRefManagerForId,
  showStarCount = false,
  starCount = 0,
  onJournalClick,
  disableJournalClick = false,
  onToggleStar,
  onToggleRead
}) => {
  // Local optimistic state for instant visual feedback
  // Parent state update happens via startTransition (deferred), so we toggle locally first
  const [localStarred, setLocalStarred] = useState(isStarred);
  const [localRead, setLocalRead] = useState(isRead);
  // Whether the author/affiliation row currently renders anything, so we don't show a
  // dangling "·" before the date for papers with no author (e.g. editorials/news).
  const [authorHasContent, setAuthorHasContent] = useState<boolean>(!!(authorLastName || entry.affiliation));
  // Sync with parent when it catches up
  useEffect(() => { setLocalStarred(isStarred); }, [isStarred]);
  useEffect(() => { setLocalRead(isRead); }, [isRead]);
  const abstractExpanded = expandedAbstracts.has(entry.id);
  const toggleAbstract = useCallback(() => {
    setExpandedAbstracts(prev => {
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
      return next;
    });
  }, [entry.id, setExpandedAbstracts]);

  // Memoize the text processing functions so they are not recreated on every render
  const renderTitleWithMathAndHTML = React.useMemo(() => {
    return (title: string) => {
      // Remove " | Journal Name" pattern for Science journals
      const isScienceJournal = entry.journal && (
        entry.journal.includes('Science') &&
        (entry.journal === 'Science' ||
          entry.journal === 'Science Advances' ||
          entry.journal === 'Science Signalling' ||
          entry.journal === 'Science Immunology' ||
          entry.journal === 'Science Robotics' ||
          entry.journal === 'Science Translational Medicine')
      );

      let processedTitle = title;

      if (isScienceJournal && title) {
        // Remove trailing " | Journal Name" pattern
        processedTitle = title.replace(/\s*\|\s*Science[^|]*$/, '').trim();
      }

      // Decode HTML entities and remove tags
      const decodeHTML = (html: string) => {
        // Named + numeric + hex entities (incl. &ge;/&le;/Greek the old
        // whitelist missed).
        let decoded = decodeHtmlEntities(html);

        // Fix common typos/encoding issues
        decoded = decoded.replace(/\bCancel Cell\b/gi, 'Cancer Cell');

        return decoded;
      };

      processedTitle = decodeHTML(processedTitle);

      // Remove HTML tags but keep their text content
      processedTitle = processedTitle.replace(/<[^>]+>/g, '');

      // Convert parentheses math notation back to LaTeX $...$ format
      processedTitle = processedTitle.replace(/\(([^\)]+)\)/g, (match, content) => {
        const isMath = /\\[a-zA-Z]+\{?/i.test(content) ||
          /\^{|_\{/.test(content) ||
          /\^[a-z0-9_]|_[a-z0-9_]/.test(content) ||
          /\\leq|\\geq|\\in|\\cup|\\cap|\\subset/.test(content) ||
          /[<>=≤≥]/.test(content) ||
          (/^\w+\s*=\s*\w+/i.test(content) && content.length < 50);
        if (isMath) {
          return `$${content}$`;
        }
        return match;
      });

      // Parse and render with math support
      const parts: (string | React.ReactElement)[] = [];
      let lastIndex = 0;

      // Match display math $$...$$
      const displayMathRegex = /\$\$([^$]+)\$\$/g;
      // Match inline math $...$ (but not $$...$$)
      const inlineMathRegex = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;

      // First, handle display math
      const displayMatches: Array<{ start: number, end: number, content: string }> = [];
      let match: RegExpExecArray | null;
      while ((match = displayMathRegex.exec(processedTitle)) !== null) {
        displayMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          content: match[1]
        });
      }

      // Then, handle inline math
      const inlineMatches: Array<{ start: number, end: number, content: string }> = [];
      inlineMathRegex.lastIndex = 0;
      while ((match = inlineMathRegex.exec(processedTitle)) !== null) {
        const overlaps = displayMatches.some(dm =>
          match!.index < dm.end && match!.index + match![0].length > dm.start
        );
        if (!overlaps) {
          inlineMatches.push({
            start: match.index,
            end: match.index + match[0].length,
            content: match[1]
          });
        }
      }

      // Combine and sort all matches
      const allMatches = [...displayMatches, ...inlineMatches].sort((a, b) => a.start - b.start);

      // Build parts array
      for (const mathMatch of allMatches) {
        if (mathMatch.start > lastIndex) {
          parts.push(processedTitle.substring(lastIndex, mathMatch.start));
        }

        // Add math component
        try {
          if (displayMatches.includes(mathMatch)) {
            parts.push(<BlockMath key={`title-math-${mathMatch.start}`} math={mathMatch.content} />);
          } else {
            parts.push(<InlineMath key={`title-math-${mathMatch.start}`} math={mathMatch.content} />);
          }
        } catch (e) {
          // Fallback to plain text if KaTeX fails
          parts.push(`$${mathMatch.content}$`);
        }

        lastIndex = mathMatch.end;
      }

      if (lastIndex < processedTitle.length) {
        parts.push(processedTitle.substring(lastIndex));
      }

      return parts.length > 0 ? parts : [processedTitle];
    };
  }, [entry.journal]);

  // Function to render text with LaTeX math (memoized)
  const renderAbstractWithMath = React.useMemo(() => {
    return (text: string) => {
      // First, convert parentheses math notation (like (G=(V,E))) back to LaTeX $...$
      // Match patterns like (G=(V,E)) or (m^{1+o(1)}) - math expressions in parentheses
      // This handles cases where LaTeX was converted to parentheses
      const processedText = text.replace(/\(([^\)]+)\)/g, (match, content) => {
        // Check if it looks like math - contains LaTeX syntax or mathematical expressions
        // Look for: LaTeX commands (\text, \leq, etc.), subscripts/superscripts (_, ^),
        // mathematical operators (=, <=, >=, etc.), or structured math patterns
        const isMath = /\\[a-zA-Z]+\{?/i.test(content) || // LaTeX commands
          /\^{|_\{/.test(content) || // Superscripts/subscripts with braces
          /\^[a-z0-9_]|_[a-z0-9_]/.test(content) || // Simple superscripts/subscripts
          /\\leq|\\geq|\\in|\\cup|\\cap|\\subset/.test(content) || // Math symbols
          /[<>=≤≥]/.test(content) || // Comparison operators
          (/^\w+\s*=\s*\w+/i.test(content) && content.length < 50); // Short assignments like G=(V,E)

        if (isMath) {
          return `$${content}$`;
        }
        return match; // Keep original if not math
      });

      const parts: (string | React.ReactElement)[] = [];
      let lastIndex = 0;

      // Match display math $$...$$
      const displayMathRegex = /\$\$([^$]+)\$\$/g;
      // Match inline math $...$ (but not $$...$$)
      const inlineMathRegex = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;

      // First, handle display math
      const displayMatches: Array<{ start: number, end: number, content: string }> = [];
      let match: RegExpExecArray | null;
      while ((match = displayMathRegex.exec(processedText)) !== null) {
        displayMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          content: match[1]
        });
      }

      // Then, handle inline math (avoiding overlaps with display math)
      const inlineMatches: Array<{ start: number, end: number, content: string }> = [];
      inlineMathRegex.lastIndex = 0;
      while ((match = inlineMathRegex.exec(processedText)) !== null) {
        // Check if this inline math overlaps with any display math
        const overlaps = displayMatches.some(dm =>
          match!.index < dm.end && match!.index + match![0].length > dm.start
        );
        if (!overlaps) {
          inlineMatches.push({
            start: match.index,
            end: match.index + match[0].length,
            content: match[1]
          });
        }
      }

      // Combine and sort all matches
      const allMatches = [...displayMatches, ...inlineMatches].sort((a, b) => a.start - b.start);

      // Build parts array
      for (const mathMatch of allMatches) {
        // Add text before math
        if (mathMatch.start > lastIndex) {
          parts.push(processedText.substring(lastIndex, mathMatch.start));
        }

        // Add math component
        try {
          if (displayMatches.includes(mathMatch)) {
            parts.push(<BlockMath key={`math-${mathMatch.start}`} math={mathMatch.content} />);
          } else {
            parts.push(<InlineMath key={`math-${mathMatch.start}`} math={mathMatch.content} />);
          }
        } catch (e) {
          // Fallback to plain text if KaTeX fails
          parts.push(`$${mathMatch.content}$`);
        }

        lastIndex = mathMatch.end;
      }

      // Add remaining text
      if (lastIndex < processedText.length) {
        parts.push(processedText.substring(lastIndex));
      }

      return parts.length > 0 ? parts : [processedText];
    };
  }, []); // Empty dependency array as it only depends on the input string

  // Memoize rendered title components
  const renderedTitle = React.useMemo(() => {
    return renderTitleWithMathAndHTML(entry.title);
  }, [entry.title, renderTitleWithMathAndHTML]);

  // Memoize rendered abstract components if present
  const renderedAbstract = React.useMemo(() => {
    if (!expandedAbstracts.has(entry.id) || !entry.abstract) return null;

    // Decode HTML entities first (named + numeric + hex, incl. &ge;/&le;/Greek
    // that the old whitelist missed and rendered literally).
    let rawAbstract = decodeHtmlEntities(entry.abstract);

    // Normalize sub/sup to Unicode (common chem/protein notation: H<sub>2</sub>O,
    // Ser<sup>325</sup>) then strip any remaining JATS/HTML/MathML element tags. The
    // entity decode above can reconstruct literal tags (&lt;sup&gt; -> <sup>), and
    // legacy/backfilled rows carry raw <jats:*>/<sup>/<italic> markup; without this they
    // render as visible markup (the title path already strips tags). The tag regex is
    // anchored to real element names (a letter must follow < or </), so it never eats
    // inequalities like "p < 0.05 and q > 0.1".
    const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ' };
    const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '(': '₍', ')': '₎' };
    rawAbstract = rawAbstract.replace(/<sup>([^<]{1,16})<\/sup>/gi, (_m: string, t: string) => [...t].map(c => SUP[c] ?? c).join(''));
    rawAbstract = rawAbstract.replace(/<sub>([^<]{1,16})<\/sub>/gi, (_m: string, t: string) => [...t].map(c => SUB[c] ?? c).join(''));
    rawAbstract = rawAbstract.replace(/<\/?[a-z][a-z0-9-]*(?::[a-z0-9-]+)?(?:\s[^>]*)?>/gi, '');

    // Remove arXiv metadata prefix if present
    rawAbstract = rawAbstract.replace(/^arXiv:\d+\.\d+v\d+\s+Announce Type:\s*\w+\s*/i, '');
    rawAbstract = rawAbstract.replace(/^arXiv:\d+\.\d+\s*/i, '');

    // Remove "Abstract:" prefix if present
    rawAbstract = rawAbstract.replace(/^Abstract:\s*/i, '');

    // Strip feed/CMS boilerplate tails some news sources append to the RSS
    // description ("The post X appeared first on Y.", the ScienceAlert subscribe
    // blurb). The backfill removes these at the source; this is the defensive
    // client strip for rows not yet cleaned. Mirrors scripts/lib/abstractClean.mjs.
    // The WP pattern is tightly anchored (sentence start + space after "post" +
    // capitalized publication) so it never eats "post-translational ... appeared
    // first on ..." in a real abstract; the preceding period is preserved.
    rawAbstract = rawAbstract.replace(
      /([.!?]\s|^)\s*The post\s.{1,160}?\sappeared first on\s+[A-Z][^.]{0,50}\.?\s*$/,
      (_m: string, lead: string) => (lead && lead.trim() ? lead.trim() : ''),
    );
    rawAbstract = rawAbstract.replace(/\s*ScienceAlert stories are written,?\s*fact-checked,?\s*and edited by humans,?\s*never generated by AI\.?.*$/i, '');
    rawAbstract = rawAbstract.replace(/\s*Don'?t miss a story,?\s*subscribe here\.?\s*$/i, '');

    // Normalize whitespace - replace multiple spaces with single space (but keep line breaks)
    rawAbstract = rawAbstract.replace(/[ \t]+/g, ' ');
    // Normalize line breaks - ensure proper paragraph spacing
    rawAbstract = rawAbstract.replace(/\n\s*\n\s*\n+/g, '\n\n');
    // Trim leading/trailing whitespace from each line
    rawAbstract = rawAbstract.split('\n').map((line: string) => line.trim()).join('\n');
    rawAbstract = rawAbstract.trim();

    return renderAbstractWithMath(rawAbstract);
  }, [entry.abstract, entry.id, expandedAbstracts, renderAbstractWithMath]);



  return (
    <>
      {/* Thumbnail */}
      {showThumbnails && (
        <div className="flex-shrink-0 relative w-full md:w-[180px] h-[120px]" style={{ borderRadius: '6px', overflow: 'hidden' }}>
          <PaperThumbnail entry={entry} width={180} height={100} />
          {/* Paper Type Badge */}
          <div
            className="absolute top-2 right-2 text-xs px-2.5 py-1 rounded-md"
            style={{
              backgroundColor: badgeColor.bg,
              color: badgeColor.text,
              fontWeight: 500,
              fontSize: '11px',
              letterSpacing: '0.01em'
            }}
          >
            {paperType}
          </div>
          {/* New Since Last Visit Badge */}
          {isNewSinceLastVisit(entry, lastVisit) && (
            <div
              className="absolute top-2 left-2 text-xs px-2.5 py-1 rounded-md flex items-center gap-1"
              style={{
                backgroundColor: 'var(--color-accent)',
                color: 'white',
                fontWeight: 600,
                fontSize: '11px',
                letterSpacing: '0.01em',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
              }}
            >
              <span>NEW</span>
            </div>
          )}
        </div>
      )}
      {/* Content */}
      <div className="flex-1 min-w-0 relative space-y-0.5 md:space-y-3">
        {/* Journal Header with Logo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src={logo}
              alt={entry.journal}
              style={{ width: '20px', height: '20px' }}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            {disableJournalClick ? (
              <span
                className="text-xs uppercase"
                style={{
                  color: 'var(--color-ink-soft)',
                  fontWeight: 500,
                  letterSpacing: '0.05em'
                }}
              >
                {entry.journal.replace(/\bCancel Cell\b/gi, 'Cancer Cell')}
              </span>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onJournalClick(entry.journalId);
                }}
                className="text-xs uppercase transition-colors hover:underline"
                style={{
                  color: 'var(--color-ink-soft)',
                  fontWeight: 500,
                  letterSpacing: '0.05em',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                {entry.journal.replace(/\bCancel Cell\b/gi, 'Cancer Cell')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Paper Type Badge when thumbnails are hidden */}
            {!showThumbnails && (
              <div
                className="text-xs px-2.5 py-1 rounded-md"
                style={{
                  backgroundColor: badgeColor.bg,
                  color: badgeColor.text,
                  fontWeight: 500,
                  fontSize: '11px',
                  letterSpacing: '0.01em'
                }}
              >
                {paperType}
              </div>
            )}
            {/* Star count display */}
            {showStarCount && (
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                <FontAwesomeIcon icon={faStarSolid} className="w-4 h-4" style={{ color: 'var(--color-accent)' }} aria-hidden />
                <span>{starCount}</span>
              </div>
            )}
            {/* Archive/Unarchive Button */}
            {!localRead ? (
              <button
                onClick={() => {
                  if (typeof window !== 'undefined' && 'vibrate' in navigator) {
                    navigator.vibrate(10);
                  }
                  setLocalRead(true);
                  setLocalStarred(false);
                  onToggleRead(entry.id, entry.canonicalId);
                }}
                className="btn-icon"
                title="Mark as Read"
              >
                <FontAwesomeIcon icon={faSquare} className="w-8 h-8" aria-hidden />
              </button>
            ) : (
              <button
                onClick={() => {
                  if (typeof window !== 'undefined' && 'vibrate' in navigator) {
                    navigator.vibrate(10);
                  }
                  setLocalRead(false);
                  onToggleRead(entry.id, entry.canonicalId);
                }}
                className="btn-icon"
                title="Mark as Unread"
              >
                <FontAwesomeIcon icon={faInbox} className="w-8 h-8" aria-hidden />
              </button>
            )}
            <button
              onClick={() => {
                if (typeof window !== 'undefined' && 'vibrate' in navigator) {
                  navigator.vibrate(10);
                }
                setLocalStarred(!localStarred);
                if (!localStarred) setLocalRead(false);
                onToggleStar(entry.id, entry.canonicalId);
              }}
              className={`btn-icon${localStarred ? ' active' : ''}`}
              title={localStarred ? 'Unstar' : 'Star'}
            >
              <FontAwesomeIcon
                icon={localStarred ? faStarSolid : faStarRegular}
                className="w-8 h-8"
                aria-hidden
              />
            </button>
          </div>
        </div>

        {/* Title */}
        <h3 className="text-xs md:text-sm lg:text-base" style={{
          color: 'var(--color-ink)',
          fontWeight: 400,
          lineHeight: 1.4
        }}>
          <a
            href={entry.link}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            style={{ color: 'inherit' }}
          >
            {renderedTitle}
          </a>
        </h3>

        {/* Authors, Lab, Date & Share Actions */}
        <div className="text-sm flex items-center flex-wrap gap-1" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>
          {/* Author + lab/affiliation entity. AuthorAffiliation owns the whole entity
              (first author · last-author lab · institution) from one resolved source.
              It reports up whether it has content so the date separator is only drawn
              when an author is actually shown — no dangling "·". */}
          {(authorLastName || entry.canonicalId) && (
            <AuthorAffiliation
              key="author-aff"
              canonicalId={entry.canonicalId}
              doi={entry.doi}
              arxivId={entry.arxivId}
              title={entry.title}
              parentAuthorLastName={authorLastName}
              parentAuthorsRaw={entry.authors || null}
              parentPublished={entry.published || null}
              initialData={entry.affiliation ?? null}
              onContent={setAuthorHasContent}
            />
          )}
          {authorHasContent && formattedDate && <span>{' · '}</span>}
          {formattedDate && <span>{formattedDate}</span>}
        </div>

        {/* Actions row: share (copy) · tl;dr · abstract · share-to ▾ (X / Bsky / link / email / ref manager) */}
        <ArticleActions
          entry={entry}
          defaultReferenceManager={defaultReferenceManager}
          abstractExpanded={abstractExpanded}
          onToggleAbstract={toggleAbstract}
          authorLastName={authorLastName}
        />

        {/* Abstract body */}
        {entry.abstract && abstractExpanded && (
          <div className="text-sm leading-relaxed" style={{ color: 'var(--color-ink)', fontWeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {renderedAbstract}
          </div>
        )}

        {/* Open-access PDF · topics · code/data — only in the expanded detail view */}
        {abstractExpanded && <PaperDetailExtras entry={entry} />}
      </div >
    </>
  );
};

// Custom comparison to prevent unnecessary re-renders
// Only re-render if these specific props change
const areEqual = (prevProps: ArticleCardContentProps, nextProps: ArticleCardContentProps) => {
  return (
    prevProps.entry.id === nextProps.entry.id &&
    prevProps.isStarred === nextProps.isStarred &&
    prevProps.isRead === nextProps.isRead &&
    prevProps.expandedAbstracts === nextProps.expandedAbstracts &&
    prevProps.copiedLinkForId === nextProps.copiedLinkForId &&
    prevProps.copiedRefManagerForId === nextProps.copiedRefManagerForId
  );
};

export default memo(ArticleCardContent, areEqual);
