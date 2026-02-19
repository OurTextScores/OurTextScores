import { NextResponse } from "next/server";

type ModelsRequestBody = {
  apiKey?: string;
};

function coerceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let body: ModelsRequestBody = {};
  try {
    body = (await request.json()) as ModelsRequestBody;
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

  const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    cache: "no-store",
  });

  const raw = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { error: raw || "Failed to load Gemini models." },
      { status: upstream.status },
    );
  }

  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  return NextResponse.json(parsed);
}

