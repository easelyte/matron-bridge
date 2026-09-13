import { describe, it, expect } from 'vitest';
import { formatTuiCueMessage, urlCueParts, despaceTuiLine } from '../lib/tui-cue-message.js';

const OAUTH_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=MXorWLhHVscrw-6Q2Y62wuKstL4eMjqnGoUlrJ8KMaU' +
  '&code_challenge_method=S256&state=429pzn8T3-Ila09t0yqHj_PJAPWEJZFaHXNniHwCmHI';

const oauthScreen = (url = OAUTH_URL) =>
  `Browser didn't open? Use the url below to sign in (c to copy)\n${url}\n\nPaste code here if prompted >`;

describe('formatTuiCueMessage — OAuth sign-in cue', () => {
  it('splits into three messages so the URL can be copied on its own', () => {
    const msg = formatTuiCueMessage(oauthScreen(), [OAUTH_URL]);
    expect(msg.parts).toHaveLength(3);
    expect(msg.parts[0].plain).toContain('needs you to sign in');
    expect(msg.parts[2].plain).toContain('paste the code');
  });

  it('makes the URL message body EXACTLY the url and nothing else', () => {
    // The whole point: long-pressing this bubble on iOS copies its full
    // body, so anything else in it has to be hand-trimmed off a 400-char
    // URL on a phone keyboard.
    const msg = formatTuiCueMessage(oauthScreen(), [OAUTH_URL]);
    expect(msg.parts[1].plain).toBe(OAUTH_URL);
  });

  it('keeps the URL message tappable as a link', () => {
    const msg = formatTuiCueMessage(oauthScreen(), [OAUTH_URL]);
    // &amp;-escaped in the attribute, but the href is the same url.
    expect(msg.parts[1].html).toBe(
      `<a href="${OAUTH_URL.replace(/&/g, '&amp;')}">${OAUTH_URL.replace(/&/g, '&amp;')}</a>`,
    );
  });

  it('surfaces only the first url even when the screen carries several', () => {
    const msg = formatTuiCueMessage(oauthScreen(), [OAUTH_URL, 'https://claude.ai/other']);
    expect(msg.parts).toHaveLength(3);
    expect(msg.parts[1].plain).toBe(OAUTH_URL);
  });

  it('stays silent when every url on the screen was already surfaced', () => {
    expect(formatTuiCueMessage(oauthScreen(), [OAUTH_URL], { hasNewUrls: false })).toBeNull();
  });

  it('stays silent on an oauth screen with no url yet', () => {
    expect(formatTuiCueMessage("Browser didn't open? Paste code here >", [])).toBeNull();
  });
});

describe('formatTuiCueMessage — generic url cue', () => {
  it('gives each url its own message under one lead-in', () => {
    const screen = 'Open http://localhost:3000/ to continue\nhttps://example.com/docs\n> ';
    const msg = formatTuiCueMessage(screen, ['http://localhost:3000/', 'https://example.com/docs']);
    expect(msg.parts.map(p => p.plain)).toEqual([
      'Claude is asking you to act on this URL:',
      'http://localhost:3000/',
      'https://example.com/docs',
    ]);
  });
});

describe('formatTuiCueMessage — press-Enter acknowledgment', () => {
  it('is a single message, not split', () => {
    const msg = formatTuiCueMessage('Login successful.\nPress Enter to continue…', []);
    expect(msg.parts).toBeUndefined();
    expect(msg.plain).toBe('✅ Login successful.');
  });

  it('wins over the oauth branch when the success screen still shows the url', () => {
    // The post-paste screen keeps the wizard text and the URL in scrollback;
    // the press-Enter cue is the actionable state.
    const screen = `${oauthScreen()}\nLogin successful.\nPress Enter to continue…`;
    const msg = formatTuiCueMessage(screen, [OAUTH_URL]);
    expect(msg.parts).toBeUndefined();
    expect(msg.plain).toBe('✅ Login successful.');
  });
});

describe('urlCueParts', () => {
  it('omits the tail message when there is no trailing prose', () => {
    expect(urlCueParts('lead', '<b>lead</b>', ['https://x.test/'])).toHaveLength(2);
  });
});

describe('despaceTuiLine', () => {
  it('rejoins a shimmer-animated line', () => {
    expect(despaceTuiLine('L o g i n   s u c c e s s f u l .')).toBe('Login successful.');
  });
  it('leaves normal prose alone', () => {
    expect(despaceTuiLine('  Login successful, welcome back to the thing  ')).toBe(
      'Login successful, welcome back to the thing',
    );
  });
});
