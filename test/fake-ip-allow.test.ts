import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedAddress } from "../src/permission-extension.ts";

test("198.18.0.0/15 is blocked as a literal IP", () => {
	assert.equal(blockedAddress("198.18.2.11"), true);
	assert.equal(blockedAddress("198.19.255.1"), true);
	assert.equal(blockedAddress("::ffff:198.18.2.11"), true);
});

test("198.18.0.0/15 is allowed when it is a proxy fake-ip DNS answer", () => {
	assert.equal(blockedAddress("198.18.2.11", true), false);
	assert.equal(blockedAddress("198.19.0.5", true), false);
	assert.equal(blockedAddress("::ffff:198.18.2.11", true), false);
});

test("other private ranges stay blocked for DNS answers", () => {
	for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "172.16.0.1", "100.64.0.1", "::1", "fd00::1"])
		assert.equal(blockedAddress(ip, true), true, ip);
	assert.equal(blockedAddress("8.8.8.8", true), false);
});
