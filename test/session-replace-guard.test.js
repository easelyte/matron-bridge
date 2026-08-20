import { describe, it, expect } from 'vitest';
import {
  inflightMediaReplaceRefusal,
  INFLIGHT_MEDIA_REPLACE_REFUSAL,
} from '../lib/session-replace-guard.js';

describe('inflightMediaReplaceRefusal', () => {
  it('refuses with the shared notice while media is in flight', () => {
    expect(inflightMediaReplaceRefusal(true)).toEqual({
      refuse: true,
      message: INFLIGHT_MEDIA_REPLACE_REFUSAL,
    });
    expect(INFLIGHT_MEDIA_REPLACE_REFUSAL).toMatch(/attachment/i);
  });

  it('proceeds when no media is in flight', () => {
    expect(inflightMediaReplaceRefusal(false)).toEqual({ refuse: false });
    expect(inflightMediaReplaceRefusal(undefined)).toEqual({ refuse: false });
  });
});
