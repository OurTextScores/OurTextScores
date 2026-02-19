import { NextResponse } from "next/server";

type AnthropicRequestBody = {
  apiKey?: string;
  model?: string;
  promptText?: string;
  prompt?: string;
  xml?: string;
  systemPrompt?: string;
  imageBase64?: string;
  imageMediaType?: string;
  pdfBase64?: string;
  pdfMediaType?: string;
  pdfFilename?: string;
  maxTokens?: number;
};

function coerceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coerceMaxTokens(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 2048;
  return Math.floor(n);
}

export async function POST(request: Request) {
  let body: AnthropicRequestBody = {};
  try {
    body = (await request.json()) as AnthropicRequestBody;
  } catch {
    body = {};
  }

  const apiKey = coerceString(body.apiKey) || coerceString(process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing Anthropic API key." },
      { status: 400 },
    );
  }

  const model = coerceString(body.model) || "claude-opus-4-5";
  const systemPrompt = coerceString(body.systemPrompt);
  const promptText =
    coerceString(body.promptText) || coerceString(body.prompt) || coerceString(body.xml);

  if (!promptText) {
    return NextResponse.json(
      { error: "Missing prompt text." },
      { status: 400 },
    );
  }

  const imageBase64 = coerceString(body.imageBase64);
  const imageMediaType = coerceString(body.imageMediaType);
  const pdfBase64 = coerceString(body.pdfBase64);
  const pdfMediaType = coerceString(body.pdfMediaType);

  const content: Array<Record<string, unknown>> = [{ type: "text", text: promptText }];

  if (imageBase64 && imageMediaType) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType,
        data: imageBase64,
      },
    });
  }

  if (pdfBase64 && pdfMediaType) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: pdfMediaType,
        data: pdfBase64,
      },
    });
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: coerceMaxTokens(body.maxTokens),
      temperature: 0,
      system: systemPrompt || undefined,
      messages: [{ role: "user", content }],
    }),
    cache: "no-store",
  });

  const raw = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { error: raw || "Anthropic request failed." },
      { status: upstream.status },
    );
  }

  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  const text = Array.isArray(parsed?.content)
    ? parsed.content
        .map((item: any) => (item?.type === "text" && typeof item?.text === "string" ? item.text : ""))
        .join("")
    : "";

  return NextResponse.json({ text });
}

