import { describe, it, expect } from 'vitest';
import {
  buildMcpServers,
  extractMcpExtraFlags,
  extractPromptFlag,
  knownMcpExtras,
} from '../lib/mcp-config.js';

const BASE = Object.freeze({
  mcpServers: {
    'ask-user': {
      command: 'node',
      args: ['./ask-user.js'],
      env: { BRIDGE_API_URL: 'http://127.0.0.1:9802' },
    },
  },
  mcpExtras: {
    browser: {
      'chrome-devtools': {
        command: 'xvfb-run',
        args: [
          '--auto-servernum',
          '--server-args=-screen 0 1920x1080x24',
          'npx',
          '-y',
          'chrome-devtools-mcp',
          '--no-usage-statistics',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-setuid-sandbox',
        ],
      },
    },
  },
});

describe('extractMcpExtraFlags', () => {
  it('pulls --browser out of the token list', () => {
    expect(extractMcpExtraFlags(['--browser', '/some/dir']))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
    expect(extractMcpExtraFlags(['/some/dir', '--browser']))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
  });

  it('leaves unknown flags alone', () => {
    expect(extractMcpExtraFlags(['--browser', '--not-a-flag', '/dir']))
      .toEqual({ extras: ['browser'], rest: ['--not-a-flag', '/dir'] });
  });

  it('accepts em-dash / en-dash auto-corrected forms of --browser', () => {
    // Matrix/mobile clients auto-correct a leading "--" into "—" (em-dash),
    // so the user's "--browser" arrives as "—browser".
    expect(extractMcpExtraFlags(['—browser']))
      .toEqual({ extras: ['browser'], rest: [] });
    expect(extractMcpExtraFlags(['–browser', '/dir']))
      .toEqual({ extras: ['browser'], rest: ['/dir'] });
    // A unicode-dash token that isn't a known flag is preserved unchanged.
    expect(extractMcpExtraFlags(['—notaflag']))
      .toEqual({ extras: [], rest: ['—notaflag'] });
  });

  it('returns empty extras when none requested', () => {
    expect(extractMcpExtraFlags(['/dir'])).toEqual({ extras: [], rest: ['/dir'] });
    expect(extractMcpExtraFlags([])).toEqual({ extras: [], rest: [] });
  });

  it('exposes the recognised extras list for sanity checks', () => {
    expect(knownMcpExtras()).toContain('browser');
  });

  // Regression: a plain-object lookup table would silently consume tokens
  // that match Object.prototype member names ("constructor", "toString",
  // "__proto__") because bracket access falls through the prototype chain
  // and returns a truthy function. The Map-backed table avoids this.
  it('does not consume positional args that share Object.prototype names', () => {
    expect(extractMcpExtraFlags(['constructor'])).toEqual({ extras: [], rest: ['constructor'] });
    expect(extractMcpExtraFlags(['toString'])).toEqual({ extras: [], rest: ['toString'] });
    expect(extractMcpExtraFlags(['__proto__'])).toEqual({ extras: [], rest: ['__proto__'] });
    expect(extractMcpExtraFlags(['hasOwnProperty', '--browser']))
      .toEqual({ extras: ['browser'], rest: ['hasOwnProperty'] });
  });
});

describe('extractPromptFlag', () => {
  it('extracts a quoted multi-word prompt and returns the rest verbatim', () => {
    expect(extractPromptFlag('/opt/work --prompt "do the thing now"'))
      .toEqual({ prompt: 'do the thing now', rest: '/opt/work', error: null });
  });

  it('does NOT consume flags/args inside the quoted prompt', () => {
    expect(extractPromptFlag('--prompt "investigate /some/dir and --browser"'))
      .toEqual({ prompt: 'investigate /some/dir and --browser', rest: '', error: null });
  });

  it('accepts a single unquoted token', () => {
    expect(extractPromptFlag('/opt/work --prompt hello'))
      .toEqual({ prompt: 'hello', rest: '/opt/work', error: null });
  });

  it('preserves surrounding tokens on both sides of --prompt in rest', () => {
    expect(extractPromptFlag('--browser --prompt "go" /opt/work'))
      .toEqual({ prompt: 'go', rest: '--browser /opt/work', error: null });
  });

  it('errors on an unterminated quote', () => {
    const r = extractPromptFlag('--prompt "unterminated text');
    expect(r.prompt).toBeNull();
    expect(r.error).toMatch(/missing closing quote/);
  });

  it('honors backslash-escaped quotes inside the prompt', () => {
    expect(extractPromptFlag('/repo --prompt "say \\"hello\\" then stop"'))
      .toEqual({ prompt: 'say "hello" then stop', rest: '/repo', error: null });
  });

  it('rejects an empty quoted prompt (P8)', () => {
    const r = extractPromptFlag('/opt/work --prompt ""');
    expect(r.prompt).toBeNull();
    expect(r.error).toMatch(/non-empty/);
  });

  it('returns null + unchanged rest when --prompt is absent', () => {
    expect(extractPromptFlag('/opt/work now'))
      .toEqual({ prompt: null, rest: '/opt/work now', error: null });
  });

  it('does NOT match --prompt as a substring (--prompted / --prompt-extra)', () => {
    expect(extractPromptFlag('/opt/work --prompted'))
      .toEqual({ prompt: null, rest: '/opt/work --prompted', error: null });
    expect(extractPromptFlag('--prompt-extra foo'))
      .toEqual({ prompt: null, rest: '--prompt-extra foo', error: null });
  });

  it('handles a bare empty arg string (plain !start)', () => {
    expect(extractPromptFlag(''))
      .toEqual({ prompt: null, rest: '', error: null });
  });
});

