# Adaptive streaming

`pict-section-video` plays HLS ladders (fMP4, one byte-ranged `media.mp4` per rung, muxed AAC — the
`retold-media-ladder` package format) as well as plain files. A source opts in by carrying a `Stream`:

```javascript
view.setSource(
    {
        URL:         '/media/1a2b3c4d/master.m3u8',
        Title:       'Coast flight',
        PosterURL:   '/media/1a2b3c4d/poster.jpg',
        Duration:    312,
        DownloadURL: null,
        Stream:
        {
            Type:           'hls',
            Manifest:       '/media/1a2b3c4d/master.m3u8',
            Renditions:
            [
                { Name: '1080p', ShortSide: 1080, Width: 1920, Height: 1080, Bandwidth: 6234000,
                  Codecs: 'avc1.640028,mp4a.40.2', Playlist: '/media/1a2b3c4d/v0/index.m3u8' }
                // … 720p, 540p, 360p
            ],
            ProgressiveURL: null
        }
    });
```

Inside `pict-section-fileview` this descriptor comes from `descriptorFromMediaPackage(package, baseURL, options)`,
and the `VideoRenderer` forwards it through `setSource()`.

## hls.js is host-supplied

The player never bundles or `require()`s hls.js — `pict-view` stays its only runtime dependency. The supported
build is **hls.js 1.7.4, light** (`node_modules/hls.js/dist/hls.light.min.js`, ~120 KB gzip). The light build
drops alternate audio groups, `EXT-X-DEFINE` variable substitution and I-frame trick play — none of which the
ladder packages use.

```html
<script src="./hls.light.min.js"></script>
```

The player resolves the class as `options.HlsLibrary`, else `window.Hls`, else none. With none, HLS still plays
where the browser handles it natively (Safari, iOS), and otherwise falls back to `Stream.ProgressiveURL`.

## Choosing a path

`Pict-Section-Video-Strategy.js` is pure (no DOM, timers or storage):

```
resolveStrategy(pSource, pVideoElement, pHls, pWindow) →
  'native-hls'   isHls && canPlayType(HLS) && ('ManagedMediaSource' in window)     // Safari
  'hls.js'       isHls && Hls.isSupported()                                        // Chrome, Firefox, Edge
  'native-hls'   isHls && canPlayType(HLS)                                         // iOS before 17.1
  'progressive'  (isHls && Stream.ProgressiveURL) || !isHls
  'unsupported'  otherwise → error state
```

`canPlayType` answering `''` (or `'no'`) counts as false; `'maybe'` / `'probably'` as true. hls.js is preferred
over a bare `canPlayType` "maybe" because Chrome answers it but "may fail to play certain assets" (hls.js README).
On Safari native HLS wins even when hls.js is present: AirPlay, Picture-in-Picture, the lock screen and native
fullscreen come free, and AirPlay receivers inherit the path token in the playlist URL.

## hls.js configuration

```
{ autoStartLoad: false,                        // manifest on mount; startLoad() on the first play
  maxBufferLength: 30, maxMaxBufferLength: 60, // ~30 s ahead, not minutes
  capLevelToPlayerSize: true }                 // a portrait phone never pulls 1080p
```

The `<video>` box fills the stage and letterboxes the frame (`width/height:100%; object-fit:contain`). The
player-size capper measures that box (times `devicePixelRatio`); a box sized to the frame it decodes would cap Auto
at the starting rung on 1x screens (and at 360p before metadata, when an empty `<video>` is 300x150).

