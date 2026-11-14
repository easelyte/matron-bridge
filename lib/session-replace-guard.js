export const INFLIGHT_MEDIA_REPLACE_REFUSAL =
  'An attachment is still being processed. Try again in a moment.';

export function inflightMediaReplaceRefusal(hasInflightMedia) {
  return hasInflightMedia
    ? { refuse: true, message: INFLIGHT_MEDIA_REPLACE_REFUSAL }
    : { refuse: false };
}
