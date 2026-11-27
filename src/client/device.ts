// Facts about this browser, for the notification settings (#15).
import { copy } from "@/copy";

/** A short device name from the user agent, for example "iPhone · Safari". */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|CrOS/.test(ua)
              ? "Linux"
              : copy.devices.unknown;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  return browser ? copy.devices.label(device, browser) : device;
}

/** iPhone and iPad allow push only in an app on the Home Screen. */
export function isIos(ua: string, maxTouchPoints = 0): boolean {
  return (
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  );
}

/** The VAPID public key (base64url) as bytes, for pushManager.subscribe. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
