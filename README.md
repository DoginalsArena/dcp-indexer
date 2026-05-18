# DCP Indexer

DCP (Dogecoin Collection Protocol) ownership tracking indexer, renderer and recovery mint system for Dogecoin NFTs.

## Features

* DCP pack renderer
* Ownership tracking
* Live transfer tracking
* Mint API
* Recovery worker backup minting
* Cloudflare cache friendly render API
* Pack based generative NFTs
* Lightweight SQLite database
* FastAPI/Fastify style HTTP API
* HTML based on-chain rendering

---

# Architecture

```txt
Wallet
   ↓
Frontend 
   ↓
DCP Mint API
   ↓
DCP Indexer
   ↓
Dogecoin Node
```

Recovery system:

```txt
Wallet payment
      ↓
Recovery worker stores payment
      ↓
Mint succeeds?
   YES → done
   NO  → worker auto mints after timeout
```

---

# Requirements

## Ubuntu / VPS

Recommended:

* Ubuntu 22+
* 4GB RAM minimum
* SSD storage
* Public VPS

## Software

Install:

```bash
sudo apt update
sudo apt install -y nodejs npm sqlite3 git curl
```

## Dogecoin Core

You need:

* txindex=1
* fully synced node
* RPC enabled

Example dogecoin.conf:

```conf
server=1
txindex=1
rpcuser=doge
rpcpassword=password
rpcallowip=127.0.0.1
rpcport=22555
```

---

# Installation

```bash
git clone https://github.com/DoginalsArena/dcp-indexer.git
cd dcp-indexer
npm install
```

Create `.env`

```env
RPC_USER=doge
RPC_PASSWORD=password
RPC_URL=http://127.0.0.1:22555
START_HEIGHT=4583000
DCP_API_KEY=CHANGE_THIS
```

---

# Start Indexer

```bash
node dcp-indexer-api.js
```

Or with systemd.

---

# Recovery Worker

Start:

```bash
node dcp-recovery-worker.js
```

The recovery worker:

* stores incoming mint payment registrations
* waits for mint confirmation
* auto re-mints failed payments
* prevents lost user mints

---

# Cloudflare Setup

## Render cache

Recommended cache:

* Browser TTL: 1 month
* Edge TTL: 1 month
* Cache everything on `/render/*`

This massively reduces renderer load.

---

# Create DCP Pack

A DCP pack is a single HTML file.

The HTML contains:

* SVG renderer
* deterministic generator
* embedded JSON traits
* metadata

Example:

```html
<script id="dcp-pack" type="application/json">
{
  "name": "DCP Pups",
  "version": "1.0"
}
</script>
```

---

# Pack Structure

Recommended structure:

```txt
packs/
  dcp-pups-image-pack-v3.html
```

The pack generates NFTs directly from:

* traits
* seed
* inscription id

No external images required.

---

# Inscribing a Pack

You only inscribe ONE large pack file.

Unlike normal NFT collections:

* no thousands of PNG files
* no huge storage cost
* no IPFS dependency

Everything is generated from the pack.

Example inscription command:

```bash
node inscribe.js ./packs/dcp-pups-image-pack-v3.html
```

The output inscription becomes the collection renderer.

---

# DCP Mint

Mint JSON:

```json
{
  "p": "dcp",
  "v": "0.1",
  "op": "mint",
  "collection": "DCP Pups",
  "pack": "dcp-pups-image-pack-v3",
  "maxSupply": 50000,
  "unique": true
}
```

---

# Mint Flow

```txt
User sends DOGE
      ↓
Frontend calls recovery/register
      ↓
Frontend calls mint API
      ↓
Indexer creates inscription
      ↓
NFT appears in wallet
```

If mint fails:

```txt
Recovery worker detects missing mint
      ↓
Worker automatically mints replacement
```

---

# Ownership Tracking

The indexer tracks:

* current owner
* current output
* transfer history
* inscription movements

The ownership updates automatically whenever the inscription UTXO moves.

---

# Render API

Example:

```txt
https://dcp.doginalsarenanode.win/render/INSCRIPTION_ID
```

Example:

```txt
https://dcp.doginalsarenanode.win/render/60e9c68b527a045de4ecdecd5332810d38b50ccda62f6e786e87b76fc632b1c9i0
```

---

# Recovery API

Register payment:

```txt
POST /api/dcp/recovery/register
```

Example body:

```json
{
  "paymentTxid": "TXID",
  "receiverAddress": "DOGE_ADDRESS",
  "collection": "DCP Pups",
  "amountDoge": 1
}
```

---



# Database

SQLite tables:

* mints
* packs
* inscriptions
* recovery_payments
* state

The database automatically updates ownership.

---

# Systemd Example

## DCP Indexer

```ini
[Unit]
Description=DCP Indexer
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/dcp-indexer/dcp-indexer-api.js
WorkingDirectory=/opt/dcp-indexer
Restart=always

[Install]
WantedBy=multi-user.target
```

## Recovery Worker

```ini
[Unit]
Description=DCP Recovery Worker
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/dcp-indexer/dcp-recovery-worker.js
WorkingDirectory=/opt/dcp-indexer
Restart=always

[Install]
WantedBy=multi-user.target
```

---

# Start Services

```bash
systemctl daemon-reload
systemctl enable dcp-indexer
systemctl enable dcp-recovery
systemctl start dcp-indexer
systemctl start dcp-recovery
```

---

# Logs

```bash
journalctl -u dcp-indexer -f
journalctl -u dcp-recovery -f
```

---

# Philosophy

Traditional NFT collections:

* thousands of images
* expensive inscriptions
* huge storage

DCP:

* one pack
* deterministic generation
* very low cost
* fully on-chain rendering
* dynamic traits

Dogecoin generates the NFTs from the pack itself.

---

# License

MIT
