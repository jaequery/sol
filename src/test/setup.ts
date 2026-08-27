import '@testing-library/jest-dom/vitest';

// jsdom has no object URLs and no rAF-driven media; stub just enough that the editor's
// browser-facing paths run without pulling in a canvas implementation.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:solcut-test';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
}
