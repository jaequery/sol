/**
 * Media-element plumbing for component tests.
 *
 * jsdom's HTMLMediaElement never loads anything: no metadata, no events, and a
 * `currentTime` that nothing advances. These helpers stand in for the media pipeline —
 * define the readiness fields a test needs and fire the events a real element would.
 */

export function setMediaState(
  el: HTMLMediaElement,
  state: Partial<Pick<HTMLMediaElement, 'readyState' | 'duration' | 'seeking' | 'ended'>>,
): void {
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(el, key, { configurable: true, value });
  }
}

export function fireMedia(el: HTMLMediaElement, type: string): void {
  el.dispatchEvent(new Event(type));
}
