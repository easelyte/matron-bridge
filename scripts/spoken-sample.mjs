// Operator listening check for the spoken summary lines (voice mode,
// matron-apple spec 2026-10-03 §1). Asks the REAL summary model, once, about a
// saved conversation and prints what a listener would hear, so the wording
// can be judged by ear before the apps exist. Kept out of npm test: it needs
// a key and costs a model call. Prints no key and no config value.
//
//   node scripts/spoken-sample.mjs [conversation.json]
//
// The conversation is a JSON array of {role: 'user'|'assistant', text}, the
// shape of session.chatHistory. Default: test/fixtures/spoken-sample.json.
// The model is picked exactly as index.js picks it: OPENAI_API_KEY wins, then
// GEMINI_API_KEY; SUMMARY_MODEL overrides the model name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createSummaryModel } from '../lib/summary-model.js';
import { buildSummaryPrompt, splitSpoken, spokenPayload, spokenRefFor } from '../lib/summary-pass.js';
import { parseTitlePassResponse } from '../lib/journal-title-seed.js';

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplePath = process.argv[2] || path.join(bridgeDir, 'test', 'fixtures', 'spoken-sample.json');
const messages = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

const geminiKey = process.env.GEMINI_API_KEY || '';
const summaryModel = createSummaryModel({
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  geminiClient: geminiKey ? new GoogleGenerativeAI(geminiKey) : null,
  modelOverride: process.env.SUMMARY_MODEL || '',
});

if (!summaryModel) {
  console.log('SKIPPED: neither OPENAI_API_KEY nor GEMINI_API_KEY is set, so there is no summary model to ask.');
  process.exit(0);
}

const count = (s) => (s ? `${s.split(' ').length} words, ${s.length} characters` : 'none');

// The NEW variant: the one every pass after a conversation's first uses.
const prompt = buildSummaryPrompt({ messages, priorRoster: null, hasCumulative: true });
const text = await summaryModel.generate(prompt);
const voiced = splitSpoken(text);
const parsed = parseTitlePassResponse(voiced.rest);

console.log(`model: ${summaryModel.model}`);
console.log(`conversation: ${path.relative(bridgeDir, samplePath)} (${messages.length} messages)`);
console.log('\n--- the model\'s answer, as it came ---');
console.log(text);
console.log('\n--- SPOKEN (said when the turn ends; 40 words asked for, cut at 400 characters) ---');
console.log(voiced.spoken ?? '(missing: the summary event would carry no spoken keys)');
console.log(`[${count(voiced.spoken)}]`);
console.log('\n--- SPOKEN_MORE (said on "more"; 150 words asked for, cut at 1,200 characters) ---');
console.log(voiced.spokenMore ?? '(none: the model wrote NONE or left it out)');
console.log(`[${count(voiced.spokenMore)}]`);
console.log('\n--- the rest still parses ---');
console.log(JSON.stringify(parsed, null, 2));
console.log('\n--- keys the summary event would gain ---');
console.log(JSON.stringify(spokenPayload(voiced, spokenRefFor(messages, 'sample-reply-ref')), null, 2));
