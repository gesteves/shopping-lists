// Facts about this browser, for the notification settings (#15).
import { copy } from "@/copy";

/** A short device name from the user agent, for example "iPhone · Safari". */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  const names = copy.devices;
  const device = /iPhone/.test(ua)
    ? names.iphone
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? names.ipad
      : /Android/.test(ua)
        ? names.android
        : /Macintosh|Mac OS X/.test(ua)
          ? names.mac
          : /Windows/.test(ua)
            ? names.windows
            : /Linux|CrOS/.test(ua)
              ? names.linux
              : names.unknown;
  const browser = /Edg\//.test(ua)
    ? names.edge
    : /Firefox\/|FxiOS/.test(ua)
      ? names.firefox
      : /Chrome\/|CriOS/.test(ua)
        ? names.chrome
        : /Safari\//.test(ua)
          ? names.safari
          : null;
  return browser ? names.label(device, browser) : device;
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
