/* Password hashing (scrypt, Node built-in — no new dependency).
   Stored format: "scrypt$<salt b64url>$<hash b64url>". verifyPw() also accepts a legacy
   plain-text stored value so nothing breaks mid-migration (tools/reset-admin.js still writes
   plain text; it's upgraded the next time the user list is saved). */
"use strict";
const crypto = require("crypto");

const KEYLEN = 32;

function hashPw(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN);
  return "scrypt$" + salt.toString("base64url") + "$" + hash.toString("base64url");
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

function verifyPw(input, stored) {
  if (stored == null) return false;
  if (!isHashed(stored)) return String(input) === String(stored);   // legacy plain text
  const parts = String(stored).split("$");
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const expect = Buffer.from(parts[2], "base64url");
    const got = crypto.scryptSync(String(input), salt, expect.length || KEYLEN);
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch (e) { return false; }
}

module.exports = { hashPw, verifyPw, isHashed };
