'use client';

import { useCallback, useRef, useEffect } from 'react';
import { UserState } from '@/lib/types';
import { toggleStar, markRead, markUnread, bulkMarkRead } from '@/lib/storage';

export function useArticleActions(
  state: UserState,
  setState: React.Dispatch<React.SetStateAction<UserState>>,
) {
  // Synchronous snapshot of state — needed because React 18+ defers
  // setState updaters to the next batch, so handleArchiveAll cannot
  // read the result of its own setState call to drive the persistence
  // payload. Mirror state into a ref instead.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  // Canonical-aware dual-write: every mutation to state.starred also
  // updates state.starredCanonical when a canonical_id is supplied.
  const updateStarState = useCallback((entryId: string, prevState: UserState, canonicalId?: string) => {
    const isStarred = prevState.starred.includes(entryId);
    if (isStarred) {
      const newStarredTimestamps = { ...prevState.starredTimestamps };
      delete newStarredTimestamps[entryId];
      const newStarredCanonical = canonicalId
        ? (prevState.starredCanonical ?? []).filter(cid => cid !== canonicalId)
        : prevState.starredCanonical;
      const newStarredTsCanonical = canonicalId && prevState.starredTimestampsCanonical
        ? Object.fromEntries(Object.entries(prevState.starredTimestampsCanonical).filter(([k]) => k !== canonicalId))
        : prevState.starredTimestampsCanonical;
      const newState = {
        ...prevState,
        starred: prevState.starred.filter(id => id !== entryId),
        starredTimestamps: newStarredTimestamps,
        starredCanonical: newStarredCanonical,
        starredTimestampsCanonical: newStarredTsCanonical,
      };
      toggleStar(entryId, newState).catch(console.error);
      return newState;
    } else {
      const timestamp = new Date().toISOString();
      const newStarredTimestamps = prevState.starredTimestamps ? { ...prevState.starredTimestamps } : {};
      newStarredTimestamps[entryId] = timestamp;
      const isRead = prevState.read.includes(entryId);
      const newRead = isRead ? prevState.read.filter(id => id !== entryId) : prevState.read;
      const newReadTimestamps = prevState.readTimestamps ? { ...prevState.readTimestamps } : {};
      if (isRead) delete newReadTimestamps[entryId];

      // Canonical arrays: add canonical_id if supplied and not already present,
      // and move canonical_id out of readCanonical if it was there.
      let newStarredCanonical = prevState.starredCanonical;
      let newStarredTsCanonical = prevState.starredTimestampsCanonical;
      let newReadCanonical = prevState.readCanonical;
      let newReadTsCanonical = prevState.readTimestampsCanonical;
      if (canonicalId) {
        const existing = new Set(prevState.starredCanonical ?? []);
        if (!existing.has(canonicalId)) {
          newStarredCanonical = [...(prevState.starredCanonical ?? []), canonicalId];
        }
        newStarredTsCanonical = { ...(prevState.starredTimestampsCanonical ?? {}), [canonicalId]: timestamp };
        newReadCanonical = (prevState.readCanonical ?? []).filter(cid => cid !== canonicalId);
        if (prevState.readTimestampsCanonical) {
          newReadTsCanonical = Object.fromEntries(Object.entries(prevState.readTimestampsCanonical).filter(([k]) => k !== canonicalId));
        }
      }

      const newState = {
        ...prevState,
        starred: [...prevState.starred, entryId],
        starredTimestamps: newStarredTimestamps,
        read: newRead,
        readTimestamps: newReadTimestamps,
        starredCanonical: newStarredCanonical,
        starredTimestampsCanonical: newStarredTsCanonical,
        readCanonical: newReadCanonical,
        readTimestampsCanonical: newReadTsCanonical,
      };
      toggleStar(entryId, newState).catch(console.error);
      return newState;
    }
  }, []);

  // Urgent setState (NOT wrapped in startTransition) so the card's star/read icon
  // flips instantly. The expensive list re-filter consumes useDeferredValue copies
  // of state.read/starred (see page-client), so it stays off the blocking path and
  // CardItem's memo re-renders only the toggled card — instant feedback, no jank.
  const handleToggleStarOptimized = useCallback((entryId: string, canonicalId?: string) => {
    setState(prevState => updateStarState(entryId, prevState, canonicalId));
  }, [updateStarState, setState]);

  const updateReadState = useCallback((entryId: string, prevState: UserState, canonicalId?: string) => {
    const isRead = prevState.read.includes(entryId);
    if (isRead) {
      const newReadTimestamps = { ...prevState.readTimestamps };
      delete newReadTimestamps[entryId];
      let newReadCanonical = prevState.readCanonical;
      let newReadTsCanonical = prevState.readTimestampsCanonical;
      if (canonicalId) {
        newReadCanonical = (prevState.readCanonical ?? []).filter(cid => cid !== canonicalId);
        if (prevState.readTimestampsCanonical) {
          newReadTsCanonical = Object.fromEntries(Object.entries(prevState.readTimestampsCanonical).filter(([k]) => k !== canonicalId));
        }
      }
      const newState = {
        ...prevState,
        read: prevState.read.filter(id => id !== entryId),
        readTimestamps: newReadTimestamps,
        readCanonical: newReadCanonical,
        readTimestampsCanonical: newReadTsCanonical,
      };
      markUnread(entryId, newState).catch(console.error);
      return newState;
    } else {
      const timestamp = new Date().toISOString();
      const isStarred = prevState.starred.includes(entryId);
      const newReadTimestamps = prevState.readTimestamps ? { ...prevState.readTimestamps } : {};
      const newStarredTimestamps = prevState.starredTimestamps ? { ...prevState.starredTimestamps } : {};
      newReadTimestamps[entryId] = timestamp;
      const newStarred = isStarred ? prevState.starred.filter(id => id !== entryId) : prevState.starred;
      if (isStarred) delete newStarredTimestamps[entryId];

      let newReadCanonical = prevState.readCanonical;
      let newReadTsCanonical = prevState.readTimestampsCanonical;
      let newStarredCanonical = prevState.starredCanonical;
      let newStarredTsCanonical = prevState.starredTimestampsCanonical;
      if (canonicalId) {
        const existing = new Set(prevState.readCanonical ?? []);
        if (!existing.has(canonicalId)) {
          newReadCanonical = [...(prevState.readCanonical ?? []), canonicalId];
        }
        newReadTsCanonical = { ...(prevState.readTimestampsCanonical ?? {}), [canonicalId]: timestamp };
        newStarredCanonical = (prevState.starredCanonical ?? []).filter(cid => cid !== canonicalId);
        if (prevState.starredTimestampsCanonical) {
          newStarredTsCanonical = Object.fromEntries(Object.entries(prevState.starredTimestampsCanonical).filter(([k]) => k !== canonicalId));
        }
      }

      const newState = {
        ...prevState,
        read: [...prevState.read, entryId],
        readTimestamps: newReadTimestamps,
        starred: newStarred,
        starredTimestamps: newStarredTimestamps,
        readCanonical: newReadCanonical,
        readTimestampsCanonical: newReadTsCanonical,
        starredCanonical: newStarredCanonical,
        starredTimestampsCanonical: newStarredTsCanonical,
      };
      markRead(entryId, newState).catch(console.error);
      return newState;
    }
  }, []);

  const handleToggleReadOptimized = useCallback((entryId: string, canonicalId?: string) => {
    setState(prevState => updateReadState(entryId, prevState, canonicalId));
  }, [updateReadState, setState]);

  const handleJournalClickStable = useCallback((_journalId: string) => {
    // This is handled externally — keeping for interface compatibility
  }, []);

  const handleSwipeRightStable = useCallback((entryId: string, canonicalId?: string) => {
    setState(prevState => updateReadState(entryId, prevState, canonicalId));
  }, [updateReadState, setState]);

  const handleSwipeLeftStable = useCallback((entryId: string, canonicalId?: string) => {
    setState(prevState => updateStarState(entryId, prevState, canonicalId));
  }, [updateStarState, setState]);

  const handleArchiveAll = useCallback(async (
    mainFilter: string,
    filteredEntries: { id: string; canonicalId?: string }[],
  ) => {
    // Compute synchronously off the ref — React's setState updater is
    // queued, so reading captured-from-updater here would always see null
    // (the bug that made the prior fix a no-op).
    const prev = stateRef.current;
    const prevStarredSet = new Set(prev.starred);
    const prevReadSet = new Set(prev.read);
    const prevStarredCanSet = new Set(prev.starredCanonical ?? []);
    const prevReadCanSet = new Set(prev.readCanonical ?? []);

    let entriesToArchive: { id: string; canonicalId?: string }[] = [];
    if (mainFilter === 'unread') {
      entriesToArchive = filteredEntries.filter(e => {
        const isRead = prevReadSet.has(e.id) || (e.canonicalId ? prevReadCanSet.has(e.canonicalId) : false);
        const isStarred = prevStarredSet.has(e.id) || (e.canonicalId ? prevStarredCanSet.has(e.canonicalId) : false);
        return !isRead && !isStarred;
      });
    } else if (mainFilter === 'starred') {
      entriesToArchive = filteredEntries.filter(e =>
        prevStarredSet.has(e.id) || (e.canonicalId ? prevStarredCanSet.has(e.canonicalId) : false)
      );
    } else return;
    if (entriesToArchive.length === 0) return;

    const timestamp = new Date().toISOString();
    const newReadTimestamps = prev.readTimestamps ? { ...prev.readTimestamps } : {};
    const newStarredTimestamps = prev.starredTimestamps ? { ...prev.starredTimestamps } : {};
    const newReadTsCan = prev.readTimestampsCanonical ? { ...prev.readTimestampsCanonical } : {};
    const newStarredTsCan = prev.starredTimestampsCanonical ? { ...prev.starredTimestampsCanonical } : {};

    const ids = entriesToArchive.map(e => e.id);
    const canIds = entriesToArchive.map(e => e.canonicalId).filter((c): c is string => !!c);
    const idSet = new Set(ids);
    const canIdSet = new Set(canIds);

    ids.forEach(id => { newReadTimestamps[id] = timestamp; });
    canIds.forEach(c => { newReadTsCan[c] = timestamp; });

    let newStarred = prev.starred;
    let newStarredCanonical = prev.starredCanonical ?? [];
    if (mainFilter === 'starred') {
      newStarred = prev.starred.filter(id => !idSet.has(id));
      ids.forEach(id => { delete newStarredTimestamps[id]; });
      newStarredCanonical = (prev.starredCanonical ?? []).filter(c => !canIdSet.has(c));
      canIds.forEach(c => { delete newStarredTsCan[c]; });
    }

    const newState: UserState = {
      ...prev,
      read: [...new Set([...prev.read, ...ids])],
      readTimestamps: newReadTimestamps,
      starred: newStarred,
      starredTimestamps: newStarredTimestamps,
      readCanonical: [...new Set([...(prev.readCanonical ?? []), ...canIds])],
      readTimestampsCanonical: newReadTsCan,
      starredCanonical: newStarredCanonical,
      starredTimestampsCanonical: newStarredTsCan,
    };
    stateRef.current = newState;
    setState(newState);

    // Persist to the reads/stars tables (not just user_state). Without
    // this, the next page load re-hydrates from the reads table and
    // these entries reappear as unread. Awaited so the caller can
    // show "saving…" until the round-trip lands.
    try {
      await bulkMarkRead(ids, mainFilter === 'starred', newState);
    } catch (err) {
      console.error('[handleArchiveAll] bulkMarkRead failed', err);
    }
  }, [setState]);

  return {
    handleToggleStarOptimized, handleToggleReadOptimized,
    handleSwipeRightStable, handleSwipeLeftStable,
    handleArchiveAll,
  };
}
