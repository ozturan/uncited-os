/**
 * Pure helper that reconciles a UserState's overlapping starred/read arrays.
 *
 * If an article ended up in both `starred` and `read` (e.g. a star happened
 * before the user marked it read, or vice versa), use the timestamps to
 * decide which action wins and drop the other. Same logic for the
 * canonical-id mirrors.
 *
 * No browser dependencies. Safe to call from server components, route
 * handlers, and the browser. Extracted from lib/storage.ts so the
 * server-side prefetch (lib/serverPrefetch.ts) can apply it without
 * pulling in localStorage / supabase-js client code.
 */

import type { UserState } from './types';

export function cleanupState(state: UserState): UserState {
  const cleanedState = { ...state };

  if (!cleanedState.starred) cleanedState.starred = [];
  if (!cleanedState.read) cleanedState.read = [];

  // Items in both starred and read — pick a winner via timestamps.
  const itemsInBoth = cleanedState.starred.filter(id => cleanedState.read.includes(id));

  if (itemsInBoth.length > 0) {
    itemsInBoth.forEach(id => {
      const isInStarred = cleanedState.starred.includes(id);
      const isInRead = cleanedState.read.includes(id);
      if (!isInStarred || !isInRead) return;

      const starredTime = cleanedState.starredTimestamps?.[id]
        ? new Date(cleanedState.starredTimestamps[id]).getTime()
        : 0;
      const readTime = cleanedState.readTimestamps?.[id]
        ? new Date(cleanedState.readTimestamps[id]).getTime()
        : 0;

      if (readTime > starredTime) {
        if (cleanedState.starred.includes(id) && cleanedState.read.includes(id)) {
          cleanedState.starred = cleanedState.starred.filter(starId => starId !== id);
          if (cleanedState.starredTimestamps) delete cleanedState.starredTimestamps[id];
        }
      } else {
        if (cleanedState.starred.includes(id) && cleanedState.read.includes(id)) {
          cleanedState.read = cleanedState.read.filter(readId => readId !== id);
          if (cleanedState.readTimestamps) delete cleanedState.readTimestamps[id];
        }
      }
    });
  }

  if (cleanedState.starredTimestamps) {
    Object.keys(cleanedState.starredTimestamps).forEach(id => {
      if (!cleanedState.starred.includes(id)) {
        delete cleanedState.starredTimestamps![id];
      }
    });
  }
  if (cleanedState.readTimestamps) {
    Object.keys(cleanedState.readTimestamps).forEach(id => {
      if (!cleanedState.read.includes(id)) {
        delete cleanedState.readTimestamps![id];
      }
    });
  }

  // Canonical mirrors — same overlap rule.
  if (cleanedState.starredCanonical || cleanedState.readCanonical) {
    const sc = cleanedState.starredCanonical ?? [];
    const rc = cleanedState.readCanonical ?? [];
    const scSet = new Set(sc);
    const rcSet = new Set(rc);
    const conflicts: string[] = [];
    scSet.forEach(id => { if (rcSet.has(id)) conflicts.push(id); });

    if (conflicts.length > 0) {
      const sTs = cleanedState.starredTimestampsCanonical || {};
      const rTs = cleanedState.readTimestampsCanonical || {};
      for (const id of conflicts) {
        const st = sTs[id] ? new Date(sTs[id]).getTime() : 0;
        const rt = rTs[id] ? new Date(rTs[id]).getTime() : 0;
        if (rt > st) {
          scSet.delete(id);
          if (cleanedState.starredTimestampsCanonical) delete cleanedState.starredTimestampsCanonical[id];
        } else {
          rcSet.delete(id);
          if (cleanedState.readTimestampsCanonical) delete cleanedState.readTimestampsCanonical[id];
        }
      }
      cleanedState.starredCanonical = Array.from(scSet);
      cleanedState.readCanonical = Array.from(rcSet);
    }

    if (cleanedState.starredTimestampsCanonical) {
      const keep = new Set(cleanedState.starredCanonical ?? []);
      Object.keys(cleanedState.starredTimestampsCanonical).forEach(id => {
        if (!keep.has(id)) delete cleanedState.starredTimestampsCanonical![id];
      });
    }
    if (cleanedState.readTimestampsCanonical) {
      const keep = new Set(cleanedState.readCanonical ?? []);
      Object.keys(cleanedState.readTimestampsCanonical).forEach(id => {
        if (!keep.has(id)) delete cleanedState.readTimestampsCanonical![id];
      });
    }
  }

  return cleanedState;
}