`HlsConfig` is merged on top (host keys win). The first play — the play button, a tap on the `<video>`, autoplay
or the OS media keys (the `<video>`'s `play` event) — calls `startLoad()`. `AutoPlay` and `Preload:'auto'` start
loading as soon as the manifest parses. A `seekTo()` before loading starts becomes the `startLoad()` position.

**Start level.** A first visit leaves `startLevel` unset, so hls.js starts on `hls.firstLevel` — the master's first
variant, which the ladder reorders to the ~540p rung (as Safari does). Once a media fragment has been measured
over the network, the bandwidth estimate is saved beside the quality pick, and later visits add
`{ startLevel: -1, testBandwidth: false, abrEwmaDefaultEstimate: <saved> }`. hls.js's own default estimate is
never persisted (it would start every later visit on 360p).

**What counts as a measurement.** hls.js samples every buffered main fragment, including ones the browser served
from its HTTP cache (the package's media is `immutable`) or over loopback. Its estimator floors a sample at
min(50 ms, bytes / 100000), so a 4.9 MB fragment read from the cache in a few milliseconds counts as ~800 Mbps, and a
saved value like that would start every later visit on the top rung whatever its real connection. The player
therefore uses the pure `Strategy.fragmentNetworkBandwidth(data, performance)` to measure each fragment itself (first
byte to last, the span hls.js's own loader reports throughput over). It ignores a fragment that loaded faster than
the hls.js floor, or that Resource Timing reports as a cache hit (`transferSize` 0 with a body, matched to that
load's time window). What it persists, `Strategy.persistableEstimate(hls.bandwidthEstimate, peak)`, is hls.js's
smoothed estimate held to the fastest fragment that really crossed the network this session, because hls.js keeps
cache hits in its average for a while. A session with no network-measured fragment saves nothing, and the next
visit starts like a first one.

A real fast network still seeds the next visit, as designed. If that visit is on a slower network, hls.js's
emergency-abandon rule drops a rung mid-fragment.

## The quality menu

The **Quality** button sits after the speed button; it hides when the source has fewer than two rungs, for a
progressive file, after an error, or with `ShowQuality:false`. It opens a `role=menu` popover of
`menuitemradio` entries:

| Entry | hls.js | Native HLS |
|---|---|---|
| **Auto (720p)** | `currentLevel` / `nextLevel` = -1; the label follows `LEVEL_SWITCHED`. Before loading starts it writes no level (hls.js would keep a -1 there as `startLevel` -1, a bitrate test on the lowest rung) unless an earlier pick seeded `startLevel`, which it puts back to hls.js's own start (`config.startLevel`, else `firstAutoLevel`). `autoLevelCapping` is left to hls.js's player-size capper, which recomputes it only when its ResizeObserver fires (hls.js 1.7+), so the player never overwrites it; leaving Data saver restarts the capper instead | loads the master; the label follows `videoHeight` on `resize` |
| **1080p · 6 Mbps** (one per rung, by short side) | `nextLevel` while playing (switches at the next fragment, no restart); `currentLevel` while paused; before loading starts it also seeds `startLevel` | loads that rung's `Playlist`, keeping the position and play state |
| **Data saver** | `autoLevelCapping` = the rung `<= SaverMaxHeight` (the player-size capper is paused meanwhile, since it rewrites the cap; leaving saver restarts it directly through `capLevelController.startCapping()`, because hls.js 1.7.x's `capLevelToPlayerSize = true` setter does not) | loads the `<= SaverMaxHeight` rung's playlist |

Keyboard: ArrowDown / ArrowUp on the button open the menu on the first / last entry; inside it ArrowDown / ArrowUp
move (wrapping), Home / End jump, `Esc` closes back to the button (without also leaving a maximized player), Tab
closes. A pointerdown anywhere outside closes it.

The pick (`'auto'`, `'saver'` or a short side) persists in `localStorage` as
`{ "Quality": 720, "BandwidthEstimate": 4200000 }` under `QualityStorageKey`, and is restored when the next player
is constructed — applied when the manifest parses (hls.js) or by loading that rung's playlist directly (native).
Every storage access is wrapped in try/catch: private mode, opaque origins and full quotas only lose persistence.
An explicit pick for a rung the source lacks lands on the closest rung below it.

## Errors and the fallback ladder

| Failure | Response |
|---|---|
| hls.js `NETWORK_ERROR` carrying HTTP 401, 403, 404 or 410 (fatal or not) | "This link has expired or been revoked." — no retries |
| Other fatal hls.js `NETWORK_ERROR` | `startLoad()` (or `loadSource()` when the manifest itself failed) up to 3 times; a buffered fragment resets the budget |
| Fatal hls.js `MEDIA_ERROR`, or the `<video>` erroring under hls.js | `recoverMediaError()` once |
| Anything else fatal, or the budget spent | native HLS (when `canPlayType` passes) → `Stream.ProgressiveURL` → the error state |
| A native-HLS `<video>` error | `Stream.ProgressiveURL` → the error state |

Each step keeps the reader's position and play state. Non-fatal hls.js errors are left to hls.js. Native HLS cannot
see HTTP statuses, so an expired link there shows the generic "This video could not be played."

The error state's download link follows the same `DownloadURL` rule as the control bar: `null` shows none.

## Download links

| `DownloadURL` | Control bar + error state |
|---|---|
| absent / `''` / `false` | the playing URL — for an HLS source `Stream.ProgressiveURL` (never the playlist), else nothing |
| `null` | no download affordance anywhere |
| a non-empty string | that URL |
