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
pict.views.MyVideo.setVideo({ URL: 'https://host/talk.mp4', Title: 'The Talk', PosterURL: 'https://host/art.jpg' });
```

## Options

| Key | Default | Meaning |
|---|---|---|
| `VideoURL` | `false` | Initial video URL (or `false` for an empty player until `setVideo()`). |
| `PosterURL` | `false` | A poster image shown before playback (`<video poster>`). |
| `Title` | `''` | A human title (also the download filename hint). |
| `DownloadURL` / `DownloadName` | `false` / `''` | Explicit download href + filename hint (`DownloadURL` defaults to the video URL). |
| `AutoPlay` / `Loop` / `Muted` | `false` | Mapped straight onto the `<video>` element. |
| `Preload` | `'metadata'` | `'metadata'`, `'none'`, or `'auto'`. |
| `ShowToolbar` | `true` | Render the control bar. Set `false` when a host owns the chrome. |
| `ShowDownload` | `true` | Show the download affordance in the control bar. |
| `ShowFullscreen` | `true` | Show the maximize / restore button (fills the browser viewport; `Esc` exits). |
| `ClickToPlay` | `true` | Clicking the video toggles play/pause. |
| `PlaybackRates` | `[0.5, 1, 1.25, 1.5, 2]` | The rate cycle the speed button steps through. |
| `Volume` | `1` | Initial volume `0..1`. |
| `TargetElementAddress`, `DefaultDestinationAddress`, `RenderOnLoad` | — | Standard `pict-view` placement. |

## Public API

| Method | Does |
|---|---|
| `setVideo(urlOrDescriptor)` | Point the player at a video (`{ URL, PosterURL?, Title?, Name?, DownloadURL?, DownloadName? }`); resets to the start. |
| `play()` / `pause()` / `togglePlay()` | Playback control. |
| `seekTo(seconds)` | Seek to an absolute time (clamped to the duration). |
| `setVolume(0..1)` / `toggleMute()` | Volume control. |
| `setPlaybackRate(rate)` / `cyclePlaybackRate()` | Playback speed. |
| `toggleFullscreen()` / `enterFullscreen()` / `exitFullscreen()` / `isFullscreen()` | Fill the browser viewport, and back. |
| `getState()` | `{ URL, Loaded, Error, Playing, Duration, CurrentTime, Muted, Volume, PlaybackRate, Fullscreen }`. |
| `destroy()` | Detach handlers and clear the player. |

## Formats

The player hands the URL straight to a `<video>` element, so it plays whatever the host browser plays — the safe
web set is MP4 (H.264/AAC), WebM, and Ogg. A container a browser cannot decode (AVI, MKV, WMV, …) is the host's
problem to transcode; inside [`pict-section-fileview`](https://fable-retold.github.io/pict-section-fileview/) such
a file degrades to the download card rather than a dead player.

## Styling

All styling is the `.psv-*` CSS family defined in the view configuration's `CSS` and registered through the Pict
CSS cascade. Every color is wired through `pict-provider-theme` tokens (`var(--theme-color-*, fallback)`), so a
host using the theme provider gets a themed player automatically; append per-instance overrides via `CSSExtra`.
