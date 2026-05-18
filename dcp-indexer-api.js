const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const Database = require("better-sqlite3");

const DB_PATH = "/opt/dcp-indexer/dcp.db";
const PACK_DIR = "/opt/dcp-indexer/packs";
const START_HEIGHT = Number(process.env.START_HEIGHT || process.argv[2] || 6206000);
const PORT = Number(process.env.PORT || 8099);
const DOGE = 100000000;

fs.mkdirSync(PACK_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  inscription_id TEXT PRIMARY KEY,
  txid TEXT,
  block_height INTEGER,
  block_time INTEGER,
  pack_id TEXT,
  mime TEXT,
  chunk INTEGER,
  total INTEGER,
  data TEXT,
  json TEXT
);

CREATE TABLE IF NOT EXISTS packs (
  pack_id TEXT PRIMARY KEY,
  mime TEXT,
  total INTEGER,
  chunks_found INTEGER DEFAULT 0,
  status TEXT,
  file_path TEXT,
  first_block INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS mints (
  inscription_id TEXT PRIMARY KEY,
  txid TEXT,
  block_height INTEGER,
  block_time INTEGER,
  collection TEXT,
  pack_id TEXT,
  mint_number INTEGER,
  seed TEXT,
  dna TEXT,
  rarity_score INTEGER,
  rarity_rank INTEGER,
  traits_json TEXT,
  owner TEXT,
  render_url TEXT,
  json TEXT,

  genesis_txid TEXT,
  genesis_vout INTEGER,
  genesis_offset INTEGER DEFAULT 0,

  current_txid TEXT,
  current_vout INTEGER,
  current_offset INTEGER DEFAULT 0,
  current_value_sat INTEGER,
  updated_height INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_pack ON chunks(pack_id);
CREATE INDEX IF NOT EXISTS idx_mints_collection ON mints(collection);
CREATE INDEX IF NOT EXISTS idx_mints_pack ON mints(pack_id);
CREATE INDEX IF NOT EXISTS idx_mints_current_location ON mints(current_txid, current_vout);
CREATE INDEX IF NOT EXISTS idx_mints_owner ON mints(owner);
`);

function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

ensureColumn("mints", "genesis_txid", "TEXT");
ensureColumn("mints", "genesis_vout", "INTEGER");
ensureColumn("mints", "genesis_offset", "INTEGER DEFAULT 0");
ensureColumn("mints", "current_txid", "TEXT");
ensureColumn("mints", "current_vout", "INTEGER");
ensureColumn("mints", "current_offset", "INTEGER DEFAULT 0");
ensureColumn("mints", "current_value_sat", "INTEGER");
ensureColumn("mints", "updated_height", "INTEGER");

function cli(cmd) {
  return execSync(`dogecoin-cli ${cmd}`, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 80
  }).trim();
}

function sats(valueDoge) {
  return Math.round(Number(valueDoge) * DOGE);
}

function extractAddress(vout) {
  return (
    vout?.scriptPubKey?.addresses?.[0] ||
    vout?.scriptPubKey?.address ||
    null
  );
}

function getState(key) {
  const row = db.prepare("SELECT value FROM state WHERE key=?").get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  db.prepare(`
    INSERT INTO state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value));
}

function getPrevoutValue(txid, vout) {
  try {
    const prevTx = JSON.parse(cli(`getrawtransaction ${txid} true`));
    const out = prevTx.vout?.[vout];
    if (!out) return 0;
    return sats(out.value);
  } catch {
    return 0;
  }
}

function getInputValues(tx) {
  const values = [];

  for (const vin of tx.vin || []) {
    if (!vin.txid) {
      values.push(0);
      continue;
    }

    values.push(getPrevoutValue(vin.txid, vin.vout));
  }

  return values;
}

function mapSatToOutput(tx, absoluteInputOffset) {
  let cursor = 0;

  for (const out of tx.vout || []) {
    const valueSat = sats(out.value);
    const start = cursor;
    const end = cursor + valueSat;

    if (absoluteInputOffset >= start && absoluteInputOffset < end) {
      return {
        vout: out.n,
        offset: absoluteInputOffset - start,
        owner: extractAddress(out),
        valueSat
      };
    }

    cursor = end;
  }

  return null;
}

