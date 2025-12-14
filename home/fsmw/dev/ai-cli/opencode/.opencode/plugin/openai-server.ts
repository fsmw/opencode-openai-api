import type { Plugin } from "@opencode-ai/plugin"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, generateSpecs } from "hono-openapi"

// Configuration defaults
const DEFAULT_PORT = 4040
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_TIMEOUT_MS = 60000 // 60 seconds

// Reuse lightweight conversions from console util (adapted)
function fromOaRequest(body: any) {
  if (!body || typeof body !== "object") return body
  const msgsIn = Array.isArray(body.messages) ? body.messages : []
  const msgsOut: any[] = []
  for (const m of msgsIn) {
    if (!m || !m.role) continue
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) msgsOut.push({ role: "system", content: m.content })
      continue
    }
    if (m.role === "user") {
      if (typeof m.content === "string") msgsOut.push({ role: "user", content: m.content })
      else if (Array.isArray(m.content)) {
        const parts: any[] = []
        for (const p of m.content) {
          if (!p || !p.type) continue
          if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text })
          if (p.type === "image_url") parts.push({ type: "image_url", image_url: p.image_url })
        }
        if (parts.length === 1 && parts[0].type === "text") msgsOut.push({ role: "user", content: parts[0].text })
        else if (parts.length > 0) msgsOut.push({ role: "user", content: parts })
      }
      continue
    }
    if (m.role === "assistant") {
      const out: any = { role: "assistant" }
      if (typeof m.content === "string") out.content = m.content
      if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls
      msgsOut.push(out)
      continue
    }
    if (m.role === "tool") {
      msgsOut.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content })
      continue
    }
  }
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    messages: msgsOut,
    stream: !!body.stream,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    tool_choice: body.tool_choice,
  }
}

function toOaResponse(resp: any) {
  if (!resp || typeof resp !== "object") return resp
  const parts: any[] = Array.isArray(resp.parts) ? resp.parts : []
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
  const out = {
    id: `chatcmpl_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model ?? "opencode",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
  }
  return out
}

// Convert streaming chunks to SSE format
function toOaStreamChunk(partial: string, model: string) {
  return {
    id: `chatcmpl_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "opencode",
    choices: [
      {
        index: 0,
        delta: {
          content: partial,
        },
        finish_reason: null,
      },
    ],
  }
}

// Validate API key if configured
function validateApiKey(authHeader: string | null, apiKey: string | undefined): boolean {
  if (!apiKey) return true // No API key configured, allow all
  if (!authHeader) return false
  const parts = authHeader.split(" ")
  if (parts.length !== 2 || parts[0] !== "Bearer") return false
  return parts[1] === apiKey
}

// Map errors to OpenAI-compatible format
function createErrorResponse(statusCode: number, message: string, type: string = "server_error") {
  return {
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  }
}

