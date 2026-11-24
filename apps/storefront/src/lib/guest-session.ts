const GUEST_SESSION_STORAGE_KEY = 'atelier_guest_session_id';

let memoryGuestSessionId: string | null = null;

function generateGuestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `guest-${crypto.randomUUID()}`;
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getExistingGuestSessionId(): string | null {
  if (memoryGuestSessionId) return memoryGuestSessionId;
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(GUEST_SESSION_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      memoryGuestSessionId = stored.trim();
      return memoryGuestSessionId;
    }
  } catch {
    return memoryGuestSessionId;
  }
  return null;
}

export function getOrCreateGuestSessionId(): string {
  const existing = getExistingGuestSessionId();
  if (existing) return existing;

  const created = generateGuestId();
  memoryGuestSessionId = created;

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(GUEST_SESSION_STORAGE_KEY, created);
    } catch {
      // Ignore storage restrictions in private browsing mode
    }
  }
  return created;
}
