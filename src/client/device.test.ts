import { describe, expect, it } from "vitest";
import { base64UrlToBytes, deviceLabel, isIos } from "./device";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
  android:
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
};

describe("deviceLabel", () => {
  it("names the device and the browser", () => {
    expect(deviceLabel(UA.iphone)).toBe("iPhone · Safari");
    expect(deviceLabel(UA.ipad, 5)).toBe("iPad · Safari");
    expect(deviceLabel(UA.ipad, 0)).toBe("Mac · Safari");
    expect(deviceLabel(UA.macChrome)).toBe("Mac · Chrome");
    expect(deviceLabel(UA.windowsEdge)).toBe("Windows · Edge");
    expect(deviceLabel(UA.android)).toBe("Android · Chrome");
    expect(deviceLabel("curl/8")).toBe("Device");
  });
});

describe("isIos", () => {
  it("finds an iPhone and an iPad that says it is a Mac", () => {
    expect(isIos(UA.iphone)).toBe(true);
    expect(isIos(UA.ipad, 5)).toBe(true);
    expect(isIos(UA.macChrome)).toBe(false);
  });
});

describe("base64UrlToBytes", () => {
  it("decodes base64url without padding", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});
