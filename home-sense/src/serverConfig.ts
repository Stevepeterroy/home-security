/**
 * Server configuration for the Haven Android app.
 *
 * On Android (Capacitor), API calls cannot use relative paths because the app
 * is served from a local file:// origin. This module stores and returns the
 * base URL of the Python backend server running on the local network.
 *
 * On a regular browser (dev / PWA), this returns "" so relative paths work as before.
 */

const STORAGE_KEY = "haven_server_url";

/** Returns true when running inside a Capacitor Android WebView */
export function isAndroid(): boolean {
  return (
    typeof window !== "undefined" &&
    // Capacitor sets this on the window object
    // @ts-expect-error Capacitor global
    (window.Capacitor?.isNativePlatform?.() ||
      // Fallback: android WebView UA
      /Android/i.test(navigator.userAgent))
  );
}

/** Get the stored server URL (e.g. "http://192.168.1.10:8768") */
export function getServerUrl(): string {
  if (!isAndroid()) return "";
  return localStorage.getItem(STORAGE_KEY) || "";
}

/** Save the server URL */
export function setServerUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ""));
}

/** Resolve a path against the configured server URL */
export function resolveUrl(path: string): string {
  const base = getServerUrl();
  if (!base) return path;
  return base + path;
}
