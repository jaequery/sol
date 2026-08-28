import '@testing-library/jest-dom/vitest';

// jsdom has no object URLs and no rAF-driven media; stub just enough that the editor's
// browser-facing paths run without pulling in a canvas implementation.
let objectUrls = 0;
if (typeof URL.createObjectURL !== 'function') {
  // A real object URL is unique per blob, and so is this — two photos have to be tellable
  // apart, or a cross-asset request cannot be asserted on.
  URL.createObjectURL = () => `blob:solcut-test/${++objectUrls}`;
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
}
