import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Preview } from './Preview';
import { useEditor } from '../state/store';
import { resetEditor } from '../test/harness';
import { fireMedia, setMediaState } from '../test/media';
import type { Clip, MediaAsset } from '../types/project';

const photoAsset: MediaAsset = {
  id: 'asset-p',
  name: 'sunrise.jpg',
  kind: 'photo',
  path: '/media/sunrise.jpg',
  src: 'blob:photo',
  sizeBytes: 1,
};
const videoAsset: MediaAsset = {
  id: 'asset-v',
  name: 'transition.mp4',
  kind: 'video',
  path: '/media/transition.mp4',
  src: 'blob:video',
  sizeBytes: 1,
};

const photo: Clip = {
  id: 'p1',
  assetId: photoAsset.id,
  kind: 'photo',
  name: photoAsset.name,
  startMs: 0,
  durationMs: 3000,
  trimStartMs: 0,
};
const video: Clip = {
  id: 'v1',
  assetId: videoAsset.id,
  kind: 'video',
  name: videoAsset.name,
  startMs: 3000,
  durationMs: 5000,
  trimStartMs: 1000,
};

function seed(playheadMs: number) {
  useEditor.setState({
    assets: { [photoAsset.id]: photoAsset, [videoAsset.id]: videoAsset },
    clips: [photo, video],
    playheadMs,
  });
}

beforeEach(() => {
  resetEditor();
});

describe('Preview premounting', () => {
  it('mounts the upcoming video hidden and primed while a photo is showing', () => {
    seed(1000);
    render(<Preview />);

    const next = screen.getByTestId<HTMLVideoElement>('preview-video-next');
    expect(next).toHaveAttribute('src', videoAsset.src);
    expect(next.className).toContain('canvas__preload');
    expect(screen.queryByTestId('preview-video')).not.toBeInTheDocument();

    // Priming waits for metadata, then parks the element at its in-point.
    expect(next.currentTime).toBe(0);
    setMediaState(next, { readyState: 1 });
    fireMedia(next, 'loadedmetadata');
    expect(next.currentTime).toBeCloseTo(video.trimStartMs / 1000);
  });

  it('hands the same DOM node over when the playhead crosses into the clip', () => {
    seed(1000);
    render(<Preview />);
    const primed = screen.getByTestId('preview-video-next');

    act(() => useEditor.getState().setPlayhead(4000));

    const active = screen.getByTestId('preview-video');
    expect(active).toBe(primed);
    expect(active.className).not.toContain('canvas__preload');
    expect(screen.queryByTestId('preview-video-next')).not.toBeInTheDocument();
  });

  it('starts playback with a single play call, not one per tick', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    seed(4000);
    render(<Preview />);

    act(() => useEditor.setState({ playing: true }));
    expect(play).toHaveBeenCalledTimes(1);

    // Sixty playhead ticks later it still has not been asked again.
    for (let i = 1; i <= 60; i++) {
      act(() => useEditor.getState().advance(16));
    }
    expect(play).toHaveBeenCalledTimes(1);

    act(() => useEditor.setState({ playing: false }));
    act(() => useEditor.setState({ playing: true }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('still shows the gap and the photo exactly as before', () => {
    useEditor.setState({
      assets: { [photoAsset.id]: photoAsset, [videoAsset.id]: videoAsset },
      clips: [photo, { ...video, startMs: 5000 }],
      playheadMs: 4000,
    });
    render(<Preview />);

    expect(screen.getByTestId('preview-gap')).toBeInTheDocument();
    act(() => useEditor.getState().setPlayhead(1000));
    expect(screen.getByAltText(photoAsset.name)).toHaveAttribute('src', photoAsset.src);
  });
});