// The browser extra's real on-disk shape since the xvfb-run leak fix: the MCP
// is wrapped in repo-relative ./hooks/xvfb-wrap.sh, which must be resolved to
// an absolute path in the generated config — claude runs with the SESSION
// workdir as cwd, not the bridge install dir, so a relative command would
// ENOENT for every session outside the repo.
const BASE_WRAP = Object.freeze({
  mcpServers: {
    'ask-user': {
      command: 'node',
      args: ['./ask-user.js'],
    },
  },
  mcpExtras: {
    browser: {
      'chrome-devtools': {
        command: './hooks/xvfb-wrap.sh',
        args: [
          'npx', '-y', 'chrome-devtools-mcp',
          '--no-usage-statistics',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-setuid-sandbox',
        ],
      },
    },
  },
});

describe('buildMcpServers — repo-relative command resolution (xvfb-wrap.sh)', () => {
  it('resolves a ./-relative server command against the bridge install dir on Linux', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE_WRAP,
      extras: ['browser'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(config.mcpServers['chrome-devtools'].command).toBe('/opt/bridge/hooks/xvfb-wrap.sh');
    // args are the real command line, untouched by resolution
    expect(config.mcpServers['chrome-devtools'].args[0]).toBe('npx');
  });

  it('leaves the relative command as-is when no base dir is supplied', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE_WRAP,
      extras: ['browser'],
      platform: 'linux',
    });
    expect(config.mcpServers['chrome-devtools'].command).toBe('./hooks/xvfb-wrap.sh');
  });

  it('does not touch non-relative commands', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(config.mcpServers['chrome-devtools'].command).toBe('xvfb-run');
  });

  it('on macOS the resolved wrapper is unwrapped to the real command', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE_WRAP,
      extras: ['browser'],
      platform: 'darwin',
      askUserBaseDir: '/opt/bridge',
    });
    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).toEqual([
      '-y', 'chrome-devtools-mcp', '--no-usage-statistics',
    ]);
  });
});

describe('buildMcpServers', () => {
  it('returns only the always-on servers when no extras are requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers)).toEqual(['ask-user']);
    expect(config.mcpServers['ask-user'].args[0]).toBe('/opt/bridge/ask-user.js');
    expect(extras).toEqual([]);
  });

  it('merges the browser extra in when requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(config.mcpServers['chrome-devtools'].command).toBe('xvfb-run');
    expect(extras).toEqual(['browser']);
  });

  it('silently drops unknown extras names rather than letting a typo enable nothing-then-everything', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'not-a-real-group'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(extras).toEqual(['browser']);
  });

  it('dedupes repeated extras and returns them sorted (for stable filename hashing)', () => {
    const { extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'browser'],
      platform: 'linux',
    });
    expect(extras).toEqual(['browser']);
  });

  it('unwraps xvfb-run on macOS so the browser MCP actually starts', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'darwin',
      askUserBaseDir: '/opt/bridge',
    });
    // macifyMcpServers strips the xvfb wrapper + Linux sandbox flags.
    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).not.toContain('--chromeArg=--no-sandbox');
  });

  it('does not mutate the base config', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    buildMcpServers({ baseConfig: BASE, extras: ['browser'], platform: 'linux', askUserBaseDir: '/x' });
    expect(BASE).toEqual(snapshot);
  });

  it('leaves args alone when no ask-user base dir is given', () => {
    const { config } = buildMcpServers({ baseConfig: BASE, platform: 'linux' });
    expect(config.mcpServers['ask-user'].args[0]).toBe('./ask-user.js');
  });
});