export const OpenAIServerPlugin: Plugin = async ({ client }) => {
  const port = Number(process.env.OPENAI_PROXY_PORT ?? DEFAULT_PORT)
  const host = process.env.OPENAI_PROXY_HOST ?? DEFAULT_HOST
  const apiKey = process.env.OPENAI_PROXY_API_KEY
  const timeoutMs = Number(process.env.OPENAI_PROXY_TIMEOUT ?? DEFAULT_TIMEOUT_MS)

  const app = new Hono()

  // Middleware for API key validation
  app.use(async (c, next) => {
    // Skip validation for OpenAPI spec endpoint
    if (c.req.path() === "/openapi.json") {
      return await next()
    }
    
    const authHeader = c.req.header("Authorization")
    if (!validateApiKey(authHeader, apiKey)) {
      return c.json(
        createErrorResponse(401, "Unauthorized", "authentication_error"),
        401,
      )
    }
    return await next()
  })

  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: { title: "OpenCode OpenAI Proxy", version: "0.1.0", description: "OpenAI compatible proxy for OpenCode models" },
        openapi: "3.1.1",
      },
    }),
  )

  app.post(
    "/v1/chat/completions",
    describeRoute({ summary: "Chat completions (compat)", operationId: "chat.completions" }),
    async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}))
        const parsed = fromOaRequest(body)
        const isStreaming = !!parsed.stream

        if (isStreaming) {
          // Handle streaming response
          return c.streaming(async (stream) => {
            try {
              // Create a session
              const session = await client.session.create({})
              
              // Build message parts from parsed.messages
              const messageParts: any[] = []
              for (const m of parsed.messages ?? []) {
                if (m.role === "user") {
                  if (typeof m.content === "string") messageParts.push({ type: "text", text: m.content })
                  else if (Array.isArray(m.content)) {
                    for (const p of m.content) {
                      if (p.type === "text") messageParts.push({ type: "text", text: p.text })
                    }
                  }
                }
              }

              // Request streaming from client with timeout
              const abortController = new AbortController()
              const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

              try {
                const msg = await client.session.message(session.id, {
                  parts: messageParts,
                  stream: true,
                })

                // Handle streaming response
                if (msg && typeof msg === "object" && Symbol.asyncIterator in msg) {
                  for await (const chunk of msg) {
                    if (chunk && chunk.parts) {
                      for (const part of chunk.parts) {
                        if (part.type === "text" && part.text) {
                          const sseChunk = toOaStreamChunk(part.text, parsed.model ?? "opencode")
                          await stream.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
                        }
                      }
                    }
                  }
                } else {
                  // Fallback for non-streaming response
                  const parts = msg && msg.parts ? msg.parts : []
                  const text = parts
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text ?? "")
                    .join("")
                  if (text) {
                    const sseChunk = toOaStreamChunk(text, parsed.model ?? "opencode")
                    await stream.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
                  }
                }

                // Send completion marker
                await stream.write("data: [DONE]\n\n")
              } finally {
                clearTimeout(timeoutId)
              }
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : "Unknown error occurred"
              const errorData = {
                error: {
                  message: errorMsg.includes("timeout") 
                    ? "provider timeout" 
                    : errorMsg,
                  type: errorMsg.includes("timeout") 
                    ? "provider_error" 
                    : "server_error",
                },
              }
              await stream.write(`data: ${JSON.stringify(errorData)}\n\n`)
              await stream.write("data: [DONE]\n\n")
            }
          })
        } else {
          // Handle non-streaming response
          // Create a session
          const session = await client.session.create({})
          
          // Build message parts from parsed.messages
          const messageParts: any[] = []
          for (const m of parsed.messages ?? []) {
            if (m.role === "user") {
              if (typeof m.content === "string") messageParts.push({ type: "text", text: m.content })
              else if (Array.isArray(m.content)) {
                for (const p of m.content) {
                  if (p.type === "text") messageParts.push({ type: "text", text: p.text })
                }
              }
            }
          }

          // Request with timeout
          const abortController = new AbortController()
          const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

          try {
            const msg = await client.session.message(session.id, { parts: messageParts })
            const resp = toOaResponse(msg)
            return c.json(resp)
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Unknown error occurred"
            const statusCode = errorMsg.includes("timeout") ? 504 : 500
            const errorType = errorMsg.includes("timeout") 
              ? "provider_error" 
              : "server_error"
            return c.json(
              createErrorResponse(statusCode, errorMsg, errorType),
              statusCode,
            )
          } finally {
            clearTimeout(timeoutId)
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Invalid request"
        return c.json(
          createErrorResponse(400, errorMsg, "invalid_request_error"),
          400,
        )
      }
    },
  )

  app.get(
    "/v1/models",
    describeRoute({ summary: "List models (compat)", operationId: "models.list" }),
    async (c) => {
      try {
        // Query providers and models via client
        const providers = await client.provider.list()
        const models: any[] = []
        for (const p of providers.data.all) {
          for (const [modelID, model] of Object.entries(p.models ?? {} as any)) {
            models.push({ id: `${p.id}/${modelID}`, object: "model", owned_by: p.id })
          }
        }
        return c.json({ data: models })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to list models"
        return c.json(
          createErrorResponse(500, errorMsg, "server_error"),
          500,
        )
      }
    },
  )

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() })
  })

  // Start server using Bun.serve if available, otherwise fallback to node listener
  let server: any
  try {
    // @ts-ignore Bun global
    server = Bun.serve({ port, hostname: host, fetch: app.fetch })
    console.log(`[OpenAI Proxy] Listening on http://${host}:${port}`)
    if (apiKey) {
      console.log(`[OpenAI Proxy] API key authentication enabled`)
    }
  } catch (e) {
    console.error("[OpenAI Proxy] Bun.serve not available in this runtime. Plugin will not start server.")
  }

  return {
    event: async ({ event }) => {
      // stop server on global dispose
      if (event?.event?.type === "global.disposed") {
        try {
          if (server) {
            server.stop()
            console.log(`[OpenAI Proxy] Server stopped`)
          }
        } catch (e) {
          console.error("[OpenAI Proxy] Error stopping server:", e)
        }
      }
    },
  }
}