function extractDcpJson(scriptHex) {
  if (!scriptHex) return null;

  let buf;
  try {
    buf = Buffer.from(scriptHex, "hex");
  } catch {
    return null;
  }

  const text = buf.toString("utf8");
  const pIndex = text.indexOf('"p"');
  if (pIndex < 0) return null;

  const start = text.lastIndexOf("{", pIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let esc = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (esc) {
      esc = false;
      continue;
    }

    if (ch === "\\") {
      esc = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      try {
        const json = JSON.parse(text.slice(start, i + 1));
        if (json && json.p === "dcp") return json;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function findDcpVin(tx) {
  for (let i = 0; i < (tx.vin || []).length; i++) {
    const hex = tx.vin[i]?.scriptSig?.hex;
    const json = extractDcpJson(hex);
    if (json && json.p === "dcp") {
      return { vinIndex: i, json };
    }
  }

  return null;
}

function txSpendsKnownMint(tx) {
  for (const vin of tx.vin || []) {
    if (!vin.txid) continue;

    const row = db.prepare(`
      SELECT inscription_id
      FROM mints
      WHERE current_txid=?
        AND current_vout=?
      LIMIT 1
    `).get(vin.txid, vin.vout);

    if (row) return true;
  }

  return false;
}

function processDcpMovements(tx, height) {
  if (!txSpendsKnownMint(tx)) return 0;

  const inputValues = getInputValues(tx);
  let moved = 0;

  for (let vinIndex = 0; vinIndex < (tx.vin || []).length; vinIndex++) {
    const vin = tx.vin[vinIndex];
    if (!vin.txid) continue;

    const rows = db.prepare(`
      SELECT *
      FROM mints
      WHERE current_txid=?
        AND current_vout=?
    `).all(vin.txid, vin.vout);

    if (!rows.length) continue;

    const inputBaseOffset = inputValues
      .slice(0, vinIndex)
      .reduce((a, b) => a + b, 0);

    for (const mint of rows) {
      const absolute = inputBaseOffset + Number(mint.current_offset || 0);
      const mapped = mapSatToOutput(tx, absolute);

      if (!mapped) {
        console.log(`WARN could not map DCP ${mint.inscription_id} in tx ${tx.txid}`);
        continue;
      }

      db.prepare(`
        UPDATE mints
        SET
          current_txid=?,
          current_vout=?,
          current_offset=?,
          current_value_sat=?,
          owner=?,
          updated_height=?
        WHERE inscription_id=?
      `).run(
        tx.txid,
        mapped.vout,
        mapped.offset,
        mapped.valueSat,
        mapped.owner,
        height,
        mint.inscription_id
      );

      console.log(
        `MOVE ${mint.inscription_id} -> ${tx.txid}:${mapped.vout}:${mapped.offset} owner=${mapped.owner}`
      );

      moved++;
    }
  }

  return moved;
}

function saveChunk(tx, block, json) {
  const inscriptionId = `${tx.txid}i0`;
  const packId = json.packId;

  db.prepare(`
    INSERT OR IGNORE INTO chunks (
      inscription_id, txid, block_height, block_time,
      pack_id, mime, chunk, total, data, json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    inscriptionId,
    tx.txid,
    block.height,
    block.time,
    packId,
    json.mime || null,
    json.chunk,
    json.total,
    json.data,
    JSON.stringify(json)
  );

  db.prepare(`
    INSERT INTO packs (
      pack_id, mime, total, chunks_found, status, file_path, first_block, updated_at
    ) VALUES (?, ?, ?, 0, 'indexing', NULL, ?, ?)
    ON CONFLICT(pack_id) DO UPDATE SET
      mime=excluded.mime,
      total=excluded.total,
      updated_at=excluded.updated_at
  `).run(packId, json.mime || null, json.total, block.height, Date.now());

  reconstructPack(packId);
}

function reconstructPack(packId) {
  const pack = db.prepare("SELECT * FROM packs WHERE pack_id=?").get(packId);
  if (!pack) return;

  const chunks = db.prepare(`
    SELECT *
    FROM chunks
    WHERE pack_id=?
    ORDER BY chunk ASC
  `).all(packId);

  db.prepare(`
    UPDATE packs
    SET chunks_found=?, updated_at=?
    WHERE pack_id=?
  `).run(chunks.length, Date.now(), packId);

  if (!pack.total || chunks.length < pack.total) return;

  for (let i = 0; i < pack.total; i++) {
    if (!chunks.find(c => c.chunk === i)) return;
  }

  const b64 = chunks.map(c => c.data).join("");

  const ext =
    pack.mime === "text/html" ? "html" :
    pack.mime === "image/svg+xml" ? "svg" :
    pack.mime === "image/png" ? "png" :
    "bin";

  const out = path.join(PACK_DIR, `${packId}.${ext}`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));

  db.prepare(`
    UPDATE packs
    SET status='ready', file_path=?, chunks_found=?, updated_at=?
    WHERE pack_id=?
  `).run(out, chunks.length, Date.now(), packId);

  console.log("Reconstructed pack:", packId, out);
}

function simpleTraits(seed) {
  const T = {
    background:[
      "night","sunset","matrix","doge_gold","purple_void","neon_city","moon","lava","ice","arcade","space","toxic","rainbow","blue_grid","red_alert","gold_vault","forest","castle","lab","ocean",
      "cyber_tunnel","retro_wave","pink_sky","storm","desert","snow","deep_space","doge_temple","void","pixel_city","green_hill","underground","purple_stars","arena","factory","nuclear","dream","heaven","hell","crystal"
    ],
    fur:[
      "cream","gold","brown","dark","black","white","blue","pink","green","zombie","ice","lava","purple","silver","doge","ghost","orange","mint","choco","rainbow",
      "emerald","ruby","sapphire","bronze","steel","toxic","snow","sand","copper","galaxy","shadow","banana","leopard","tiger","pastel","night_blue","fire_red","glow","diamond","pixel_noise"
    ],
    ears:[
      "floppy","long","pointy","round","tiny","robot","bat","shiba","ice","fire","gold","shadow",
      "angel","devil","cyber","broken","radioactive","pixel","big","small","folded","sharp"
    ],
    eyes:[
      "normal","blue","green","laser","heart","sleepy","angry","cyber","matrix","gold","ice","fire","star","dead","alien","cute","purple","rainbow",
      "diamond","glow","spiral","crazy","bloodshot","robot","white","void","pixel","scanner","tv_static","cross","happy","sad","coin","moon","sun"
    ],
    mouth:[
      "smile","neutral","tongue","angry","fangs","open","bone","wow","sad","robot","grin","cigar",
      "pipe","gold_tooth","bloody","drool","monster","tiny","big_smile","evil","stitched","clown"
    ],
    hat:[
      "none","crown","halo","cap","beanie","pirate","samurai","wizard","helmet","horns","top_hat","doge_cap","ice_crown","fire_crown","flower","headphones","visor","bandana",
      "viking","army","cowboy","space_helmet","ninja","king","queen","banana_hat","pixel_hood","pumpkin","cat_ears","skull","gold_halo","diamond_crown","radioactive"
    ],
    clothes:[
      "none","red_hoodie","blue_hoodie","purple_hoodie","armor","cape","doge_shirt","punk_jacket","space_suit","samurai_robe","wizard_robe","gold_chain",
      "diamond_chain","matrix_coat","cyber_armor","winter_jacket","hawaii_shirt","pirate_coat","king_robe","devil_robe","angel_robe","radioactive_suit","ninja_suit","pixel_sweater"
    ],
    effect:[
      "none","stars","sparkles","matrix","fire","ice","coins","hearts","glitch","magic","laser","bubbles","gold_dust","rainbow_aura",
      "lightning","smoke","fog","blood","snowflakes","confetti","pixels","binary","explosion","toxic_aura","purple_fire","green_fire","god_rays","dark_shadow","diamond_shine"
    ],
    frame:[
      "black","purple","gold","neon","doge","ice","fire","matrix","rainbow","arcade","silver","mythic",
      "diamond","shadow","angel","devil","pixel","toxic","glow","retro","cyber","space"
    ]
  };

  function hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let x = hash(seed) || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return ((x >>> 0) % 1e6) / 1e6;
    };
  }

  function pick(arr, r) {
    return arr[Math.floor(r() * arr.length)];
  }

  const r = rng(seed);
  const tr = {};

  Object.keys(T).forEach(k => {
    tr[k] = pick(T[k], r);
  });

  const dna = Object.values(tr).join("-");

  let rarityScore = 0;

  Object.entries(tr).forEach(([k, v]) => {
    const pool = T[k];
    const index = pool.indexOf(v);
    const poolSize = pool.length;
    rarityScore += ((index + 1) / poolSize);
  });

  rarityScore = Math.round(rarityScore * 100);

  return {
    traits: tr,
    dna,
    rarityScore
  };
}

function saveMint(tx, block, json, vinIndex) {
  const inscriptionId = `${tx.txid}i0`;
  const packId = json.pack || json.packId || null;
  const collection = json.collection || null;
  const seed = inscriptionId;
  const derived = simpleTraits(seed);

  const inputValues = getInputValues(tx);

  const absolute = inputValues
    .slice(0, vinIndex)
    .reduce((a, b) => a + b, 0);

  const mapped = mapSatToOutput(tx, absolute);

  if (!mapped) {
    console.log(`WARN could not map DCP mint ${inscriptionId}`);
    return;
  }

  const currentCount = db.prepare(`
    SELECT COUNT(*) AS c
    FROM mints
    WHERE collection=?
  `).get(collection).c;

  const mintNumber = currentCount + 1;

  db.prepare(`
    INSERT OR IGNORE INTO mints (
      inscription_id, txid, block_height, block_time,
      collection, pack_id, mint_number, seed,
      dna, rarity_score, rarity_rank, traits_json,
      owner, render_url, json,

      genesis_txid, genesis_vout, genesis_offset,
      current_txid, current_vout, current_offset,
      current_value_sat, updated_height
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    inscriptionId,
    tx.txid,
    block.height,
    block.time,
    collection,
    packId,
    mintNumber,
    seed,
    derived.dna,
    derived.rarityScore,
    null,
    JSON.stringify(derived.traits),
    mapped.owner,
    `/render/${inscriptionId}`,
    JSON.stringify(json),

    tx.txid,
    mapped.vout,
    mapped.offset,
    tx.txid,
    mapped.vout,
    mapped.offset,
    mapped.valueSat,
    block.height
  );

  recalcRanks(collection);
}

function recalcRanks(collection) {
  if (!collection) return;

  const rows = db.prepare(`
    SELECT inscription_id, rarity_score
    FROM mints
    WHERE collection=?
    ORDER BY rarity_score DESC, mint_number ASC
  `).all(collection);

  const upd = db.prepare(`
    UPDATE mints
    SET rarity_rank=?
    WHERE inscription_id=?
  `);

  rows.forEach((r, i) => {
    upd.run(i + 1, r.inscription_id);
  });
}

function indexBlock(height) {
  const hash = cli(`getblockhash ${height}`);
  const block = JSON.parse(cli(`getblock ${hash} 2`));

  let found = 0;
  let moved = 0;

  for (const tx of block.tx || []) {
    moved += processDcpMovements(tx, height);

    const detected = findDcpVin(tx);
    if (!detected) continue;

    const json = detected.json;

    if (json.op === "pack_chunk" && json.packId) {
      saveChunk(tx, block, json);
      found++;
    }

    if (json.op === "mint") {
      saveMint(tx, block, json, detected.vinIndex);
      found++;
    }
  }

  if (found || moved) {
    console.log("Block", height, "DCP items:", found, "moves:", moved);
  }

  setState("last_height", height);
}

async function runIndexerOnce() {
  const chain = JSON.parse(cli("getblockchaininfo"));
  const tip = chain.blocks;

  const start = Number(getState("last_height") || START_HEIGHT) + 1;

  console.log("Indexing from", start, "to", tip);

  for (let h = start; h <= tip; h++) {
    indexBlock(h);
    if (h % 50 === 0) console.log("Indexed block", h);
  }
}

function formatMint(row) {
  return {
    inscriptionId: row.inscription_id,
    txid: row.txid,
    owner: row.owner,
    collection: row.collection,
    packId: row.pack_id,
    mintNumber: row.mint_number,
    seed: row.seed,
    dna: row.dna,
    rarityScore: row.rarity_score,
    rarityRank: row.rarity_rank,
    traits: JSON.parse(row.traits_json || "{}"),
    renderUrl: row.render_url,
    blockHeight: row.block_height,
    blockTime: row.block_time,

    genesis: {
      txid: row.genesis_txid,
      vout: row.genesis_vout,
      offset: row.genesis_offset
    },

    location: {
      txid: row.current_txid,
      vout: row.current_vout,
      offset: row.current_offset,
      valueSat: row.current_value_sat,
      updatedHeight: row.updated_height
    }
  };
}

async function startApi() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get("/api/packs", async () => {
    return db.prepare(`
      SELECT *
      FROM packs
      ORDER BY updated_at DESC
    `).all();
  });

  app.get("/api/mints", async () => {
    const rows = db.prepare(`
      SELECT *
      FROM mints
      ORDER BY block_height DESC, mint_number DESC
    `).all();

    return rows.map(formatMint);
  });

  app.get("/api/inscription/:id", async (req, reply) => {
    const row = db.prepare(`
      SELECT *
      FROM mints
      WHERE inscription_id=?
    `).get(req.params.id);

    if (!row) {
      return reply.code(404).send({ error: "Inscription not found" });
    }

    return formatMint(row);
  });

  app.get("/api/collections/:name/mints", async (req) => {
    const rows = db.prepare(`
      SELECT *
      FROM mints
      WHERE collection=?
      ORDER BY mint_number ASC
    `).all(req.params.name);

    return rows.map(formatMint);
  });

  app.get("/render/:inscriptionId", async (req, reply) => {
    const mint = db.prepare(`
      SELECT *
      FROM mints
      WHERE inscription_id=?
    `).get(req.params.inscriptionId);

    if (!mint) return reply.code(404).send("Mint not found");

    const pack = db.prepare(`
      SELECT *
      FROM packs
      WHERE pack_id=?
    `).get(mint.pack_id);

    if (!pack || !pack.file_path || !fs.existsSync(pack.file_path)) {
      return reply.code(404).send("Pack not ready");
    }

    let html = fs.readFileSync(pack.file_path, "utf8");

    html += `
<script>
if(!location.hash){
  location.hash=${JSON.stringify(mint.inscription_id)};
}
</script>`;

    reply.header("Content-Type", "text/html; charset=utf-8");
reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return html;
  });

  app.post("/api/dcp/mint", async (req, reply) => {
    const auth = req.headers.authorization || "";
    const expected = process.env.DCP_API_KEY || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

    if (!expected || token !== expected) {
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }

    const { receiverAddress, collection, paymentTxid } = req.body || {};

    if (!receiverAddress || !/^[DA9][a-km-zA-HJ-NP-Z1-9]{25,40}$/.test(receiverAddress)) {
      return reply.code(400).send({ ok: false, error: "Invalid receiverAddress" });
    }

    if (collection !== "DCP Pups") {
      return reply.code(400).send({ ok: false, error: "Unsupported collection" });
    }

    const mintJson = {
      p: "dcp",
      v: "0.1",
      op: "mint",
      collection: "DCP Pups",
      pack: "dcp-pups-image-pack-v3",
      maxSupply: 50000,
      unique: true,
      paymentTxid: paymentTxid || null
    };

    const tmp = `/tmp/dcp-mint-${Date.now()}.json`;
    fs.writeFileSync(tmp, JSON.stringify(mintJson, null, 2));

    try {
      const out = execSync(
        `node /opt/dcp-inscriber/inscribe-dcp-real.js ${tmp} application/json`,
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 20,
          env: {
            ...process.env,
            DCP_RECEIVER_ADDRESS: receiverAddress
          }
        }
      );

      try { fs.unlinkSync(tmp); } catch {}

      const commitTx = (out.match(/Commit TX:\s*([a-f0-9]{64})/i) || [])[1];
      const revealTx = (out.match(/Reveal TX:\s*([a-f0-9]{64})/i) || [])[1];
      const inscriptionId = (out.match(/Inscription ID:\s*([a-f0-9]{64}i0)/i) || [])[1];

      if (!inscriptionId) {
        return reply.code(500).send({
          ok: false,
          error: "Could not parse inscriptionId",
          raw: out
        });
      }

      return {
        ok: true,
        status: "broadcasted",
        collection: "DCP Pups",
        receiverAddress,
        paymentTxid,
        inscriptionId,
        commitTx,
        revealTx,
        renderUrl: `/render/${inscriptionId}`,
        metadataUrl: `/api/inscription/${inscriptionId}`
      };

    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}

      return reply.code(500).send({
        ok: false,
        error: "Mint failed on VPS",
        message: String(e.stderr || e.stdout || e.message || e)
      });
    }
  });

  await app.listen({ host: "0.0.0.0", port: PORT });
  console.log("DCP API running on port", PORT);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let indexing = false;

async function runIndexerLoop() {
  while (true) {
    if (!indexing) {
      indexing = true;
      try {
        await runIndexerOnce();
      } catch (e) {
        console.error("Indexer loop error:", e.message || e);
      }
      indexing = false;
    }

    await sleep(30000);
  }
}

async function main() {
  runIndexerLoop();
  await startApi();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});