# Configuration

Register the view with your Pict application, then point it at a video:

```javascript
const libPictSectionVideo = require('pict-section-video');

pict.addView('MyVideo', Object.assign({}, libPictSectionVideo.default_configuration,
    {
        DefaultDestinationAddress: '#SomeDiv',
        TargetElementAddress:      '#SomeDiv',
        VideoURL:                  'https://host/clip.mp4'
    }), libPictSectionVideo);

pict.views.MyVideo.render();
pict.views.MyVideo.setSource({ URL: 'https://host/talk.mp4', Title: 'The Talk', PosterURL: 'https://host/art.jpg' });
```

An adaptive (HLS) source adds a `Stream` — see [Adaptive streaming](streaming.md):

```javascript
pict.views.MyVideo.setSource(
    {
        URL: '/media/1a2b3c4d/master.m3u8', Title: 'Coast flight', Duration: 312, DownloadURL: null,
        Stream: { Type: 'hls', Manifest: '/media/1a2b3c4d/master.m3u8', Renditions: [ /* … */ ], ProgressiveURL: null }
    });
```

## Options

| Key | Default | Meaning |
|---|---|---|
| `VideoURL` | `false` | Initial video URL (or `false` for an empty player until `setSource()` / `setVideo()`). |
| `PosterURL` | `false` | A poster image shown before playback (`<video poster>`). |
| `Title` | `''` | A human title (also the download filename hint). |
| `DownloadURL` / `DownloadName` | `false` / `''` | Explicit download href + filename hint. Absent / `false` / `''` falls back to the playing URL (for an HLS source, `Stream.ProgressiveURL`); `null` means no download affordance anywhere. |
| `AutoPlay` / `Loop` / `Muted` | `false` | Mapped straight onto the `<video>` element. `AutoPlay` also starts hls.js loading as soon as the manifest parses. |
| `Preload` | `'metadata'` | `'metadata'`, `'none'` (nothing loads before play — share pages), or `'auto'` (also starts hls.js loading at once). |
| `ShowToolbar` | `true` | Render the control bar. Set `false` when a host owns the chrome. |
| `ShowDownload` | `true` | Show the download affordance in the control bar. |
| `ShowFullscreen` | `true` | Show the fullscreen button. |
| `ClickToPlay` | `true` | Clicking the video toggles play/pause. |
| `PlaybackRates` | `[0.5, 1, 1.25, 1.5, 2]` | The rate cycle the speed button steps through. |
| `Volume` | `1` | Initial volume `0..1`. |
| `HlsLibrary` | `null` | The hls.js class. `null` falls back to the page global `window.Hls`. **Never bundled or required** — the host supplies hls.js 1.7.4 light (`hls.light.min.js`). |
| `HlsConfig` | `{}` | Merged over the player's hls.js defaults `{ autoStartLoad:false, maxBufferLength:30, maxMaxBufferLength:60, capLevelToPlayerSize:true }`; host keys win. |
| `ShowQuality` | `true` | Show the quality menu (hidden anyway when a source has fewer than two rungs). |
| `ShowDataSaver` | `true` | Offer the Data saver entry in the quality menu. |
| `QualityStorageKey` | `'pict-section-video-quality'` | `localStorage` key holding `{ Quality, BandwidthEstimate }`. `''` disables persistence. |
| `SaverMaxHeight` | `540` | Data saver ceiling, as a short side in pixels. |
| `TargetElementAddress`, `DefaultDestinationAddress`, `RenderOnLoad` | — | Standard `pict-view` placement. |

## Public API

| Method | Does |
|---|---|
| `setSource(descriptor)` | `{ URL, Stream?, PosterURL?, Title?, Name?, DownloadURL?, DownloadName?, Duration? }` — resolve a playback path and load it; resets to the start. `Duration` (seconds) shows until metadata loads. |
| `setVideo(urlOrDescriptor)` | Shorthand: a string → `setSource({ URL })`; an object → `setSource(object)`. |
| `getStrategy()` | `'native-hls'` \| `'hls.js'` \| `'progressive'` \| `'unsupported'` (`''` before a load). |
| `getQualityLevels()` | `[{ Index, Height, Width, PixelHeight, Bandwidth, Label }]`, highest first (`Height` is the short side; `Label` like `'1080p · 6 Mbps'`). `[]` for a progressive file. |
| `setQuality(pick)` / `getQuality()` | `'auto'`, `'saver'`, or a short side such as `1080`; persisted under `QualityStorageKey`. `setQuality` returns `false` for a pick it does not understand. |
| `toggleQualityMenu()` | Open / close the quality menu. |
| `play()` / `pause()` / `togglePlay()` | Playback control. |
| `seekTo(seconds)` | Seek to an absolute time (clamped to the duration). Before hls.js has loaded anything it becomes the start position. |
| `setVolume(0..1)` / `toggleMute()` | Volume control. |
| `setPlaybackRate(rate)` / `cyclePlaybackRate()` | Playback speed. |
| `enterFullscreen()` / `exitFullscreen()` / `toggleFullscreen()` / `isFullscreen()` | Real fullscreen: `requestFullscreen()` on the player root, `webkitEnterFullscreen()` on the iPhone `<video>`, else the fill-the-viewport maximize. `enterFullscreen()` returns `true` when it acted (or already is fullscreen). |
| `getState()` | `{ URL, Loaded, Error, ErrorMessage, Playing, Duration, CurrentTime, Muted, Volume, PlaybackRate, Fullscreen, Strategy, Quality, PlayingHeight, Levels, Buffered, Waiting }`. |
| `destroy()` | Detach handlers, `hls.destroy()`, leave fullscreen, clear the player. |

## Formats

A progressive source goes straight to a `<video>` element, so it plays whatever the host browser plays — the safe
web set is MP4 (H.264/AAC), WebM, and Ogg. A container a browser cannot decode (AVI, MKV, WMV, …) is the host's
problem to transcode; inside [`pict-section-fileview`](https://fable-retold.github.io/pict-section-fileview/) such
a file degrades to the download card rather than a dead player. Adaptive sources are HLS with fMP4 segments —
see [Adaptive streaming](streaming.md).

## Styling

All styling is the `.psv-*` CSS family defined in the view configuration's `CSS` and registered through the Pict
CSS cascade. Every color is wired through `pict-provider-theme` tokens (`var(--theme-color-*, fallback)`), so a
host using the theme provider gets a themed player automatically; append per-instance overrides via `CSSExtra`.
The streaming additions are `.psv-quality-*` (button, popover, items), `.psv-spinner` (buffering) and
`.psv-seek-wrap` / `.psv-buffer-track` / `.psv-buffered` (the buffered bar under the seek track).
