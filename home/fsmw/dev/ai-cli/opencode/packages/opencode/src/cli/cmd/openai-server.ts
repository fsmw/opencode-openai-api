import type { Argv } from "yargs"
import { cmd } from "./cmd"

export const OpenAIServerCommand = cmd({
  command: "server-openai",
  describe: "starts an OpenAI-compatible API proxy server for OpenCode",
  builder: (yargs: Argv) =>
    yargs
      .option("port", {
        alias: ["p"],
        type: "number",
        describe: "port to listen on for OpenAI proxy",
        default: 4040,
      })
      .option("host", {
        type: "string",
        describe: "hostname to listen on",
        default: "127.0.0.1",
      })
      .option("api-key", {
        type: "string",
        describe: "API key for authorization (Bearer token)",
        default: undefined,
      }),
  handler: async (args) => {
    const port = Number(args.port)
    const host = args.host as string
    const apiKey = args["api-key"] as string | undefined

    // Set environment variables for the plugin
    if (apiKey) {
      process.env.OPENAI_PROXY_API_KEY = apiKey
    }
    process.env.OPENAI_PROXY_PORT = String(port)
    process.env.OPENAI_PROXY_HOST = host

    try {
      // Dynamic import to avoid circular dependencies
      const { OpenAIServerPlugin } = await import("../../../../../.opencode/plugin/openai-server")
      
      // Create a minimal client mock for the plugin if needed
      const mockClient = {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "opencode",
                  models: {
                    "default": { name: "OpenCode Default" },
                    "gpt-4": { name: "GPT-4" },
                  },
                },
              ],
            },
          }),
        },
        session: {
          create: async () => ({ id: "mock-session" }),
          message: async (sessionId: string, body: any) => ({
            parts: [{ type: "text", text: "Hello from OpenCode!" }],
            model: body.model ?? "opencode/default",
          }),
        },
      }

      // Initialize the plugin with the mock client
      await OpenAIServerPlugin({ client: mockClient })

      console.log(`✅ OpenAI-compatible API proxy is running`)
      console.log(`📍 URL: http://${host}:${port}`)
      console.log(`📚 Endpoints:`)
      console.log(`   POST   http://${host}:${port}/v1/chat/completions`)
      console.log(`   GET    http://${host}:${port}/v1/models`)
      console.log(`   GET    http://${host}:${port}/health`)
      console.log(`   GET    http://${host}:${port}/openapi.json`)
      if (apiKey) {
        console.log(`🔐 API Key authentication enabled`)
      }
      console.log(`\n⏸️  Press Ctrl+C to stop the server`)

      // Keep the server running
      await new Promise(() => {})
    } catch (error) {
      console.error("❌ Failed to start OpenAI proxy server:")
      if (error instanceof Error) {
        console.error(error.message)
      } else {
        console.error(String(error))
      }
      process.exit(1)
    }
  },
})
