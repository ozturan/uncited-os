'use client';

import { useState, useEffect, useRef } from 'react';
import { Entry } from '@/lib/types';
import { generateThumbnail } from '@/lib/paperUtils';
import { thumbPublicUrl } from '@/lib/thumbKey';

interface PaperThumbnailProps {
    entry: Entry;
    width?: number;
    height?: number;
}

// Deterministic public URL of this paper's stored thumbnail — either the
// rendered page-1 image (scripts/render-thumbnails.mjs) or a publisher og:image
// cached by /api/thumbnail on a prior view. Any paper with a canonical_id is
// eligible; a 404 falls through to live og:image extraction, then the card.
function renderedThumbUrl(entry: Entry): string | null {
    const cid = entry.canonicalId;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!cid || !base) return null;
    return thumbPublicUrl(cid, base);
}

function probeImage(url: string, timeoutMs = 10000): Promise<boolean> {
    return new Promise(resolve => {
        const img = new Image();
        const t = setTimeout(() => { img.src = ''; resolve(false); }, timeoutMs);
        img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 1 && img.naturalHeight > 1); };
        img.onerror = () => { clearTimeout(t); resolve(false); };
        img.src = url;
    });
}

export default function PaperThumbnail({ entry, width = 240, height = 135 }: PaperThumbnailProps) {
    const fallbackSrc = generateThumbnail(entry);
    const [imageSrc, setImageSrc] = useState<string>(fallbackSrc);
    const imgRef = useRef<HTMLImageElement>(null);

    useEffect(() => {
        let cancelled = false;
        const newFallback = generateThumbnail(entry);
        setImageSrc(newFallback);

        const renderedUrl = renderedThumbUrl(entry);
        // Pass cid so /api/thumbnail can cache the extracted image to the same
        // Storage path, making the next view (any user) a direct bucket hit.
        const ogUrl = entry.link
            ? `/api/thumbnail?url=${encodeURIComponent(entry.link)}&title=${encodeURIComponent(entry.title || '')}${entry.canonicalId ? `&cid=${encodeURIComponent(entry.canonicalId)}` : ''}`
            : null;

        (async () => {
            // 1. Pre-rendered page-1 thumbnail (Supabase Storage) — real "looks
            //    like the paper" image, no per-view publisher fetch.
            if (renderedUrl && await probeImage(renderedUrl)) {
                if (!cancelled) setImageSrc(renderedUrl);
                return;
            }
            if (cancelled) return;
            // 2. Publisher og:image / graphical abstract (live HTML extraction).
            if (ogUrl && await probeImage(ogUrl)) {
                if (!cancelled) setImageSrc(ogUrl);
                return;
            }
            // 3. Generated default already shown.
        })();

        return () => { cancelled = true; };
    }, [entry.canonicalId, entry.link, entry.id, entry.journalId, entry.journal]);

    const handleImgError = () => {
        if (imageSrc !== fallbackSrc) {
            setImageSrc(fallbackSrc);
        }
    };

    return (
        <img
            key={entry.id}
            ref={imgRef}
            src={imageSrc}
            alt=""
            onError={handleImgError}
            style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '6px',
                backgroundColor: 'var(--color-border)',
                display: 'block',
            }}
            loading="lazy"
            decoding="async"
        />
    );
}
