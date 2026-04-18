# OpenClaw Gateway

**RealSyncDynamics OpenClaw Gateway** is a lightweight, self-hosted Node.js service that runs on your servers (Linux VPS, Windows WSL2, bare metal, Docker) and provides a secure HTTP + WebSocket interface for remote script execution, log reading, and system monitoring.

The backend of your RealSyncDynamics account communicates with this gateway to dispatch jobs, stream output in real-time, and query host telemetry — without requiring SSH or VPN access.

---

## Table of Contents

1. [Quick Install](#quick-install)
2. [API Reference](#api-reference)
3. [WebSocket Streaming](#websocket-streaming)
4. [Configuration](#configuration)
5. [Security](#security)
6. [Integration with RealSyncDynamics Backend](#integration-with-realsync-dynamics-backend)
7. [Troubleshooting](#troubleshooting)

---

## Quick Install

### Linux (one-liner)

```bash
curl -fsSL https://install.realsync.io/gateway | sudo bash
```

The installer will:
- Detect and install Node.js 20 if needed (via NodeSource or nvm fallback)
- Create `/opt/realsync-gateway` with correct permissions
- Register a **systemd** service (`realsync-gateway`) that auto-starts on boot
- Generate and display a random 64-character API key

After install:
```bash
# Check service status
systemctl status realsync-gateway

# Follow logs
journalctl -u realsync-gateway -f

# Test the public health endpoint
curl http://localhost:8443/health
```

---

### Windows (PowerShell)

Run in an **Administrator** PowerShell session:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://install.realsync.io/gateway/windows | iex
```

The installer will:
- Install Node.js 20 via `winget` (or download the MSI as fallback)
- Create `C:\realsync-gateway`
- Register a Windows service via **NSSM** (Task Scheduler as fallback)
- Add a Windows Firewall inbound rule for port 8443
- Generate and display your API key

```powershell
# Manual install with custom options
.\scripts\install-windows.ps1 -InstallDir "D:\gateway" -Port 9000

# Skip service registration (run manually)
.\scripts\install-windows.ps1 -NoService
```

---

### Docker

```bash
# 1. Clone / download the gateway
git clone https://github.com/realsync/openclaw-gateway
cd openclaw-gateway

# 2. Copy and configure the env file
cp .env.example .env
# Edit .env — set GATEWAY_API_KEY to a strong random value:
echo "GATEWAY_API_KEY=$(openssl rand -hex 32)" >> .env

# 3. Start with Docker Compose
docker compose up -d

# 4. Verify
curl http://localhost:8443/health
```

**docker-compose.yml** mounts:
- `./scripts` → `/app/scripts` (read-only) — place your scripts here
- `./logs`    → `/app/logs`   — persistent log storage
- `/var/log`  → `/host/var/log` (read-only) — expose host logs for `/logs/read`

---

### Manual / Development

```bash
git clone https://github.com/realsync/openclaw-gateway
cd openclaw-gateway
cp .env.example .env
# Edit .env with your settings
npm install
npm start        # production
npm run dev      # development (nodemon auto-reload)
```

---

## API Reference

All endpoints except `/health` require the `X-API-Key` header.

**Base URL:** `http://<your-host>:8443`

---

### `GET /health`

Public health-check. No authentication required.

```bash
curl http://localhost:8443/health
```

**Response:**
```json
{
  "status": "ok",
  "uptime_s": 3724,
  "version": "1.0.0",
  "gateway_id": "gateway-prod-01",
  "node_version": "v20.11.0",
  "timestamp": "2024-01-15T12:34:56.789Z"
}
```

---

### `GET /system/info`

Returns detailed host system metrics.

```bash
curl -H "X-API-Key: your-api-key" http://localhost:8443/system/info
```

**Response:**
```json
{
  "hostname": "prod-server-01",
  "platform": "linux",
  "os_version": "Ubuntu 22.04.3 LTS",
  "kernel": "5.15.0-91-generic",
  "arch": "x64",
  "cpu_brand": "Intel Core i7-12700 @ 2.10GHz",
  "cpu_count": 12,
  "cpu_logical_cores": 20,
  "cpu_speed_ghz": 2.1,
  "ram_total_gb": 32.0,
  "ram_used_gb": 12.4,
  "ram_free_gb": 19.6,
  "swap_total_gb": 4.0,
  "swap_used_gb": 0.1,
  "disk_total_gb": 500.0,
  "disk_used_gb": 123.5,
  "disk_free_gb": 376.5,
  "uptime_s": 864000,
  "load_avg_1m": 0.45,
  "load_avg_5m": 0.52,
  "load_avg_15m": 0.38,
  "cpu_usage_pct": 8.3,
  "network_interfaces": [
    {
      "name": "eth0",
      "ip4": "192.168.1.100",
      "ip6": "fe80::1",
      "mac": "aa:bb:cc:dd:ee:ff",
      "speed_mbps": 1000,
      "type": "wired"
    }
  ],
  "collected_at": "2024-01-15T12:34:56.789Z"
}
```

---

### `GET /scripts`

Lists all scripts available in the configured scripts directory.

```bash
curl -H "X-API-Key: your-api-key" http://localhost:8443/scripts
```

**Response:**
```json
{
  "scripts": [
    {
      "name": "backup.sh",
      "extension": ".sh",
      "size_bytes": 2048,
      "modified_at": "2024-01-10T09:00:00.000Z"
    },
    {
      "name": "cleanup.ps1",
      "extension": ".ps1",
      "size_bytes": 1024,
      "modified_at": "2024-01-12T14:30:00.000Z"
    }
  ],
  "scripts_dir": "/app/scripts",
  "count": 2
}
```

---

### `POST /execute`

Queues a script for execution. Returns immediately with a `job_id`. The script runs asynchronously.

**Request body:**
| Field         | Type   | Required | Description                                  |
|---------------|--------|----------|----------------------------------------------|
| `script_name` | string | Yes      | Filename of the script (basename only)       |
| `params`      | object | No       | Key-value pairs passed as `OPENCLAW_*` env vars |

```bash
curl -X POST http://localhost:8443/execute \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"script_name": "backup.sh", "params": {"TARGET": "/data", "COMPRESS": "true"}}'
```

**Response `202 Accepted`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "script": "backup.sh"
}
```

Params are injected as environment variables prefixed with `OPENCLAW_`:
- `TARGET` → `OPENCLAW_TARGET=/data`
- `COMPRESS` → `OPENCLAW_COMPRESS=true`

---

### `GET /jobs/:id`

Poll the status and output of a specific job.

```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:8443/jobs/550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "done",
  "script": "backup.sh",
  "started_at": "2024-01-15T12:34:56.789Z",
  "completed_at": "2024-01-15T12:35:12.100Z",
  "exit_code": 0,
  "output_lines": 24,
  "output": ["Starting backup...", "Backup complete."],
  "pid": 12345
}
```

**Job status values:**

| Status    | Meaning                                 |
|-----------|-----------------------------------------|
| `queued`  | Accepted, not yet started               |
| `running` | Process is active                       |
| `done`    | Completed with exit code 0              |
| `failed`  | Completed with non-zero exit or timeout |

---

### `GET /jobs`

Lists the 50 most recent jobs (newest first).

```bash
curl -H "X-API-Key: your-api-key" http://localhost:8443/jobs
```

---

### `POST /logs/read`

Reads the last N lines of a log file on the host.

**Request body:**
| Field   | Type    | Required | Description                        |
|---------|---------|----------|------------------------------------|
| `path`  | string  | Yes      | Absolute path to the log file      |
| `lines` | integer | No       | Number of tail lines (default 100, max 10000) |

```bash
curl -X POST http://localhost:8443/logs/read \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"path": "/var/log/nginx/error.log", "lines": 200}'
```

**Response:**
```json
{
  "file": "/var/log/nginx/error.log",
  "file_size_bytes": 204800,
  "total_lines": 1842,
  "returned_lines": 200,
  "lines": ["2024/01/15 12:34:00 [error] ...", "..."]
}
```

---

## WebSocket Streaming

Connect to `ws://<host>:8443/ws` to stream job output in real-time.

### Protocol

**Subscribe to a job:**
```json
{ "type": "subscribe", "job_id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Server → client messages:**

| Type       | Payload                                           | When                          |
|------------|---------------------------------------------------|-------------------------------|
| `data`     | `{ "type": "data", "line": "output line" }`      | Each stdout/stderr line       |
| `complete` | `{ "type": "complete", "exit_code": 0, "status": "done", "output": "..." }` | Job finished |
| `queued`   | `{ "type": "queued", "job_id": "..." }`          | Job not yet started           |
| `error`    | `{ "type": "error", "message": "..." }`          | Protocol error                |

If you subscribe to a job that is already finished, the gateway immediately replays all buffered output lines followed by the `complete` message.

### Example (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:8443/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', job_id: 'YOUR_JOB_ID' }));
};

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === 'data') {
    console.log(msg.line);
  } else if (msg.type === 'complete') {
    console.log(`Job finished with exit code ${msg.exit_code}`);
    ws.close();
  }
};
```

### Example (wscat CLI)

```bash
npm install -g wscat
wscat -c ws://localhost:8443/ws
> {"type":"subscribe","job_id":"550e8400-e29b-41d4-a716-446655440000"}
```

---

## Configuration

All settings are controlled via environment variables (`.env` file or OS environment).

| Variable                      | Default                  | Description                                               |
|-------------------------------|--------------------------|-----------------------------------------------------------|
| `GATEWAY_API_KEY`             | *(required)*             | Secret API key, min 32 chars. Hash-compared on every request. |
| `GATEWAY_ID`                  | `gateway-<random>`       | Unique identifier for this gateway instance.              |
| `PORT`                        | `8443`                   | HTTP + WebSocket listen port.                             |
| `SCRIPTS_DIR`                 | `./scripts`              | Directory containing executable scripts.                  |
| `LOG_LEVEL`                   | `info`                   | Winston log level: `error`, `warn`, `info`, `debug`.      |
| `LOG_FILE`                    | `./logs/gateway.log`     | Rolling log file path (10 MB max, 5 files retained).      |
| `MAX_JOB_TIMEOUT_MS`          | `300000`                 | Maximum script execution time in milliseconds (5 min).    |
| `ALLOWED_SCRIPT_EXTENSIONS`   | `.sh,.ps1,.py`           | Comma-separated list of permitted script file extensions. |
| `NODE_ENV`                    | `production`             | Node.js environment.                                      |

### Recommended production `.env`

```env
GATEWAY_API_KEY=<output of: openssl rand -hex 32>
GATEWAY_ID=gateway-prod-nyc-01
PORT=8443
SCRIPTS_DIR=/opt/realsync-gateway/scripts
LOG_LEVEL=warn
LOG_FILE=/opt/realsync-gateway/logs/gateway.log
MAX_JOB_TIMEOUT_MS=600000
ALLOWED_SCRIPT_EXTENSIONS=.sh,.py
NODE_ENV=production
```

---

## Security

### API Key

- The gateway compares the incoming `X-API-Key` header to `GATEWAY_API_KEY` using **SHA-256 hashing** and **`crypto.timingSafeEqual`** to prevent timing oracle attacks.
- The key is never stored in plaintext in memory beyond the initial hash — only the hash is retained at comparison time.
- Rotate the API key by updating `GATEWAY_API_KEY` in `.env` and restarting the service.

### API Key Rotation

```bash
# 1. Generate a new key
NEW_KEY=$(openssl rand -hex 32)

# 2. Update the backend configuration in RealSyncDynamics dashboard

# 3. Update .env on the gateway host
sed -i "s/^GATEWAY_API_KEY=.*/GATEWAY_API_KEY=$NEW_KEY/" /opt/realsync-gateway/.env

# 4. Restart the service (zero-downtime: old requests finish before restart)
systemctl restart realsync-gateway
```

### TLS / HTTPS

In production, it is strongly recommended to terminate TLS in front of the gateway. Do not expose port 8443 directly to the public internet without TLS.

**Recommended setup: Nginx reverse proxy**

```nginx
server {
    listen 443 ssl;
    server_name gateway.yourcompany.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.yourcompany.com/privkey.pem;

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://localhost:8443;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Script Safety

- Only files with extensions in `ALLOWED_SCRIPT_EXTENSIONS` can be executed.
- Script names are `path.basename`-sanitised to prevent directory traversal.
- Scripts must already exist in `SCRIPTS_DIR` — the gateway does not accept remote script upload.
- In Docker, `SCRIPTS_DIR` is mounted **read-only** so the container cannot modify scripts.
- The Docker container runs as the unprivileged `node` user.

### Firewall

Restrict access to the gateway port to the RealSyncDynamics backend IP range:

```bash
# UFW example
ufw allow from 203.0.113.0/24 to any port 8443 proto tcp
ufw deny 8443
```

---

## Integration with RealSyncDynamics Backend

### Gateway Registration

1. Install the gateway on your server (see [Quick Install](#quick-install)).
2. Note your gateway's **public IP/hostname** and the **API key** printed during installation.
3. In the RealSyncDynamics dashboard: **Settings → Gateways → Add Gateway**
4. Enter the URL (e.g. `https://gateway.yourcompany.com`) and API key.
5. The backend will call `/health` to verify connectivity.

### Backend → Gateway Request Flow

```
RealSyncDynamics Backend
    │
    ├─ POST /execute  (dispatches a job)
    │       └─ Returns {job_id}
    │
    ├─ WS  /ws        (subscribes to job output stream)
    │       └─ Receives real-time stdout/stderr lines
    │
    └─ GET /jobs/:id  (polls final status on disconnect)
```

### Headers

Every backend request to the gateway includes:

```
X-API-Key: <your GATEWAY_API_KEY>
Content-Type: application/json
User-Agent: RealSyncDynamics-Backend/1.x
```

---

## Troubleshooting

### Service won't start

```bash
# View recent logs
journalctl -u realsync-gateway -n 100 --no-pager

# Check .env exists and has GATEWAY_API_KEY set
cat /opt/realsync-gateway/.env | grep GATEWAY_API_KEY
```

### 401 Unauthorized

- Ensure the `X-API-Key` header value exactly matches `GATEWAY_API_KEY` in `.env`.
- Check for trailing newlines or spaces in the key.

### Script not found (404)

- The script file must be in `SCRIPTS_DIR` with a permitted extension.
- Verify with: `curl -H "X-API-Key: ..." http://localhost:8443/scripts`

### WebSocket connection drops

- Ensure your reverse proxy is configured with `proxy_read_timeout` > the expected job duration.
- The gateway pings are not implemented at the WS protocol level — handle reconnects client-side.

### Job timeout

- Default timeout is 5 minutes. Increase `MAX_JOB_TIMEOUT_MS` in `.env`.
- Long-running jobs should print output periodically to remain observable via WebSocket.

---

*OpenClaw Gateway is part of the RealSyncDynamics platform. For support, visit https://docs.realsync.io or email support@realsync.io.*
