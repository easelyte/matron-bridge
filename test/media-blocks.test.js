import { describe, it, expect } from 'vitest';
import { resolveMediaCaption } from '../lib/media-caption.js';

describe('resolveMediaCaption', () => {
  it('captioned image: real filename + caption from body', () => {
    expect(resolveMediaCaption({ msgtype: 'm.image', filename: 'shot.png', body: 'look here' }))
      .toEqual({ filename: 'shot.png', caption: 'look here' });
  });

  it('captioned file: real filename (not caption) + caption', () => {
    expect(resolveMediaCaption({ msgtype: 'm.file', filename: 'doc.pdf', body: 'review' }))
      .toEqual({ filename: 'doc.pdf', caption: 'review' });
  });

  it('no caption: filename from body, caption null', () => {
    expect(resolveMediaCaption({ msgtype: 'm.image', body: 'photo.jpg' }))
      .toEqual({ filename: 'photo.jpg', caption: null });
  });

  it('formatted_body takes precedence, stripped to text', () => {
    expect(resolveMediaCaption({
      msgtype: 'm.image',
      filename: 'x.png',
      body: 'plain',
      format: 'org.matrix.custom.html',
      formatted_body: '<b>rich</b>',
    }).caption).toBe('rich');
  });
});
