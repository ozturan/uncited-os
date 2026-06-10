'use client';

import React, { useRef, useEffect, useState } from 'react';
import { Entry } from '@/lib/types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar as faStarSolid, faInbox } from '@fortawesome/free-solid-svg-icons';
import { faStar as faStarRegular } from '@fortawesome/free-regular-svg-icons';

interface SwipeableArticleCardProps {
  entry: Entry;
  isMobile: boolean;
  children: React.ReactNode;
  index: number;
  selectedIndex: number;
  mainFilter?: 'unread' | 'archive' | 'starred' | 'foryou' | 'discover';
  showSwipeIndicators?: boolean;
  swipeRightAction?: 'archive' | 'star';
  onSwipeRight: (entryId: string, canonicalId?: string) => void;
  onSwipeLeft: (entryId: string, canonicalId?: string) => void;
}

const SWIPE_THRESHOLD = 80;
const DIRECTION_LOCK_THRESHOLD = 10;
const CARD_ANIMATE_MS = 250;
const CONTAINER_COLLAPSE_MS = 200;

function SwipeableArticleCard({
  entry,
  isMobile,
  children,
  index,
  selectedIndex,
  mainFilter = 'unread',
  showSwipeIndicators = true,
  swipeRightAction = 'archive',
  onSwipeRight,
  onSwipeLeft
}: SwipeableArticleCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const leftIndicatorRef = useRef<HTMLDivElement>(null);
  const rightIndicatorRef = useRef<HTMLDivElement>(null);
  const leftCircleRef = useRef<HTMLDivElement>(null);
  const rightCircleRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Touch state refs (no re-renders during gesture)
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const isHorizontalRef = useRef<boolean | null>(null);
  const hasTriggeredRef = useRef(false);
  const hasVibratedRef = useRef(false);

  // Stable refs for callbacks (so native event listeners always see latest)
  const onSwipeRightRef = useRef(onSwipeRight);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const entryIdRef = useRef(entry.id);
  onSwipeRightRef.current = onSwipeRight;
  onSwipeLeftRef.current = onSwipeLeft;
  entryIdRef.current = entry.id;

  // Swipe hint: shown once ever on the first card on mobile
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!isMobile || index !== 0) return;
    try {
      if (localStorage.getItem('uncited_swipe_hint_shown')) return;
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      setShowHint(true);
      // Mark as shown immediately so it won't appear again even if the card re-mounts
      try { localStorage.setItem('uncited_swipe_hint_shown', '1'); } catch { /* ignore */ }
      // Fade out after the animation finishes (animation runs for ~1.4s)
      setTimeout(() => setShowHint(false), 2000);
    }, 1000);
    return () => clearTimeout(timer);
  }, [isMobile, index]);

  // Use native DOM event listeners for touch handling
  // This allows us to use { passive: false } to call preventDefault()
  // which prevents scroll during horizontal swipe gestures
  useEffect(() => {
    if (!isMobile) return;
    const card = cardRef.current;
    if (!card) return;

    const onTouchStart = (e: TouchEvent) => {
      if (hasTriggeredRef.current) return;

      const touch = e.touches[0];
      startXRef.current = touch.clientX;
      startYRef.current = touch.clientY;
      currentXRef.current = 0;
      isHorizontalRef.current = null;
      hasVibratedRef.current = false;

      // Remove transition during drag for instant response
      card.style.transition = 'none';
    };

    const onTouchMove = (e: TouchEvent) => {
      if (hasTriggeredRef.current) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaY = touch.clientY - startYRef.current;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Determine direction after threshold
      if (isHorizontalRef.current === null && (absX > DIRECTION_LOCK_THRESHOLD || absY > DIRECTION_LOCK_THRESHOLD)) {
        isHorizontalRef.current = absX > absY;
      }

      // If vertical gesture, let browser scroll
      if (isHorizontalRef.current === false) {
        return;
      }

      // Horizontal gesture: prevent scroll and handle swipe
      if (isHorizontalRef.current === true) {
        e.preventDefault(); // This works because listener is { passive: false }

        currentXRef.current = deltaX;

        // Apply transform with elastic resistance
        const resistance = 0.8;
        const resistedDeltaX = deltaX * resistance;
        const rotation = resistedDeltaX * 0.02;
        card.style.transform = `translateX(${resistedDeltaX}px) rotate(${rotation}deg)`;

        // Update indicator opacity
        const progress = Math.min(absX / SWIPE_THRESHOLD, 1);
        const bgOpacityPercent = progress * 25;

        if (leftIndicatorRef.current) {
          leftIndicatorRef.current.style.opacity = deltaX > 0 ? String(progress) : '0';
        }
        if (leftCircleRef.current && deltaX > 0) {
          leftCircleRef.current.style.backgroundColor = `color-mix(in srgb, var(--color-accent) ${bgOpacityPercent}%, transparent)`;
        }

        if (rightIndicatorRef.current) {
          rightIndicatorRef.current.style.opacity = deltaX < 0 ? String(progress) : '0';
        }
        if (rightCircleRef.current && deltaX < 0) {
          rightCircleRef.current.style.backgroundColor = `color-mix(in srgb, var(--color-accent) ${bgOpacityPercent}%, transparent)`;
        }

        // Haptic feedback at threshold
        if (absX > SWIPE_THRESHOLD && !hasVibratedRef.current) {
          if ('vibrate' in navigator) {
            navigator.vibrate(10);
          }
          hasVibratedRef.current = true;
        } else if (absX < SWIPE_THRESHOLD && hasVibratedRef.current) {
          hasVibratedRef.current = false;
        }
      }
    };

    const onTouchEnd = () => {
      if (hasTriggeredRef.current) return;

      const deltaX = currentXRef.current;
      const absX = Math.abs(deltaX);

      if (isHorizontalRef.current === true && absX > SWIPE_THRESHOLD) {
        hasTriggeredRef.current = true;

        // Animate card off screen
        const direction = deltaX > 0 ? 1 : -1;
        card.style.transition = `transform ${CARD_ANIMATE_MS}ms ease-out, opacity ${CARD_ANIMATE_MS}ms ease-out`;
        card.style.transform = `translateX(${direction * window.innerWidth}px) rotate(${direction * 12}deg)`;
        card.style.opacity = '0';

        // Fire callback immediately so the next card is swipeable right away.
        // The virtualizer will re-render and remove this item from the list.
        const callback = deltaX > 0 ? onSwipeRightRef.current : onSwipeLeftRef.current;
        callback(entryIdRef.current);
      } else {
        // Snap back to center
        card.style.transition = 'transform 200ms ease-out';
        card.style.transform = 'translateX(0) rotate(0deg)';

        if (leftIndicatorRef.current) {
          leftIndicatorRef.current.style.opacity = '0';
        }
        if (leftCircleRef.current) {
          leftCircleRef.current.style.backgroundColor = 'transparent';
        }
        if (rightIndicatorRef.current) {
          rightIndicatorRef.current.style.opacity = '0';
        }
        if (rightCircleRef.current) {
          rightCircleRef.current.style.backgroundColor = 'transparent';
        }
      }

      isHorizontalRef.current = null;
    };

    // Attach with { passive: false } so we can preventDefault on touchmove
    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchmove', onTouchMove, { passive: false });
    card.addEventListener('touchend', onTouchEnd, { passive: true });
    card.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      card.removeEventListener('touchstart', onTouchStart);
      card.removeEventListener('touchmove', onTouchMove);
      card.removeEventListener('touchend', onTouchEnd);
      card.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isMobile]);

  if (!isMobile) {
    return (
      <article
        data-article-index={index}
        className="article-card flex flex-col md:flex-row gap-2 md:gap-4 p-2 md:p-4"
        style={{
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          transition: 'background-color 0.15s ease'
        }}
      >
        {children}
      </article>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        overflow: 'visible',
        borderRadius: '6px',
        backgroundColor: 'var(--color-bg)',
        // Skip layout/paint/style of cards that aren't near the
        // viewport. Browser treats each card as a "rendering boundary"
        // and doesn't process offscreen subtrees. `contain-intrinsic-size`
        // gives the browser a size hint so the scrollbar stays stable.
        // Net effect: ~80% of the benefit of react-window with zero
        // new deps and zero code restructuring.
        contentVisibility: 'auto',
        containIntrinsicSize: '1px 260px',
      }}
    >
      {/* Background indicators */}
      {showSwipeIndicators && (
        <>
          {/* LEFT INDICATOR - appears when swiping RIGHT */}
          <div
            ref={leftIndicatorRef}
            className="absolute left-0 top-0 bottom-0 w-24 flex items-center justify-center z-0 pointer-events-none"
            style={{ opacity: 0, transition: 'opacity 80ms ease-out' }}
          >
            <div
              ref={leftCircleRef}
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{
                backgroundColor: 'transparent',
                border: '2px solid var(--color-border)',
                transition: 'background-color 80ms ease-out'
              }}
            >
              {swipeRightAction === 'archive' ? (
                <FontAwesomeIcon icon={faInbox} className="w-7 h-7" style={{ color: 'var(--color-accent)' }} />
              ) : (
                <FontAwesomeIcon icon={faStarSolid} className="w-7 h-7" style={{ color: 'var(--color-accent)' }} />
              )}
            </div>
          </div>

          {/* RIGHT INDICATOR - appears when swiping LEFT */}
          <div
            ref={rightIndicatorRef}
            className="absolute right-0 top-0 bottom-0 w-24 flex items-center justify-center z-0 pointer-events-none"
            style={{ opacity: 0, transition: 'opacity 80ms ease-out' }}
          >
            <div
              ref={rightCircleRef}
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{
                backgroundColor: 'transparent',
                border: '2px solid var(--color-border)',
                transition: 'background-color 80ms ease-out'
              }}
            >
              {swipeRightAction === 'archive' ? (
                <FontAwesomeIcon
                  icon={mainFilter === 'starred' ? faStarRegular : faStarSolid}
                  className="w-7 h-7"
                  style={{ color: 'var(--color-accent)' }}
                />
              ) : (
                <FontAwesomeIcon icon={faInbox} className="w-7 h-7" style={{ color: 'var(--color-accent)' }} />
              )}
            </div>
          </div>
        </>
      )}

      {/* One-time swipe hint overlay for first card */}
      {showHint && (
        <>
          <style>{`
            @keyframes uncited-swipe-hint {
              0%   { transform: translateX(0);    opacity: 0; }
              15%  { opacity: 1; }
              35%  { transform: translateX(-28px); }
              65%  { transform: translateX(28px);  }
              85%  { opacity: 1; }
              100% { transform: translateX(0);    opacity: 0; }
            }
          `}</style>
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              backgroundColor: 'transparent',
            }}
          >
            <span
              style={{
                color: 'var(--color-ink-soft)',
                fontSize: '13px',
                fontWeight: 500,
                letterSpacing: '0.02em',
                padding: '6px 14px',
                borderRadius: '20px',
                backgroundColor: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                animation: 'uncited-swipe-hint 1.4s ease-in-out forwards',
                whiteSpace: 'nowrap',
              }}
            >
              ← Star&nbsp;&nbsp;&nbsp;Archive →
            </span>
          </div>
        </>
      )}

      <article
        ref={cardRef}
        data-article-index={index}
        className="article-card flex flex-col md:flex-row gap-2 md:gap-4 p-2 md:p-4"
        style={{
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          position: 'relative',
          zIndex: 1,
          touchAction: 'pan-y',
          willChange: 'transform',
          transform: 'translateX(0) rotate(0deg)'
        }}
      >
        {children}
      </article>
    </div>
  );
}

export default SwipeableArticleCard;
