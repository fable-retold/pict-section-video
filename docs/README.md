# pict-section-video

A bespoke, responsive **video player** section for the Retold/Pict ecosystem. Point it at a video URL and it fits
the whole frame to its stage on phones, tablets, desktops, TVs, and projected displays — with its own control bar
(play/pause, a seek scrubber with a buffered bar, a time readout, mute + volume, a playback-rate cycle, a quality
menu, download, and fullscreen). Seeking rides the browser's native HTTP **Range** requests, so a range-served file
(an [`orator-file-service`](https://github.com/fable-retold/orator-file-service) route, a Sluice depot, a bare 206
URL) scrubs without downloading the whole clip.

It also plays **adaptive (HLS) streams**: natively on Safari (AirPlay, PiP, the lock screen and native fullscreen
come free) and through a **host-supplied [hls.js](https://github.com/video-dev/hls.js) 1.7.4 light** build
everywhere else, with an Auto / per-rung / Data-saver quality menu that remembers the reader's pick.

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

The only hard dependency is `pict-view`. **hls.js is never bundled or required** — see
[Adaptive streaming](#adaptive-streaming-hls) for how a host supplies it.

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
pict.views.MyVideo.setSource({ URL: 'https://host/talk.mp4', Title: 'The Talk', PosterURL: 'https://host/art.jpg' });
```

## Adaptive streaming (HLS)

Hand `setSource()` a descriptor with a `Stream` (the shape `pict-section-fileview`'s `descriptorFromMediaPackage()`
builds from a `retold-media-ladder` package):

```javascript
pict.views.MyVideo.setSource(
    {
        URL:         '/media/1a2b3c4d/master.m3u8',
        Title:       'Coast flight',
        PosterURL:   '/media/1a2b3c4d/poster.jpg',
        Duration:    312,            // seconds; shown until metadata loads
        DownloadURL: null,           // null = no download affordance anywhere
        Stream:
        {
            Type:           'hls',
            Manifest:       '/media/1a2b3c4d/master.m3u8',
            Renditions:     [ { Name: '1080p', ShortSide: 1080, Width: 1920, Height: 1080, Bandwidth: 6234000,
                                Playlist: '/media/1a2b3c4d/v0/index.m3u8' } /* … */ ],
            ProgressiveURL: null     // '/media/1a2b3c4d/download.mp4' when downloads are allowed
        }
    });
```

### Supplying hls.js (host-side)

hls.js **1.7.4, light build** (`hls.light.min.js`, ~120 KB gzip) is the supported version. The host loads it and
either passes the class in config or leaves it on the page global:

```html
<script src="./hls.light.min.js"></script>   <!-- copied from node_modules/hls.js/dist/ -->
```

```javascript
// Either: config (wins) …
pict.addView('MyVideo', Object.assign({}, libPictSectionVideo.default_configuration,
    { HlsLibrary: window.Hls, HlsConfig: { maxBufferLength: 20 } }), libPictSectionVideo);
// … or: nothing — the player falls back to window.Hls.
```

The light build is enough because ladder packages mux audio into each rung (no alternate audio groups) and need no
`EXT-X-DEFINE`. Without hls.js the player still plays HLS where the browser does natively, and otherwise falls
back to `Stream.ProgressiveURL`.

### How a playback path is chosen

`source/Pict-Section-Video-Strategy.js` is a pure resolver (`resolveStrategy(source, video, Hls, window)`):

| Browser | Strategy |
|---|---|
| `canPlayType('application/vnd.apple.mpegurl')` **and** `'ManagedMediaSource' in window` (Safari) | `native-hls` |
| hls.js present and `Hls.isSupported()` (Chrome, Firefox, Edge) | `hls.js` |
| `canPlayType` passes, no MMS, no hls.js (iOS before 17.1) | `native-hls` |
| No HLS path but `Stream.ProgressiveURL` — or a plain (non-`Stream`) source | `progressive` |
| Nothing | `unsupported` (error state) |

Under hls.js the player merges `HlsConfig` over `{ autoStartLoad:false, maxBufferLength:30, maxMaxBufferLength:60,
capLevelToPlayerSize:true }`: the manifest loads on mount, fragments only on the first play (from the play button,
the `<video>` itself, autoplay or the OS media keys). A first visit leaves `startLevel` unset (hls.js starts on the
master's first variant — the ladder puts the ~540p rung there); once a fragment has been measured over the
network the bandwidth estimate is saved beside the quality pick and later visits start with
`{ startLevel:-1, testBandwidth:false, abrEwmaDefaultEstimate:<saved> }`. A fragment served from the HTTP cache or
over loopback is not a measurement (hls.js reads one as ~800 Mbps), and the saved value never exceeds the fastest
fragment that actually crossed the network.

The `<video>` box fills the stage and letterboxes the frame (`width/height:100%; object-fit:contain`), so
`capLevelToPlayerSize` measures the player, not the rung being decoded, and Auto can climb past its starting rung.

### Quality menu

A **Quality** button after the speed button opens a `role=menu` popover (arrow keys, Home/End, `Esc`):

- **Auto (720p)** — adaptive; the label follows hls.js `LEVEL_SWITCHED`, or the `<video>`'s `videoHeight` on
  `resize` under native HLS.
- **One entry per rung** — `1080p · 6 Mbps`, named by the short side (a portrait 1080×1920 rung is `1080p`).
  Under hls.js a pick sets `hls.nextLevel` while playing (the next fragment switches — no restart) or
  `hls.currentLevel` while paused. Under native HLS it loads that rung's `Playlist` at the same position.
- **Data saver** — caps hls.js `autoLevelCapping` at the rung `<= SaverMaxHeight` (540), or loads that rung's
  playlist under native HLS.

The pick persists in `localStorage` under `QualityStorageKey` (every access guarded — private mode and disabled
storage just keep the pick in memory). The button hides when a source has fewer than two rungs, for a progressive
file, or with `ShowQuality:false`.

### Errors and fallback

| Failure | Response |
|---|---|
| hls.js `NETWORK_ERROR` with HTTP 401 / 403 / 404 / 410 | Error state: "This link has expired or been revoked." |
| Other fatal hls.js network error | Retry (`startLoad()`, or `loadSource()` before the manifest parsed) up to 3×, then fall back |
| Fatal hls.js `MEDIA_ERROR` (or a `<video>` error under hls.js) | `recoverMediaError()` once, then fall back |
| Anything else, or retries exhausted | Native HLS (if `canPlayType` passes) → `Stream.ProgressiveURL` → error state |

The reader's position carries across every fallback step. `destroy()` calls `hls.destroy()`.

### Download links

| `DownloadURL` | Control bar + error state |
|---|---|
| absent / `''` / `false` | The playing URL — for an HLS source, `Stream.ProgressiveURL` (never the playlist), else nothing |
| `null` | **No download affordance anywhere** (control bar and error-state link) |
| a non-empty string | That URL |

## Mobile

- **Fullscreen** is real: `requestFullscreen()` on the player root (desktop, Android, iPad), `webkitEnterFullscreen()`
  on the `<video>` on iPhone (the native player), and the fill-the-viewport CSS maximize where neither exists (or
  the request is refused). `fullscreenchange` / `webkitendfullscreen` keep `isFullscreen()` honest — including an
  exit made while the `requestFullscreen()` is still in flight, which is undone as soon as the request lands.
- **Buffering**: `waiting` / `seeking` raise a spinner, `playing` / `canplay` / `seeked` lower it, and `progress`
  grows a buffered bar under the seek track.
- **Volume**: iOS ignores scripted volume writes, so the volume slider hides there (mute still works).
- `playsinline` keeps iPhone playback inline until the reader asks for fullscreen.

## Configuration

| Key | Meaning |
|---|---|
| `VideoURL` | Initial video URL (or `false` for an empty player until `setSource()` / `setVideo()`). |
| `PosterURL` | A poster image shown before playback (`<video poster>`). |
| `Title` | A human title (used as the download filename hint). |
| `DownloadURL` / `DownloadName` | Explicit download href + filename hint. Absent falls back to the playing URL; `null` = no download anywhere. |
| `AutoPlay` / `Loop` / `Muted` | Mapped onto the `<video>` element (defaults off). |
| `Preload` | `'metadata'` (default), `'none'` (share pages: nothing loads before play), or `'auto'` (also starts hls.js loading at once). |
| `ShowToolbar` | Render the control bar (default on). Set `false` when a host owns the chrome. |
| `ShowDownload` | Show the download affordance in the control bar (default on). |
| `ShowFullscreen` | Show the fullscreen button (default on). |
| `ClickToPlay` | Clicking the video toggles play/pause (default on). |
| `PlaybackRates` | The rate cycle the speed button steps through (default `[0.5, 1, 1.25, 1.5, 2]`). |
| `Volume` | Initial volume `0..1` (default `1`). |
| `HlsLibrary` | The hls.js class (default `null` → `window.Hls`). Never bundled. |
| `HlsConfig` | Merged over the player's hls.js defaults (default `{}`; host keys win). |
| `ShowQuality` | Show the quality menu (default on; hidden anyway with fewer than two rungs). |
| `ShowDataSaver` | Offer the Data saver entry (default on). |
| `QualityStorageKey` | `localStorage` key for the pick + bandwidth estimate (default `'pict-section-video-quality'`; `''` disables). |
| `SaverMaxHeight` | Data saver ceiling as a short side in pixels (default `540`). |
| `TargetElementAddress`, `DefaultDestinationAddress`, `RenderOnLoad` | Standard pict-view placement. |

## Public API

| Method | Does |
|---|---|
| `setSource(descriptor)` | Point the player at `{ URL, Stream?, PosterURL?, Title?, Name?, DownloadURL?, DownloadName?, Duration? }` and pick its playback path; resets to the start. For HLS the played URL is `Stream.Manifest \|\| URL`. |
| `setVideo(urlOrDescriptor)` | Shorthand: a string → `setSource({ URL })`, an object → `setSource(object)`. |
| `getStrategy()` | `'native-hls'`, `'hls.js'`, `'progressive'`, `'unsupported'` (`''` before a load). |
| `getQualityLevels()` | `[{ Index, Height (short side), Width, PixelHeight, Bandwidth, Label }]`, highest first; `[]` for progressive. |
| `setQuality('auto' \| 'saver' \| shortSide)` / `getQuality()` | Pick (and persist) a quality. |
| `toggleQualityMenu()` | Open / close the quality menu. |
| `play()` / `pause()` / `togglePlay()` | Playback control. |
| `seekTo(seconds)` | Seek to an absolute time (clamped to the duration). |
| `setVolume(0..1)` / `toggleMute()` | Volume control. |
| `setPlaybackRate(rate)` / `cyclePlaybackRate()` | Playback speed. |
| `enterFullscreen()` / `exitFullscreen()` / `toggleFullscreen()` / `isFullscreen()` | Real fullscreen (see Mobile); `enterFullscreen()` returns `true` when it acted (or already is fullscreen). |
| `getState()` | `{ URL, Loaded, Error, ErrorMessage, Playing, Duration, CurrentTime, Muted, Volume, PlaybackRate, Fullscreen, Strategy, Quality, PlayingHeight, Levels, Buffered, Waiting }`. |
| `destroy()` | Detach handlers, tear down hls.js, leave fullscreen and clear the player. |

The strategy module is also exported as `require('pict-section-video').Strategy` (`resolveStrategy`,
`progressiveURL`, `HLS_MIME`, the quality-ladder helpers, and the saved-estimate helpers `fragmentNetworkBandwidth`
and `persistableEstimate`).

## Formats

A progressive source goes straight to a `<video>` element, so it plays whatever the host browser plays — the safe
web set is MP4 (H.264/AAC), WebM and Ogg. A container a browser cannot decode (AVI, MKV, WMV, …) is the host's
problem to transcode; inside `pict-section-fileview` such a file degrades to the download card rather than a dead
player. Adaptive sources are HLS with fMP4 segments (see above).

## Examples

`example_applications/video_player` is a runnable demo: standalone players for a couple of clips, each with the
full control bar, independent on one page.

```bash
cd example_applications/video_player && npm run build   # build the example's browser bundle
npm run example-serve   # (from the module root) serve at http://localhost:<port>/video_player/dist/index.html
```

## Development

```bash
npm test        # Mocha TDD via quackage (real jsdom document; a FakeHls stands in for hls.js)
npm run build   # browser bundle via quackage
```

MIT © Steven Velozo
