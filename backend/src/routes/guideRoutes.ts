import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const guideRouter = Router();

// ── MICHIRA concierge system prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are GEMINI ENGINEERING COPILOT for the FSOC Virtual PAT (Free-Space Optical Communication Pointing, Acquisition & Tracking) system.

You are an expert in:
- Free-space optical communications (FSOC) and atmospheric optics
- Kalman filtering and state estimation for target tracking
- PID control systems and gimbal control
- Computer vision and YOLO-based object detection
- Performance analysis of tracking systems

CRITICAL RULES:
- If live telemetry context is provided in the message, reference its exact values in your analysis.
- NEVER fabricate metric values. If data is unavailable, say so explicitly.
- Be technically precise and engineering-focused.
- Do NOT say "As an AI" — answer as a specialist engineer.
- Keep answers focused: diagnose the specific question asked.
- Use technical terminology appropriate for aerospace/optical engineers.

If the user asks a general FSOC question without telemetry context, draw on your engineering knowledge.
If telemetry is present, always ground your answer in the actual measured values.`;

// ── POST /api/guide ───────────────────────────────────────────────────────────
guideRouter.post('/', async (req: Request, res: Response) => {
  const {
    message,
    pageContext,           // { destination?, state?, category?, description?, pageTitle? }
    conversationHistory,   // [{ role: 'user'|'model', parts: [{ text }] }]
    language = 'en',
  } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ success: false, error: 'Message is required.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(503).json({
      success: false,
      error: 'GEMINI_API_KEY is not set in backend/.env. Get a key at https://aistudio.google.com/app/apikey',
    });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT,
    });

    // Build context string from page metadata
    let contextBlock = '';
    if (pageContext) {
      const lines: string[] = [];
      if (pageContext.pageTitle)   lines.push(`CURRENT PAGE: ${pageContext.pageTitle}`);
      if (pageContext.destination) lines.push(`DESTINATION: ${pageContext.destination}`);
      if (pageContext.state)       lines.push(`STATE/REGION: ${pageContext.state}`);
      if (pageContext.category)    lines.push(`CATEGORY: ${pageContext.category}`);
      if (pageContext.description) lines.push(`DESCRIPTION: ${pageContext.description.slice(0, 300)}`);
      if (language !== 'en')       lines.push(`RESPOND IN: ${language}`);
      if (lines.length > 0) {
        contextBlock = `[Context: ${lines.join(' | ')}]\n\n`;
      }
    }

    // Build chat history (Gemini expects alternating user/model turns)
    const history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> =
      Array.isArray(conversationHistory) ? conversationHistory : [];

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(contextBlock + message);
    const text = result.response.text();

    return res.json({ success: true, data: { content: text, language } });
  } catch (err: any) {
    console.error('[MICHIRA GUIDE] Gemini error:', err?.message || err);
    return res.status(500).json({
      success: false,
      error: 'MICHIRA GUIDE is momentarily unavailable. Please try again.',
    });
  }
});
