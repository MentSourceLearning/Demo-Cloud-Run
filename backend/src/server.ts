import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

const backendSrcDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(backendSrcDir, "../.env") });

const port = Number(process.env.PORT ?? 8080);
const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const frontendDir = path.resolve(backendSrcDir, "../../frontend");
const questions = [
  "What happens when Cloud Run scales to zero?",
  "What is a cold start in Cloud Run?",
  "What is the difference between concurrency and max instances in Cloud Run?",
  "When does a Cloud Run service stop being billed for CPU?",
  "What does a request timeout mean for a Cloud Run service?",
  "Why would Cloud Run start more than one instance?",
  "What is the difference between a Cloud Run service and a Cloud Run job?",
  "What happens to in-flight requests when an instance is shut down?",
];
const instanceId = Math.random().toString(36).slice(2, 8);
const startedAt = Date.now();
let requestCount = 0;
let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "paste-your-key-here") {
    throw new Error("Set GEMINI_API_KEY in backend/.env");
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "16kb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).send("ok");
});

app.post("/api/submit", async (req: Request, res: Response) => {
  requestCount += 1;
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  const answer = String(req.body?.answer ?? "").trim().slice(0, 500);
  if (!question || !answer) {
    res.status(400).json({
      error: question ? "Type an answer, then submit." : "Type a question first.",
      instanceId,
    });
    return;
  }

  const started = Date.now();
  try {
    const response = await generateGrade(`Question: ${question}\n\nAnswer: ${answer}`);

    const graded = JSON.parse(response.text ?? "{}") as {
      correct?: boolean;
      rightAnswer?: string;
    };
    res.json({
      correct: graded.correct === true,
      rightAnswer: String(graded.rightAnswer ?? "").trim(),
      nextQuestion: pickNextQuestion(question),
      instanceId,
      requestsHandledByThisInstance: requestCount,
      modelMs: Date.now() - started,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      model,
    });
  } catch (error) {
    res.status(502).json({
      error: describeModelError(error),
      instanceId,
    });
  }
});

function describeModelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string; status?: string; code?: number };
      };
      const inner = parsed.error;
      if (inner?.message) {
        const parts = [inner.message];
        if (inner.status) parts.push(`Status: ${inner.status}.`);
        if (inner.code != null) parts.push(`Code: ${inner.code}.`);
        return parts.join(" ");
      }
    } catch {
      return raw;
    }
  }
  if (raw.toLowerCase().includes("aborted") || raw.toLowerCase().includes("timed out")) {
    return "Gemini took too long to answer, so the request was stopped. The model can be slow when it is under high demand. Submit again.";
  }
  return raw || "The model request failed.";
}

function pickNextQuestion(current: string): string {
  const choices = questions.filter((item) => item !== current);
  return choices[Math.floor(Math.random() * choices.length)] ?? questions[0];
}

async function generateGrade(contents: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    return await getClient().models.generateContent({
      model,
      contents,
      config: {
        abortSignal: controller.signal,
        systemInstruction:
          "Grade the answer. Treat equivalent explanations as correct. If it is wrong, rightAnswer is the correct answer in at most 3 short sentences. If it is right, rightAnswer is one short sentence stating that answer.",
        maxOutputTokens: 200,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            correct: { type: Type.BOOLEAN },
            rightAnswer: { type: Type.STRING },
          },
          required: ["correct", "rightAnswer"],
        },
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.static(frontendDir));

app.listen(port, "0.0.0.0", () => {
  console.log(`Open http://localhost:${port}`);
});