import { describe, expect, it } from "vitest";
import { basename, breadcrumbs, dirname, extension, isWindowsPath, joinPath, windowsSafeName } from "../paths";

describe("paths", () => {
  it("detects windows paths", () => {
    expect(isWindowsPath("C:\\Users\\me")).toBe(true);
    expect(isWindowsPath("D:/data")).toBe(true);
    expect(isWindowsPath("/home/me")).toBe(false);
  });
  it("joins with the right separator", () => {
    expect(joinPath("/var/www", "index.html")).toBe("/var/www/index.html");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("C:\\Users", "me")).toBe("C:\\Users\\me");
    expect(joinPath("", "x")).toBe("x");
  });
  it("computes basename and dirname", () => {
    expect(basename("/var/log/syslog")).toBe("syslog");
    expect(basename("C:\\a\\b.txt")).toBe("b.txt");
    expect(dirname("/var/log/syslog")).toBe("/var/log");
    expect(dirname("/var")).toBe("/");
    expect(dirname("C:\\Users\\me")).toBe("C:\\Users");
    expect(dirname("C:\\Users")).toBe("C:\\");
  });
  it("builds breadcrumbs", () => {
    expect(breadcrumbs("/home/deploy")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "deploy", path: "/home/deploy" },
    ]);
    expect(breadcrumbs("C:\\Users\\me").map((b) => b.path)).toEqual(["C:\\", "C:\\Users", "C:\\Users\\me"]);
  });
  it("extracts extensions", () => {
    expect(extension("app.TS")).toBe("ts");
    expect(extension(".bashrc")).toBe("");
    expect(extension("Makefile")).toBe("");
  });
  it("sanitizes names for Windows", () => {
    expect(windowsSafeName("a:b?.txt")).toBe("a_b_.txt");
    expect(windowsSafeName("CON")).toBe("_CON");
    expect(windowsSafeName("nul.txt")).toBe("_nul.txt");
    expect(windowsSafeName("trail. ")).toBe("trail__");
    expect(windowsSafeName("")).toBe("_");
  });
});
