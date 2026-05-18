const Fastify = require("fastify");
const Database = require("better-sqlite3");

const DB_PATH = "/opt/dcp-indexer/dcp.db";
const PORT = Number(process.env.DCP_RECOVERY_PORT || 8101);
const API_URL = process.env.DCP_API_URL || "http://127.0.0.1:8099";
const API_KEY = process.env.DCP_API_KEY;
const DELAY_MS = 10 * 60 * 1000;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS recovery_payments (
  payment_txid TEXT PRIMARY KEY,
  receiver_address TEXT NOT NULL,
  collection TEXT NOT NULL,
  amount_doge REAL DEFAULT 1,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  inscription_id TEXT,
  last_error TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  processed_at INTEGER
);
`);

function now() {
  return Date.now();
}

function paymentAlreadyMinted(paymentTxid) {
  return db.prepare(`
    SELECT inscription_id
    FROM mints
    WHERE json LIKE ?
    LIMIT 1
  `).get(`%${paymentTxid}%`);
}

async function mintPayment(row) {
  const existing = paymentAlreadyMinted(row.payment_txid);

  if (existing) {
    db.prepare(`
      UPDATE recovery_payments
      SET status='minted', inscription_id=?, updated_at=?, processed_at=?
      WHERE payment_txid=?
    `).run(existing.inscription_id, now(), now(), row.payment_txid);
    return;
  }

  const res = await fetch(`${API_URL}/api/dcp/mint`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      receiverAddress: row.receiver_address,
      collection: row.collection,
      paymentTxid: row.payment_txid
    })
  });

  const json = await res.json();

  if (!res.ok || !json.ok) {
    throw new Error(JSON.stringify(json));
  }

  db.prepare(`
    UPDATE recovery_payments
    SET status='minted', inscription_id=?, updated_at=?, processed_at=?
    WHERE payment_txid=?
  `).run(json.inscriptionId || null, now(), now(), row.payment_txid);
}

async function recoveryLoop() {
  while (true) {
    const cutoff = now() - DELAY_MS;

    const rows = db.prepare(`
      SELECT *
      FROM recovery_payments
      WHERE status IN ('pending','failed')
        AND created_at <= ?
        AND attempts < 5
      ORDER BY created_at ASC
      LIMIT 10
    `).all(cutoff);

    for (const row of rows) {
      try {
        db.prepare(`
          UPDATE recovery_payments
          SET status='processing', attempts=attempts+1, updated_at=?
          WHERE payment_txid=?
        `).run(now(), row.payment_txid);

        await mintPayment(row);

        console.log("RECOVERY MINT OK", row.payment_txid);
      } catch (e) {
        console.error("RECOVERY MINT FAILED", row.payment_txid, e.message);

        db.prepare(`
          UPDATE recovery_payments
          SET status='failed', last_error=?, updated_at=?
          WHERE payment_txid=?
        `).run(String(e.message || e), now(), row.payment_txid);
      }
    }

    await new Promise(r => setTimeout(r, 60_000));
  }
}

async function startApi() {
  const app = Fastify({ logger: false });

  app.post("/api/dcp/recovery/register", async (req, reply) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

    if (!API_KEY || token !== API_KEY) {
      return reply.code(401).send({ ok: false, error: "Unauthorized" });
    }

    const { paymentTxid, receiverAddress, collection = "DCP Pups", amountDoge = 1 } = req.body || {};

    if (!paymentTxid || !receiverAddress) {
      return reply.code(400).send({ ok: false, error: "Missing paymentTxid or receiverAddress" });
    }

    db.prepare(`
      INSERT INTO recovery_payments (
        payment_txid, receiver_address, collection, amount_doge,
        status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(payment_txid) DO UPDATE SET
        receiver_address=excluded.receiver_address,
        updated_at=excluded.updated_at
    `).run(paymentTxid, receiverAddress, collection, amountDoge, now(), now());

    return { ok: true, status: "registered", paymentTxid };
  });

  app.get("/api/dcp/recovery/:paymentTxid", async (req) => {
    const row = db.prepare(`
      SELECT *
      FROM recovery_payments
      WHERE payment_txid=?
    `).get(req.params.paymentTxid);

    return row || { ok: false, error: "Not found" };
  });

  await app.listen({ host: "0.0.0.0", port: PORT });
  console.log("DCP recovery worker running on port", PORT);
}

async function main() {
  recoveryLoop();
  await startApi();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

