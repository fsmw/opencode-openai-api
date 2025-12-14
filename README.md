# OpenCode OpenAI-Compatible Proxy

Minimal plugin + CLI command to expose OpenCode models over an OpenAI-compatible HTTP API.

## What It Provides
- POST /v1/chat/completions (streaming and non-streaming)
- GET /v1/models
- GET /health
- GET /openapi.json
- CLI entrypoint: `opencode server-openai`

## Quick Start

### Using the compiled binary
```bash
# Show help
/home/fsmw/dev/ai-cli/bin/opencode server-openai --help

# Default (localhost, no auth)
/home/fsmw/dev/ai-cli/bin/opencode server-openai

# Custom port + API key
/home/fsmw/dev/ai-cli/bin/opencode server-openai --port 5000 --api-key my-secret-key

# Auto-generate a key (default behavior)
# If you don't pass --key/--api-key, a random key is generated and printed
/home/fsmw/dev/ai-cli/bin/opencode server-openai
```

### Set your own key
```bash
/home/fsmw/dev/ai-cli/bin/opencode server-openai --key my-fixed-key
```

### Add to PATH (optional)
```bash
sudo ln -sf /home/fsmw/dev/ai-cli/bin/opencode /usr/local/bin/opencode
# or
export PATH="/home/fsmw/dev/ai-cli/bin:$PATH"
```

### From source
Requires the full OpenCode workspace. Example:
```bash
cd /home/fsmw/dev/ai-cli/opencode
bun run --bun packages/opencode/src/index.ts server-openai --port 4040
```

## API Examples

```bash
# Health
curl http://127.0.0.1:4040/health

# List models
curl -H "Authorization: Bearer my-api-key" \
  http://127.0.0.1:4040/v1/models

# Chat completion (non-streaming)
curl -X POST http://127.0.0.1:4040/v1/chat/completions \
  -H "Authorization: Bearer my-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/default","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Chat completion (streaming)
curl -N -X POST http://127.0.0.1:4040/v1/chat/completions \
  -H "Authorization: Bearer my-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/default","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Configuration
- Port: `--port` (default 4040) or `OPENAI_PROXY_PORT`
- Host: `--host` (default 127.0.0.1) or `OPENAI_PROXY_HOST`
- API key: `--api-key` or `OPENAI_PROXY_API_KEY`
- Timeout: `OPENAI_PROXY_TIMEOUT` (ms), default 60000

## Build From Source
```bash
cd /home/fsmw/dev/ai-cli/opencode/packages/opencode
bun ./script/build.ts --single      # current platform
# bun ./script/build.ts             # all platforms
```
Outputs: `packages/opencode/dist/opencode-<platform>/bin/opencode` (linux/mac/windows variants).

## Deployment Notes
- Default binds to 127.0.0.1 with no auth. For public exposure, set an API key and place behind TLS (reverse proxy).
- Nginx reverse proxy example:
  ```nginx
  server {
    listen 443 ssl;
    server_name api.example.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    location / { proxy_pass http://127.0.0.1:4040; }
  }
  ```
- Optional systemd service:
  ```ini
  ExecStart=/usr/local/bin/opencode server-openai --port 4040 --api-key ${OPENCODE_API_KEY}
  ```

## Troubleshooting (quick)
- Port in use: `lsof -i :4040` then kill or change `--port`.
- Connection refused: ensure server running; check firewall.
- Auth failed: confirm `Authorization: Bearer <key>` matches configured key.

## Files in This Repo
- opencode/.opencode/plugin/openai-server.ts (HTTP server and routes)
- opencode/packages/opencode/src/cli/cmd/openai-server.ts (CLI command)
- opencode/packages/opencode/src/index.ts (command registration)

## License
MIT
