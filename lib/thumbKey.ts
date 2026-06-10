/**
 * Deterministic Supabase Storage location for a paper's thumbnail, shared by:
 *  - the card (PaperThumbnail) which loads it,
 *  - /api/thumbnail which caches the extracted publisher og:image into it,
 *  - scripts/render-thumbnails.mjs which writes the rendered page-1 image.
 * All three must derive the SAME path from canonical_id. The path is base64url
 * of the UTF-8 canonical_id, matching Node's Buffer.from(id).toString('base64url').
 */
export const THUMB_BUCKET = 'paper-thumbnails';

export function thumbKey(canonicalId: string): string {
  // Pure Web API path only. Do NOT use Buffer.toString('base64url'): in the
  // browser Next polyfills Buffer but the polyfill lacks the 'base64url'
  // encoding and throws "Unknown encoding: base64url". TextEncoder + btoa works
  // in the browser and in Node 18+, and yields the SAME base64url (no padding)
  // as Node's Buffer.from(id,'utf8').toString('base64url') used by the renderer.
  const bytes = new TextEncoder().encode(canonicalId);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.jpg';
}

export function thumbPublicUrl(canonicalId: string, supabaseUrl: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${THUMB_BUCKET}/${thumbKey(canonicalId)}`;
}
