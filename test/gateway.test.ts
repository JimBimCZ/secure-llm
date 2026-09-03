import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import type { AnswerInput, LlmProvider } from "@/server/ai/types";

interface Captured {
  path: string;
  headers: IncomingMessage["headers"];
  body: {
    model: string;
    system: string;
    messages: { role: string; content: string }[];
    output_config?: { effort?: string; format?: unknown };
  };
}

/**
 * A stand-in for a corporate AI Gateway: it speaks the Anthropic Messages wire
 * format, and it records what it was sent.
 */
function stubGateway(reply: unknown) {
  const received: Captured[] = [];
  let server: Server;

  const start = () =>
    new Promise<string>((resolve) => {
      server = createServer((request, response) => {
        const body: Buffer[] = [];
        request.on("data", (part: Buffer) => body.push(part));
        request.on("end", () => {
          received.push({
            path: request.url ?? "",
            headers: request.headers,
            body: JSON.parse(Buffer.concat(body).toString("utf8")),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(reply));
        });
      });
      // Port 0: the OS picks a free one, so the test cannot collide with
      // anything already running on this machine.
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
      });
    });

  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return { received, start, stop };
}

const answerJson = JSON.stringify({ answer: "750 W.", citations: [2] });

const messagesReply = {
  id: "msg_stub",
  type: "message",
  role: "assistant",
  model: "gateway-model",
  content: [{ type: "text", text: `Here you go:\n\`\`\`json\n${answerJson}\n\`\`\`` }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 123, output_tokens: 45 },
};

const input: AnswerInput = {
  question: "how big is the PSU?",
  chunks: [
    { id: "c1", documentId: "d1", content: "Two fans." },
    { id: "c2", documentId: "d1", content: "The PSU is rated 750 W." },
  ],
};

/**
 * What CLAUDE.md §5 promises is that reaching a corporate AI Gateway is a base
 * URL and an auth header, with nothing else in the app changing. `openrouter`
 * demonstrates that against a real third-party gateway, but only for the
 * address that is hard-coded in it; the generic form — the one an operator
 * actually configures — had never had a request pulled out of it and read.
 *
 * So this test reads one. It is not a live gateway, and it does not pretend to
 * be: what it pins down is the half that lives in this repository — the route,
 * the credential, the request the shared call path builds, and the parsing of
 * what comes back. A proxy speaking its own wire format would be a different
 * provider file, which is the point of there being an interface at all.
 */
describe("gateway provider", () => {
  const stub = stubGateway(messagesReply);
  let provider: LlmProvider;

  before(async () => {
    const baseUrl = await stub.start();

    // Set before `env` is first imported, which is why the import below is
    // dynamic: the schema reads the environment once, at module load.
    process.env.LLM_GATEWAY_BASE_URL = baseUrl;
    process.env.LLM_GATEWAY_API_KEY = "gateway-token-not-a-real-one";
    process.env.LLM_MODEL = "gateway-model";

    const { createGatewayProvider } = await import(
      "@/server/ai/providers/gateway"
    );
    provider = createGatewayProvider();
  });

  after(() => stub.stop());

  it("calls the configured gateway, not the vendor", async () => {
    await provider.answer(input, AbortSignal.timeout(5_000));

    assert.equal(stub.received.length, 1);
    assert.equal(stub.received[0]?.path, "/v1/messages");
  });

  it("authenticates to the gateway as a bearer, and sends no vendor key", async () => {
    // The gateway holds the vendor credential. This app authenticates to the
    // gateway, and an `x-api-key` leaking out of here would be the vendor key
    // it does not have.
    const headers = stub.received[0]?.headers ?? {};

    assert.equal(headers.authorization, "Bearer gateway-token-not-a-real-one");
    assert.equal(headers["x-api-key"], undefined);
  });

  it("sends the model id from the environment", async () => {
    assert.equal(stub.received[0]?.body.model, "gateway-model");
  });

  it("does not ask a proxy to enforce the response schema", async () => {
    // A gateway need not implement a recent addition to the API it fronts:
    // one that rejects the field fails every request, one that ignores it
    // returns no parsed output and looks like a refusal.
    assert.equal(stub.received[0]?.body.output_config?.format, undefined);
    assert.equal(stub.received[0]?.body.output_config?.effort, "medium");
  });

  it("sends the file-backed prompt, with the sources in their envelopes", async () => {
    const { system, messages } = stub.received[0]!.body;

    assert.match(system, /ONLY the numbered sources/);
    assert.match(messages[0]!.content, /<source index="1">\nTwo fans\.\n<\/source>/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "user");
  });

  it("parses the answer out of the text a proxy returns", async () => {
    // No server-side schema here, so the JSON arrives inside prose and a code
    // fence. Pulling it out is the shared call path's job, not the caller's.
    const result = await provider.answer(input, AbortSignal.timeout(5_000));

    assert.equal(result.answer, "750 W.");
    assert.deepEqual(result.citations, [2]);
    assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
  });

  it("reports itself as the gateway in the audit record", async () => {
    assert.equal(provider.name, "gateway");
    assert.equal(provider.model, "gateway-model");
  });
});
