/* ============================================================
   STAYCATION HAVEN PH — ADMIN PASSWORD RESET (owner-only)
   ------------------------------------------------------------
   Replaces the old "Locked out? Reset admin access" link that sat
   on the PUBLIC /admin login page and needed no authentication —
   anyone on the internet could set the admin password to 1234 and
   walk in. (Removed 2026-07-17.)

   This does the same rescue, but it can only run on a machine that
   already holds serviceAccountKey.json — i.e. yours.

   List the admin accounts:
     node tools/reset-admin.js

   Reset one:
     node tools/reset-admin.js "Piaganda" "my-new-password"

   Keeps every user, booking and setting — it only changes that one
   account's password.
   ============================================================ */
"use strict";

const store = require("../lib/store");

const KEY = "shph_users";

(async () => {
  await store.init();

  if (store.status().backend !== "firestore") {
    console.error("⚠️  Not connected to Firestore. Put serviceAccountKey.json in the project root first.");
    process.exit(1);
  }

  // read the LIVE list, not this process's cache
  const users = (await store.readFreshList(KEY)) || [];
  const live = users.filter(u => u && !u.deleted);

  const name = process.argv[2];
  const pw = process.argv[3];

  if (!name || !pw) {
    console.log("Accounts on the server:\n");
    live.forEach(u => {
      console.log("   " + String(u.name).padEnd(14) + (u.admin ? "admin" : "     ") +
        "   password length: " + String(u.password || "").length);
    });
    console.log("\nTo reset one:\n   node tools/reset-admin.js \"<name>\" \"<new password>\"\n");
    process.exit(0);
  }

  const user = live.find(u => String(u.name).toLowerCase() === String(name).toLowerCase());
  if (!user) {
    console.error(`❌ No account named "${name}". Run without arguments to list them.`);
    process.exit(1);
  }
  if (String(pw).length < 8) {
    console.error("❌ Use at least 8 characters — this password is stored in plain text and is\n" +
                  "   currently readable through the open API until server-side auth lands.");
    process.exit(1);
  }

  user.password = String(pw);
  await store.upsertOne(KEY, user);   // atomic per-record write; can't clobber the other users

  // read back so we report what the SERVER actually has, not what we hoped
  const after = ((await store.readFreshList(KEY)) || []).find(u => String(u.id) === String(user.id));
  const ok = after && after.password === String(pw);
  console.log(ok
    ? `✅ Password updated for "${user.name}"${user.admin ? " (admin)" : ""}. Log in at /admin.`
    : `❌ The write did not stick — nothing changed. Try again.`);
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
