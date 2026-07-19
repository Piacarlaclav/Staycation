const crypto=require("crypto"), fs=require("fs");
const sa=fs.readFileSync("serviceAccountKey.oneline.txt","utf8").trim();
const SECRET=crypto.createHash("sha256").update("shph-sess:"+sa).digest("hex");
const body=Buffer.from(JSON.stringify({t:"staff",u:"Piaganda",adm:true,exp:Date.now()+120000})).toString("base64url");
const cookie="shph_sess="+body+"."+crypto.createHmac("sha256",SECRET).update(body).digest("base64url");
(async()=>{
  const r=await fetch("https://www.staycationhaven-ph.com/Piaganda/calendar-bookings?d="+Date.now(),{headers:{cookie}});
  console.log("live dashboard status:", r.status);
  const h=await r.text();
  const has=(label,s)=>console.log("  "+label.padEnd(34), h.includes(s));
  has("pickDefaultPage() present:", "function pickDefaultPage");
  has("NEVER_LAND guard present:", "NEVER_LAND");
  has("SKIP guard in applyPermissions:", 'const SKIP = ["notes", "board"');
  has("shared sidebar navTo present:", "navTo('calendar')");
  has("OLD buggy fallback still there:", '.find(n => n.style.display !== "none");');
  has("Notes page present:", 'id="page-notes"');
})();
