import { describe, it, expect } from 'vitest';
import {
  summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, SUMMARY_WINDOW_CAP,
  splitSpoken, spokenPayload, spokenRefFor, SPOKEN_MAX, SPOKEN_MORE_MAX,
} from '../lib/summary-pass.js';
import { parseTitlePassResponse } from '../lib/journal-title-seed.js';

// Voice mode spec 2026-10-03 §1, "What is written": the two lines, word for
// word (the spec wraps them for the page; the prompt carries each on one line).
const SPOKEN_LINE = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most, said by the agent in the first person ("I", never "the agent"). First, anything I am asking, need decided or am blocked on, naming the options or who has to act. Then the outcome in one sentence. Then what I will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff, code or a long list, do not read it out: end with a few words saying it is in the chat.>';
const SPOKEN_MORE_LINE = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat I raised. Same first person, the same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything worth hearing.>';

const msgs = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${start + i}` }));

describe('summaryWindow', () => {
  it('slices strictly after the last summarized message', () => {
    const h = msgs(12);
    const { messages, newCount, nextCount } = summaryWindow(h, 7);
    expect(messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(newCount).toBe(5);
    expect(nextCount).toBe(12);
  });
  it('caps at 200 keeping the NEWEST overflow, and still advances past dropped messages', () => {
    const h = msgs(450);
    const { messages, newCount, nextCount } = summaryWindow(h, 100);
    expect(messages).toHaveLength(SUMMARY_WINDOW_CAP);
    expect(messages[0].text).toBe('m250'); // oldest overflow (m100..m249) dropped
    expect(messages.at(-1).text).toBe('m449');
    expect(newCount).toBe(350);
    expect(nextCount).toBe(450); // cursor passes the dropped region — never re-summarized
  });
  it('tolerates a cursor beyond the history (restart clamp)', () => {
    const { messages, nextCount } = summaryWindow(msgs(3), 99);
    expect(messages).toEqual([]);
    expect(nextCount).toBe(3);
  });
});

describe('buildSummaryPrompt', () => {
  it('embeds messages as role: text and keeps ROSTER as the last format key', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).toContain('user: m0');
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('TITLE:'));
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('SUMMARY:'));
  });
  it('includes the prior roster inside a fenced preamble, and uses NEW: when cumulative exists', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: 'Was fixing auth.\nTITLE: sneaky', hasCumulative: true });
    expect(p).toContain('Was fixing auth.');
    expect(p).toContain('NEW:');
    // the fenced preamble sits before the format block so a hostile roster line can't terminate it
    expect(p.indexOf('Was fixing auth.')).toBeLessThan(p.indexOf('Format:'));
  });
  it('omits the preamble when there is no prior roster', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).not.toContain('previous rolling summary');
  });

  it.each([
    ['the NEW variant', true, 'NEW'],
    ['the first-pass SUMMARY variant', false, 'SUMMARY'],
  ])('%s asks for SPOKEN then SPOKEN_MORE, in the spec\'s words, with ROSTER still last', (_name, hasCumulative, second) => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative });
    const format = p.slice(p.indexOf('Format:'), p.indexOf('\n\nMessages:'));
    const keys = format.split('\n').filter((l) => /^[A-Z_]+: </.test(l)).map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['TITLE', second, 'SPOKEN', 'SPOKEN_MORE', 'ROSTER']);
    expect(format.split('\n')).toContain(SPOKEN_LINE);
    expect(format.split('\n')).toContain(SPOKEN_MORE_LINE);
    // The numbered list above the format block names the spoken versions too,
    // so the model is not told "three things" and shown five keys.
    expect(p.slice(0, p.indexOf('Format:'))).toContain('3. Two spoken versions of the agent\'s latest reply, for someone listening instead of reading');
    expect(p.slice(0, p.indexOf('Format:'))).toContain('4. A 2-3 sentence rolling summary');
  });
});

describe('gate constants', () => {
  it('exports the gate constants the index.js wiring consumes', () => {
    expect(SUMMARY_MIN_NEW).toBe(1);
    expect(SUMMARY_WINDOW_CAP).toBe(200);
  });
});

describe('splitSpoken', () => {
  const full = [
    'TITLE: deploy script fix',
    'NEW: Fixed the deploy script.',
    'SPOKEN: The agent asks whether to deploy now or wait for review. The fix is ready.',
    'SPOKEN_MORE: Deploying now puts the fix live tonight,',
    'but nobody else has read it.',
    '',
    'Waiting costs a day.',
    'ROSTER: Working on the deploy script.',
  ].join('\n');

  it('reads SPOKEN, and SPOKEN_MORE across wrapped lines up to the next label, as one line each', () => {
    const r = splitSpoken(full);
    expect(r.spoken).toBe('The agent asks whether to deploy now or wait for review. The fix is ready.');
    expect(r.spokenMore).toBe('Deploying now puts the fix live tonight, but nobody else has read it. Waiting costs a day.');
  });

  it('hands back the rest with both blocks cut out, which parseTitlePassResponse reads as before', () => {
    const r = splitSpoken(full);
    expect(r.rest).toBe('TITLE: deploy script fix\nNEW: Fixed the deploy script.\nROSTER: Working on the deploy script.');
    expect(parseTitlePassResponse(r.rest)).toEqual({
      title: 'deploy script fix', summary: null, added: 'Fixed the deploy script.', roster: 'Working on the deploy script.',
    });
  });

  it('output with no SPOKEN line (an old prompt, a model that skipped it): nulls, text untouched', () => {
    const old = 'TITLE: plan mode fix\nNEW: Added a test.\nROSTER: Working on plan mode.';
    expect(splitSpoken(old)).toEqual({ spoken: null, spokenMore: null, rest: old });
  });

  it('SPOKEN_MORE of NONE, in any case and with or without a full stop, or left empty, is null', () => {
    for (const more of ['NONE', 'none', 'None.', ' NONE ', '']) {
      const r = splitSpoken(`TITLE: t\nNEW: n\nSPOKEN: All done.\nSPOKEN_MORE: ${more}\nROSTER: r`);
      expect(r.spoken, JSON.stringify(more)).toBe('All done.');
      expect(r.spokenMore, JSON.stringify(more)).toBeNull();
      expect(r.rest, JSON.stringify(more)).toBe('TITLE: t\nNEW: n\nROSTER: r');
    }
    // NONE only as the whole field: a sentence that starts with it is kept.
    expect(splitSpoken('SPOKEN: Done.\nSPOKEN_MORE: None of the tests ran.').spokenMore).toBe('None of the tests ran.');
  });

  it('SPOKEN of NONE or left empty is no spoken line at all', () => {
    expect(splitSpoken('TITLE: t\nSPOKEN: NONE\nSPOKEN_MORE: Some detail.\nROSTER: r').spoken).toBeNull();
    expect(splitSpoken('TITLE: t\nSPOKEN:\nROSTER: r').spoken).toBeNull();
  });

  it('a label counts only at the start of a line, and only the pass\'s own labels end a field', () => {
    const r = splitSpoken([
      'NEW: The agent wrote SPOKEN: into the prompt.',
      'SPOKEN: It asks which API to use.',
      'SPOKEN_MORE: There are two.',
      'API: the first is older.',
      'TODO: it has not tried the second.',
      'ROSTER: Choosing an API.',
    ].join('\n'));
    expect(r.spoken).toBe('It asks which API to use.');
    expect(r.spokenMore).toBe('There are two. API: the first is older. TODO: it has not tried the second.');
    expect(r.rest).toBe('NEW: The agent wrote SPOKEN: into the prompt.\nROSTER: Choosing an API.');
  });

  it('spoken prose that looks like TITLE, SUMMARY or NEW never reaches the single-line parser', () => {
    // parseTitlePassResponse matches those three anywhere in a line, ignoring
    // case. Left in, "In summary: …" would become the first pass's SUMMARY and
    // "what is new: …" its NEW.
    const r = splitSpoken([
      'TITLE: billing export',
      'SPOKEN: Here is what is new: the export works.',
      'SPOKEN_MORE: In summary: nothing else changed.',
      'ROSTER: Working on the billing export.',
    ].join('\n'));
    expect(parseTitlePassResponse(r.rest)).toEqual({
      title: 'billing export', summary: null, added: null, roster: 'Working on the billing export.',
    });
  });

  it('a model that puts the spoken lines after ROSTER does not have them swallowed into the roster', () => {
    const r = splitSpoken('TITLE: t\nNEW: n\nROSTER: Working on it.\nStill going.\nSPOKEN: Done.\nSPOKEN_MORE: More.');
    expect(r.spoken).toBe('Done.');
    expect(r.spokenMore).toBe('More.');
    expect(parseTitlePassResponse(r.rest).roster).toBe('Working on it.\nStill going.');
  });

  it('caps SPOKEN at 400 and SPOKEN_MORE at 1,200 characters, cutting back to a whole word', () => {
    expect(SPOKEN_MAX).toBe(400);
    expect(SPOKEN_MORE_MAX).toBe(1200);
    const words = (n) => Array.from({ length: n }, () => 'seven77').join(' '); // 8 chars a word with its space
    const r = splitSpoken(`SPOKEN: ${words(60)}\nSPOKEN_MORE: ${words(200)}`);
    expect(r.spoken).toBe(words(50)); // 399 chars: the 51st word would end at 407
    expect(r.spoken.length).toBeLessThanOrEqual(400);
    expect(r.spokenMore).toBe(words(150)); // 1,199 chars
    // Exactly at the cap is kept whole; a single unbroken run is cut hard.
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(400)}`).spoken).toBe('x'.repeat(400));
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(401)}`).spoken).toBe('x'.repeat(400));
    expect(splitSpoken(`SPOKEN: ${'x'.repeat(396)} and more`).spoken).toBe(`${'x'.repeat(396)} and`);
  });

  it('tolerates non-string input', () => {
    expect(splitSpoken(undefined)).toEqual({ spoken: null, spokenMore: null, rest: '' });
  });
});

describe('spokenPayload', () => {
  it('gives the three summary-event keys, in the order the spec lists them', () => {
    const p = spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, 'msg_1');
    expect(p).toEqual({ spoken: 'Short.', spoken_more: 'Longer.', spoken_ref: 'msg_1' });
    expect(Object.keys(p)).toEqual(['spoken', 'spoken_more', 'spoken_ref']);
  });
  it('leaves spoken_more out when there is none', () => {
    expect(spokenPayload({ spoken: 'Short.', spokenMore: null }, 'msg_1')).toEqual({ spoken: 'Short.', spoken_ref: 'msg_1' });
  });
  it('gives nothing without a spoken line, or without a reply to hang it on', () => {
    expect(spokenPayload({ spoken: null, spokenMore: 'Longer.' }, 'msg_1')).toEqual({});
    expect(spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, null)).toEqual({});
    expect(spokenPayload({ spoken: 'Short.', spokenMore: 'Longer.' }, '')).toEqual({});
  });
});

describe('spokenRefFor', () => {
  const user = { role: 'user', text: 'go' };
  const reply = { role: 'assistant', text: 'done' };
  it('is the last reply\'s ref when the window holds an assistant message', () => {
    expect(spokenRefFor([user, reply], 'msg_9')).toBe('msg_9');
  });
  it('is null when the window holds no assistant message, so an old reply never lends its ref', () => {
    expect(spokenRefFor([user], 'msg_9')).toBeNull();
    expect(spokenRefFor([], 'msg_9')).toBeNull();
  });
  it('is null when the last reply\'s text event carried no ref', () => {
    expect(spokenRefFor([user, reply], null)).toBeNull();
    expect(spokenRefFor([user, reply], undefined)).toBeNull();
  });
});
