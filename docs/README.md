# pict-section-video

A bespoke, responsive **video player** section for the Retold/Pict ecosystem. Point it at a video URL and it fits
the whole frame to its stage on phones, tablets, desktops, TVs, and projected displays — with its own control bar
(play/pause, a seek scrubber, a time readout, mute + volume, a playback-rate cycle, download, and maximize).
Seeking rides the browser's native HTTP **Range** requests, so a range-served file (an
[`orator-file-service`](https://github.com/fable-retold/orator-file-service) route, a Sluice depot, a bare 206 URL)
scrubs without downloading the whole clip.

It is a single [`pict-view`](https://github.com/fable-retold/pict-view) in the lightweight single-view shape
(like `pict-section-image`): a stub container template, with the player DOM built imperatively — a `<video>` is
inherently imperative (its `src`, buffered/seekable ranges, and the `loadedmetadata`/`timeupdate`/`play`/`pause`
events have no template equivalent).

Usable on its own, or driven as the video renderer inside
[`pict-section-fileview`](https://github.com/fable-retold/pict-section-fileview).

## Install

```bash
npm install pict-section-video
```

The only hard dependency is `pict-view`.

## Usage

```javascript
const libPictSectionVideo = require('pict-section-video');

pict.addView('MyVideo', Object.assign({}, libPictSectionVideo.default_configuration,
    {
        DefaultDestinationAddress: '#SomeDiv',
        TargetElementAddress:      '#SomeDiv',
        VideoURL:                  'https://host/clip.mp4'
    }), libPictSectionVideo);

pict.views.MyVideo.render();

// …or point it at a video later:
pict.views.MyVideo.setVideo('https://host/other.webm');
pict.views.MyVideo.setVideo({ URL: 'https://host/talk.mp4', Title: 'The Talk', PosterURL: 'https://host/art.jpg' });
```

### Configuration

| Key | Meaning |
|---|---|
| `VideoURL` | Initial video URL (or `false` for an empty player until `setVideo()`). |
| `PosterURL` | A poster image shown before playback (`<video poster>`). |
| `Title` | A human title (used as the download filename hint). |
| `DownloadURL` / `DownloadName` | Explicit download href + filename hint (`DownloadURL` defaults to the video URL). |
| `AutoPlay` / `Loop` / `Muted` | Mapped onto the `<video>` element (defaults off). |
| `Preload` | `'metadata'` (default), `'none'`, or `'auto'`. |
| `ShowToolbar` | Render the control bar (default on). Set `false` when a host owns the chrome. |
| `ShowDownload` | Show the download affordance in the control bar (default on). |
| `ShowFullscreen` | Show the maximize / restore button — fills the browser viewport and back; `Esc` exits (default on). |
| `ClickToPlay` | Clicking the video toggles play/pause (default on). |
| `PlaybackRates` | The rate cycle the speed button steps through (default `[0.5, 1, 1.25, 1.5, 2]`). |
| `Volume` | Initial volume `0..1` (default `1`). |
| `TargetElementAddress`, `DefaultDestinationAddress`, `RenderOnLoad` | Standard pict-view placement. |

### Public API

| Method | Does |
|---|---|
| `setVideo(urlOrDescriptor)` | Point the player at a video; resets to the start. |
| `play()` / `pause()` / `togglePlay()` | Playback control. |
| `seekTo(seconds)` | Seek to an absolute time (clamped to the duration). |
| `setVolume(0..1)` / `toggleMute()` | Volume control. |
| `setPlaybackRate(rate)` / `cyclePlaybackRate()` | Playback speed. |
| `toggleFullscreen()` / `enterFullscreen()` / `exitFullscreen()` / `isFullscreen()` | Fill the browser viewport, and back. `Esc` also exits. |
| `getState()` | `{ URL, Loaded, Error, Playing, Duration, CurrentTime, Muted, Volume, PlaybackRate, Fullscreen }`. |
| `destroy()` | Detach handlers and clear the player. |

### Formats

The player hands the URL straight to a `<video>` element, so it plays whatever the host browser plays — the safe
web set is MP4 (H.264/AAC), WebM and Ogg. A container a browser cannot decode (AVI, MKV, WMV, …) is the host's
problem to transcode; inside `pict-section-fileview` such a file degrades to the download card rather than a dead
player.

## Examples

`example_applications/video_player` is a runnable demo: standalone players for a couple of clips, each with the
full control bar, independent on one page.

```bash
cd example_applications/video_player && npm run build   # build the example's browser bundle
npm run example-serve   # (from the module root) serve at http://localhost:<port>/video_player/dist/index.html
```

## Development

```bash
npm test        # Mocha TDD via quackage (real jsdom document)
npm run build   # browser bundle via quackage
```

MIT © Steven Velozo
