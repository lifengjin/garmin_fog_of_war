// Read-only access to one Google Drive folder, entirely in the browser.
//
// Uses Google Identity Services (token model). The access token lives in
// memory only and expires after about an hour; nothing is stored or sent
// anywhere except Google's own APIs.

import { SUPPORTED } from './parse.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

let token = null;
let tokenExpiry = 0;
let tokenClient = null;
let gisLoading = null;

function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

export function isSignedIn() {
  return !!token && Date.now() < tokenExpiry - 60_000;
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExpiry = 0;
}

// Must be called from a click/tap handler (Google opens a popup).
export async function signIn(clientId) {
  if (!clientId) throw new Error('No Google client ID set. See "Google Drive setup" in the README.');
  await loadGIS();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        token = resp.access_token;
        tokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve();
      },
      error_callback: (err) => reject(new Error(err?.message || err?.type || 'Sign-in was cancelled')),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function api(path, params = {}, asBytes = false) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = null;
    throw new Error('Google sign-in expired. Tap Sync again.');
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignore */ }
    throw new Error(`Google Drive: ${msg}`);
  }
  return asBytes ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Accepts a folder link, a folder ID, or a folder name.
export async function resolveFolder(input) {
  const text = (input || '').trim();
  if (!text) throw new Error('Enter your Drive folder link or name in Settings.');
  const fromLink = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text);
  if (fromLink) return { id: fromLink[1] };
  if (/^[A-Za-z0-9_-]{25,}$/.test(text)) return { id: text };
  const res = await api('/files', {
    q: `mimeType='application/vnd.google-apps.folder' and name='${q(text)}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (!res.files?.length) throw new Error(`No Drive folder named "${text}" was found.`);
  if (res.files.length > 1) throw new Error(`Several folders are named "${text}". Paste the folder's link instead.`);
  return { id: res.files[0].id };
}

// All GPX/KML/KMZ/ZIP files in the folder and its subfolders.
export async function listFiles(folderId, depth = 0, path = '') {
  const out = [];
  let pageToken;
  do {
    const params = {
      q: `'${q(folderId)}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await api('/files', params);
    for (const f of res.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (depth < 6) out.push(...(await listFiles(f.id, depth + 1, `${path}${f.name}/`)));
      } else if (SUPPORTED.test(f.name)) {
        out.push({ ...f, path: path + f.name });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

export function download(fileId) {
  return api(`/files/${encodeURIComponent(fileId)}`, { alt: 'media', supportsAllDrives: 'true' }, true);
}
