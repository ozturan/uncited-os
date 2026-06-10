'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Entry, UserState } from '@/lib/types';
import { toggleStar, markRead, markUnread } from '@/lib/storage';
import { exportToReferenceManager } from '@/lib/referenceManager';

export function useKeyboardNav(
  filteredEntries: Entry[],
  state: UserState,
  setState: React.Dispatch<React.SetStateAction<UserState>>,
  displayLimit: number,
  setDisplayLimit: React.Dispatch<React.SetStateAction<number>>,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevSelectedIndexRef = useRef<number>(0);
  const shouldScrollRef = useRef<boolean>(false);
  const handleKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});

  // Auto-expand display limit
  useEffect(() => {
    if (selectedIndex >= displayLimit && selectedIndex < filteredEntries.length) {
      setDisplayLimit(prev => Math.max(prev, selectedIndex + 20));
    }
  }, [selectedIndex, displayLimit, filteredEntries.length, setDisplayLimit]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (filteredEntries.length === 0) return;

    if (e.key === 'j') {
      shouldScrollRef.current = true;
      setSelectedIndex(prev => Math.min(prev + 1, Math.max(0, filteredEntries.length - 1)));
      e.preventDefault();
    } else if (e.key === 'k') {
      shouldScrollRef.current = true;
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      e.preventDefault();
    } else if (e.key === 'a') {
      e.preventDefault();
    } else if (e.key === 's') {
      const entry = filteredEntries[selectedIndex];
      if (entry) {
        const cid = entry.canonicalId;
        setState(prev => {
          const isStarred = prev.starred.includes(entry.id);
          const isRead = prev.read.includes(entry.id);
          const timestamp = new Date().toISOString();
          const newStarredTimestamps = prev.starredTimestamps ? { ...prev.starredTimestamps } : {};
          const newReadTimestamps = prev.readTimestamps ? { ...prev.readTimestamps } : {};
          // Canonical arrays (mirror the legacy mutation so the dual-read
          // matcher and match_papers exclude stay consistent).
          let nextStarredCanonical = prev.starredCanonical;
          let nextStarredTsCanonical = prev.starredTimestampsCanonical;
          let nextReadCanonical = prev.readCanonical;
          let nextReadTsCanonical = prev.readTimestampsCanonical;
          let newState: UserState;
          if (isStarred) {
            delete newStarredTimestamps[entry.id];
            if (cid) {
              nextStarredCanonical = (prev.starredCanonical ?? []).filter(id => id !== cid);
              if (prev.starredTimestampsCanonical) {
                nextStarredTsCanonical = Object.fromEntries(Object.entries(prev.starredTimestampsCanonical).filter(([k]) => k !== cid));
              }
            }
            newState = {
              ...prev,
              starred: prev.starred.filter(id => id !== entry.id),
              starredTimestamps: newStarredTimestamps,
              starredCanonical: nextStarredCanonical,
              starredTimestampsCanonical: nextStarredTsCanonical,
            };
          } else {
            newStarredTimestamps[entry.id] = timestamp;
            const newRead = isRead ? prev.read.filter(id => id !== entry.id) : prev.read;
            if (isRead) delete newReadTimestamps[entry.id];
            if (cid) {
              const existing = new Set(prev.starredCanonical ?? []);
              nextStarredCanonical = existing.has(cid) ? prev.starredCanonical : [...(prev.starredCanonical ?? []), cid];
              nextStarredTsCanonical = { ...(prev.starredTimestampsCanonical ?? {}), [cid]: timestamp };
              nextReadCanonical = (prev.readCanonical ?? []).filter(id => id !== cid);
              if (prev.readTimestampsCanonical) {
                nextReadTsCanonical = Object.fromEntries(Object.entries(prev.readTimestampsCanonical).filter(([k]) => k !== cid));
              }
            }
            newState = {
              ...prev,
              starred: [...prev.starred, entry.id],
              starredTimestamps: newStarredTimestamps,
              read: newRead,
              readTimestamps: newReadTimestamps,
              starredCanonical: nextStarredCanonical,
              starredTimestampsCanonical: nextStarredTsCanonical,
              readCanonical: nextReadCanonical,
              readTimestampsCanonical: nextReadTsCanonical,
            };
          }
          toggleStar(entry.id, newState).catch(console.error);
          return newState;
        });
      }
      e.preventDefault();
    } else if (e.key === 'o') {
      const entry = filteredEntries[selectedIndex];
      if (entry) window.open(entry.pdfLink || entry.link, '_blank');
      e.preventDefault();
    } else if (e.key === 'd') {
      const entry = filteredEntries[selectedIndex];
      if (entry) {
        const cid = entry.canonicalId;
        setState(prev => {
          const isRead = prev.read.includes(entry.id);
          const isStarred = prev.starred.includes(entry.id);
          const timestamp = new Date().toISOString();
          const newReadTimestamps = prev.readTimestamps ? { ...prev.readTimestamps } : {};
          const newStarredTimestamps = prev.starredTimestamps ? { ...prev.starredTimestamps } : {};
          let nextReadCanonical = prev.readCanonical;
          let nextReadTsCanonical = prev.readTimestampsCanonical;
          let nextStarredCanonical = prev.starredCanonical;
          let nextStarredTsCanonical = prev.starredTimestampsCanonical;
          let newState: UserState;
          if (isRead) {
            delete newReadTimestamps[entry.id];
            if (cid) {
              nextReadCanonical = (prev.readCanonical ?? []).filter(id => id !== cid);
              if (prev.readTimestampsCanonical) {
                nextReadTsCanonical = Object.fromEntries(Object.entries(prev.readTimestampsCanonical).filter(([k]) => k !== cid));
              }
            }
            newState = {
              ...prev,
              read: prev.read.filter(id => id !== entry.id),
              readTimestamps: newReadTimestamps,
              readCanonical: nextReadCanonical,
              readTimestampsCanonical: nextReadTsCanonical,
            };
          } else {
            newReadTimestamps[entry.id] = timestamp;
            const newStarred = isStarred ? prev.starred.filter(id => id !== entry.id) : prev.starred;
            if (isStarred) delete newStarredTimestamps[entry.id];
            if (cid) {
              const existing = new Set(prev.readCanonical ?? []);
              nextReadCanonical = existing.has(cid) ? prev.readCanonical : [...(prev.readCanonical ?? []), cid];
              nextReadTsCanonical = { ...(prev.readTimestampsCanonical ?? {}), [cid]: timestamp };
              nextStarredCanonical = (prev.starredCanonical ?? []).filter(id => id !== cid);
              if (prev.starredTimestampsCanonical) {
                nextStarredTsCanonical = Object.fromEntries(Object.entries(prev.starredTimestampsCanonical).filter(([k]) => k !== cid));
              }
            }
            newState = {
              ...prev,
              read: [...prev.read, entry.id],
              readTimestamps: newReadTimestamps,
              starred: newStarred,
              starredTimestamps: newStarredTimestamps,
              readCanonical: nextReadCanonical,
              readTimestampsCanonical: nextReadTsCanonical,
              starredCanonical: nextStarredCanonical,
              starredTimestampsCanonical: nextStarredTsCanonical,
            };
          }
          if (isRead) markUnread(entry.id, newState).catch(console.error);
          else markRead(entry.id, newState).catch(console.error);
          return newState;
        });
      }
      e.preventDefault();
    } else if (e.key === 'e') {
      const entry = filteredEntries[selectedIndex];
      if (entry) {
        const defaultManager = state.settings?.defaultReferenceManager || 'mendeley';
        exportToReferenceManager(entry, defaultManager);
      }
      e.preventDefault();
    }
  }, [filteredEntries, selectedIndex, state.settings?.defaultReferenceManager, setState]);

  handleKeyDownRef.current = handleKeyDown;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => handleKeyDownRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Scroll into view
  useEffect(() => {
    if (filteredEntries.length === 0) return;
    const indexChanged = prevSelectedIndexRef.current !== selectedIndex;
    const shouldScroll = shouldScrollRef.current;
    if (!indexChanged || !shouldScroll) {
      prevSelectedIndexRef.current = selectedIndex;
      shouldScrollRef.current = false;
      return;
    }
    prevSelectedIndexRef.current = selectedIndex;
    shouldScrollRef.current = false;

    requestAnimationFrame(() => {
      const selectedElement = document.querySelector(`[data-article-index="${selectedIndex}"]`) as HTMLElement;
      if (!selectedElement) return;
      let scrollContainer: HTMLElement | null = null;
      let parent = selectedElement.parentElement;
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll' || parent.classList.contains('overflow-y-auto')) {
          scrollContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }
      if (!scrollContainer) scrollContainer = document.querySelector('.flex-1.overflow-y-auto') as HTMLElement;
      if (!scrollContainer) return;
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = selectedElement.getBoundingClientRect();
      const elementTop = elementRect.top - containerRect.top + scrollContainer.scrollTop;
      const elementBottom = elementTop + elementRect.height;
      const containerTop = scrollContainer.scrollTop;
      const containerBottom = scrollContainer.scrollTop + containerRect.height;
      if (!(elementTop >= containerTop && elementBottom <= containerBottom)) {
        scrollContainer.scrollTo({ top: Math.max(0, elementTop - (containerRect.height / 2) + (elementRect.height / 2)), behavior: 'smooth' });
      }
    });
  }, [selectedIndex, filteredEntries.length]);

  // Reset bounds
  useEffect(() => {
    if (filteredEntries.length > 0 && selectedIndex >= filteredEntries.length) {
      setSelectedIndex(0);
    }
  }, [filteredEntries.length, selectedIndex]);

  return { selectedIndex, setSelectedIndex };
}
