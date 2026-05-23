import OpenAI from "openai";

if (!process.env.OPENAI_BASE_URL) {
  throw new Error(
    "OPENAI_BASE_URL must be set. Set OPENAI_API_KEY and optionally OPENAI_BASE_URL in your environment.",
  );
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY must be set. Set OPENAI_API_KEY and optionally OPENAI_BASE_URL in your environment.",
  );
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
