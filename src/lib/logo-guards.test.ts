import { describe, expect, it } from "vitest";
import {
  hostResolvesToPublicIp,
  ipv4IsPrivate,
  ipv6IsPrivate,
  isBlockedDomain,
  isValidDomainShape,
  type DohResolver,
} from "./logo-guards";

/** Build a fake DoH resolver that returns fixed IPs per host+type. */
function mockResolver(
  map: Record<string, { A?: string[]; AAAA?: string[] }>,
): DohResolver {
  return async (host, type) => map[host.toLowerCase()]?.[type] ?? [];
}

describe("logo-guards: static blocklist", () => {
  it("rejects IPv4 literals", () => {
    expect(isBlockedDomain("127.0.0.1")).toBe(true);
    expect(isBlockedDomain("169.254.169.254")).toBe(true);
    expect(isBlockedDomain("10.0.0.1")).toBe(true);
    expect(isBlockedDomain("192.168.1.1")).toBe(true);
  });

  it("rejects IPv6 literals", () => {
    expect(isBlockedDomain("::1")).toBe(true);
    expect(isBlockedDomain("fe80::1")).toBe(true);
  });

  it("rejects reserved TLDs and internal names", () => {
    for (const d of [
      "localhost",
      "foo.localhost",
      "server.local",
      "api.internal",
      "host.corp",
      "svc.lan",
      "foo.test",
      "example.invalid",
      "hidden.onion",
    ]) {
      expect(isBlockedDomain(d)).toBe(true);
    }
  });

  it("rejects wildcard-DNS SSRF suffixes", () => {
    for (const d of [
      "127.0.0.1.nip.io",
      "10.0.0.1.sslip.io",
      "192.168.1.1.xip.io",
      "foo.localtest.me",
    ]) {
      expect(isBlockedDomain(d)).toBe(true);
    }
  });

  it("rejects embedded private-range IP labels", () => {
    // Classic rebinding attempt: hostname that shape-checks but contains a
    // private IP as a label.
    expect(isBlockedDomain("169.254.169.254.attacker.com")).toBe(true);
    expect(isBlockedDomain("10.0.0.1.evil.example.co")).toBe(true);
    expect(isBlockedDomain("192.168.1.1.rebind.dev")).toBe(true);
    expect(isBlockedDomain("172.16.0.1.rebind.dev")).toBe(true);
  });

  it("allows normal public domains through the static filter", () => {
    for (const d of ["stripe.com", "www.google.com", "sub.example.org.co"]) {
      expect(isBlockedDomain(d)).toBe(false);
    }
  });

  it("domain-shape validator rejects garbage input", () => {
    expect(isValidDomainShape("not a domain")).toBe(false);
    expect(isValidDomainShape("http://foo.com")).toBe(false);
    expect(isValidDomainShape("foo")).toBe(false);
    expect(isValidDomainShape("stripe.com")).toBe(true);
  });
});

describe("logo-guards: IP classifiers", () => {
  it("marks all reserved IPv4 ranges private", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.5.5",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(ipv4IsPrivate(ip)).toBe(true);
    }
  });

  it("keeps public IPv4 public", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "104.16.132.229", "172.15.0.1", "172.32.0.1"]) {
      expect(ipv4IsPrivate(ip)).toBe(false);
    }
  });

  it("treats malformed IPv4 as unsafe (fail-closed)", () => {
    expect(ipv4IsPrivate("not.an.ip.here")).toBe(true);
    expect(ipv4IsPrivate("999.999.999.999")).toBe(true);
    expect(ipv4IsPrivate("1.2.3")).toBe(true);
  });

  it("marks reserved IPv6 private, including v4-mapped forms", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(ipv6IsPrivate(ip)).toBe(true);
    }
  });

  it("keeps public IPv6 public", () => {
    expect(ipv6IsPrivate("2606:4700:4700::1111")).toBe(false);
    expect(ipv6IsPrivate("2001:4860:4860::8888")).toBe(false);
  });
});

describe("logo-guards: hostResolvesToPublicIp (DNS-rebinding defense)", () => {
  it("rejects a host that resolves to a loopback address", async () => {
    const r = mockResolver({ "rebind.example": { A: ["127.0.0.1"] } });
    expect(await hostResolvesToPublicIp("rebind.example", r)).toBe(false);
  });

  it("rejects a host that resolves to the AWS metadata IP", async () => {
    const r = mockResolver({ "rebind.example": { A: ["169.254.169.254"] } });
    expect(await hostResolvesToPublicIp("rebind.example", r)).toBe(false);
  });

  it("rejects a host resolving to any RFC1918 address", async () => {
    for (const ip of ["10.0.0.5", "172.16.9.9", "192.168.1.10", "100.64.1.1"]) {
      const r = mockResolver({ "priv.example": { A: [ip] } });
      expect(await hostResolvesToPublicIp("priv.example", r)).toBe(false);
    }
  });

  it("rejects mixed answers where ANY IP is private (rebinding split-answer)", async () => {
    // A host that returns both a public and a private address must fail
    // closed: fetch could still connect to the private one.
    const r = mockResolver({
      "mixed.example": { A: ["1.1.1.1", "127.0.0.1"] },
    });
    expect(await hostResolvesToPublicIp("mixed.example", r)).toBe(false);
  });

  it("rejects private IPv6 answers (ULA / link-local / loopback)", async () => {
    for (const ip of ["::1", "fc00::1", "fe80::abcd"]) {
      const r = mockResolver({ "v6.example": { AAAA: [ip] } });
      expect(await hostResolvesToPublicIp("v6.example", r)).toBe(false);
    }
  });

  it("rejects v4-mapped IPv6 pointing at a private v4", async () => {
    const r = mockResolver({ "mapped.example": { AAAA: ["::ffff:10.0.0.1"] } });
    expect(await hostResolvesToPublicIp("mapped.example", r)).toBe(false);
  });

  it("rejects a host with no DNS answers (fail closed)", async () => {
    const r = mockResolver({});
    expect(await hostResolvesToPublicIp("nowhere.example", r)).toBe(false);
  });

  it("allows a fully public IPv4 result", async () => {
    const r = mockResolver({ "public.example": { A: ["1.1.1.1"] } });
    expect(await hostResolvesToPublicIp("public.example", r)).toBe(true);
  });

  it("allows a fully public IPv6 result", async () => {
    const r = mockResolver({ "public6.example": { AAAA: ["2606:4700::1"] } });
    expect(await hostResolvesToPublicIp("public6.example", r)).toBe(true);
  });

  it("short-circuits to allow trusted logo provider hosts without DNS", async () => {
    // Resolver returns nothing on purpose — trusted hosts must not need it.
    const r: DohResolver = async () => {
      throw new Error("resolver should not be called for trusted hosts");
    };
    for (const h of ["img.logo.dev", "logo.clearbit.com", "icons.duckduckgo.com", "www.google.com"]) {
      expect(await hostResolvesToPublicIp(h, r)).toBe(true);
    }
  });
});
