// Holds the short-lived LAN PIN session token strictly in memory (never localStorage/sessionStorage)
let inMemoryLanToken = "";

export function setLanSessionToken(token: string): void {
  inMemoryLanToken = token;
}

export function getLanSessionToken(): string {
  return inMemoryLanToken;
}

export function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers = new Headers(extra);
  if (inMemoryLanToken) {
    headers.set("Authorization", `Bearer ${inMemoryLanToken}`);
  }
  return headers;
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

export function withLanTokenUrl(rawUrl: string): string {
  if (!inMemoryLanToken || !rawUrl.startsWith("/api/")) return rawUrl;
  const sep = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${sep}token=${encodeURIComponent(inMemoryLanToken)}`;
}
