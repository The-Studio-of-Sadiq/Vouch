import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import type { Group } from '../../../shared/protocol';
import { API_BASE } from './endpoint';

// Invite links look like https://<server>/join/<code>. On a phone with the app
// installed they open the app (Android App Link); anywhere else they open the
// web client, which can sign up and join directly.

const PENDING_KEY = 'secure-chat:pending-invite';
const CODE = /^[A-Za-z0-9_-]{6,64}$/;

export function inviteLink(code: string) {
  return `${API_BASE || location.origin}/join/${code}`;
}

// Accepts a bare code or any link containing /join/<code>.
export function parseInvite(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/join\/([A-Za-z0-9_-]+)/);
  const code = m ? m[1] : s;
  return CODE.test(code) ? code : null;
}

export function savePendingInvite(code: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, code);
  } catch {
    // Storage unavailable; the invite just won't survive a reload.
  }
}

export function takePendingInvite(): string | null {
  try {
    const code = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return code;
  } catch {
    return null;
  }
}

export function peekPendingInvite(): string | null {
  try {
    return sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

// Reads an invite from the page URL (/join/<code> on the web) before the first
// render, so the sign-in screen can already offer account creation.
export function initialInvite(): string | null {
  const fromPath = location.pathname.startsWith('/join/') ? parseInvite(location.pathname) : null;
  if (fromPath) {
    savePendingInvite(fromPath);
    history.replaceState(null, '', '/');
  }
  return fromPath ?? peekPendingInvite();
}

// Calls `onInvite` for the link that launched the native app and for links
// opened while it is running.
export async function watchInvites(onInvite: (code: string) => void) {
  if (!Capacitor.isNativePlatform()) return () => {};
  const launch = await CapApp.getLaunchUrl();
  const fromLaunch = launch?.url ? parseInvite(launch.url) : null;
  if (fromLaunch) {
    savePendingInvite(fromLaunch);
    onInvite(fromLaunch);
  }
  const handle = await CapApp.addListener('appUrlOpen', ({ url }) => {
    const code = parseInvite(url);
    if (code) {
      savePendingInvite(code);
      onInvite(code);
    }
  });
  return () => void handle.remove();
}

// Opens the system share sheet where there is one; otherwise copies the link.
export async function shareInvite(group: Group): Promise<'shared' | 'copied' | 'cancelled'> {
  const url = inviteLink(group.inviteCode);
  const text = `Join "${group.name}" on Veil, an end-to-end encrypted group chat:`;
  try {
    if (Capacitor.isNativePlatform()) {
      await Share.share({ title: `Join ${group.name}`, text, url, dialogTitle: 'Invite people' });
      return 'shared';
    }
    if (navigator.share) {
      await navigator.share({ title: `Join ${group.name}`, text, url });
      return 'shared';
    }
  } catch (e) {
    if (/cancel|abort/i.test(String((e as Error)?.message ?? e))) return 'cancelled';
  }
  await navigator.clipboard.writeText(`${text} ${url}`);
  return 'copied';
}
