// The client IP for the Better Auth rate limits (#102). A request goes
// through Cloudflare, then the Fly proxy. Cloudflare sets X-Forwarded-For to
// the client IP, and Fly adds the Cloudflare IP. Better Auth reads the
// header from the right and skips the trusted proxies. Thus the result is
// the first IP that is not Cloudflare. A request that does not go through
// Cloudflare gets its own IP from Fly, and a client cannot set it.

/**
 * The Cloudflare IP ranges, from https://www.cloudflare.com/ips/ (2026-11).
 * If Cloudflare adds a range, its requests share one limit until it is here.
 */
export const CLOUDFLARE_IPS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** `advanced.ipAddress` of Better Auth. */
export const IP_ADDRESS_OPTIONS = {
  ipAddressHeaders: ["x-forwarded-for"],
  trustedProxies: CLOUDFLARE_IPS,
};
