import { NextResponse } from "next/server";

type GeminiRequestBody = {
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
  maxTokens?: number;
};

function coerceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coerceMaxTokens(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function encodeModelPath(model: string): string {
  return model
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export async function POST(request: Request) {
  let body: GeminiRequestBody = {};
  try {
    body = (await request.json()) as GeminiRequestBody;
  } catch {
    body = {};
  }

  const apiKey = coerceString(body.apiKey) || coerceString(process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing Gemini API key." },
      { status: 400 },
    );
  }

  const model = coerceString(body.model) || "gemini-3-pro-preview";
  const normalizedModel = model.includes("/") ? model : `models/${model}`;
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

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];

  if (imageBase64 && imageMediaType) {
    parts.push({
      inlineData: {
        mimeType: imageMediaType,
        data: imageBase64,
      },
    });
  }

  if (pdfBase64 && pdfMediaType) {
    parts.push({
      inlineData: {
        mimeType: pdfMediaType,
        data: pdfBase64,
      },
    });
  }

  const generationConfig: Record<string, unknown> = { temperature: 0 };
  const maxOutputTokens = coerceMaxTokens(body.maxTokens);
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${encodeModelPath(normalizedModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      cache: "no-store",
    },
  );

  const raw = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { error: raw || "Gemini request failed." },
      { status: upstream.status },
    );
  }

  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  const text = Array.isArray(parsed?.candidates?.[0]?.content?.parts)
    ? parsed.candidates[0].content.parts
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
    : "";

  return NextResponse.json({ text });
}

