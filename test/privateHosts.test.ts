import { describe, expect, it } from "vitest";
import { isPrivateHost, mayFetchFrom } from "../src/phizziwig/privateHosts";

const host = (url: string) => new URL(url).hostname;

describe("isPrivateHost", () => {
  it("knows the addresses of private networks, also as the URL parser writes them", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://0x7f.1/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.10.10/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd12::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(isPrivateHost(host(url)), url).toBe(true);
    }
    for (const url of [
      "http://172.32.0.1/",
      "http://8.8.8.8/",
      "http://100.128.0.1/",
      "http://[2001:db8::1]/",
      "http://[::ffff:8.8.8.8]/",
    ]) {
      expect(isPrivateHost(host(url)), url).toBe(false);
    }
  });

  it("takes names without a dot and local domains for intranet hosts", () => {
    for (const name of [
      "intranet",
      "localhost",
      "files.localhost",
      "nas.local",
      "wiki.corp.internal",
      "router.lan",
      "printer.home.arpa",
      "intranet.",
    ]) {
      expect(isPrivateHost(name), name).toBe(true);
    }
    for (const name of ["upload.wikimedia.org", "phorge.example.com", "localhost.example.com"]) {
      expect(isPrivateHost(name), name).toBe(false);
    }
  });
});

describe("mayFetchFrom", () => {
  it("fetches from private networks only for a Phorge on one too", () => {
    const intranet = new URL("http://192.168.1.5/screenshot.png");
    expect(mayFetchFrom(intranet, new URL("https://pm.example.com/T1"))).toBe(false);
    expect(mayFetchFrom(intranet, new URL("http://phorge.localhost:8098/T1"))).toBe(true);
    expect(mayFetchFrom(new URL("https://upload.wikimedia.org/a.png"), new URL("https://pm.example.com/T1"))).toBe(
      true,
    );
  });
});
