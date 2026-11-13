# Pict Section Video

> Bespoke video player section for Pict — play, seek, volume, rate, fullscreen.

- **Bespoke control bar** — play/pause, a seek scrubber with a buffered bar, time readouts, mute + volume, a playback-rate cycle, a quality menu, download, fullscreen
- **Scrubs over native HTTP Range** — seeking jumps without downloading the whole clip
- **Adaptive streaming** — HLS natively on Safari, host-supplied hls.js 1.7.4 light elsewhere; Auto / per-rung / Data saver picks that persist
- **Poster + click-to-play** — a poster frame before playback; click the video to toggle play
- **Real fullscreen** — the Fullscreen API, the iPhone native player, or a fill-the-viewport fallback
- **Self-contained** — one `pict-view`, built-once imperative `<video>`; multiple players coexist on a page
- **Embeddable** — standalone, or the video lens inside `pict-section-fileview`

[Overview](README.md)
[Configuration](configuration.md)
[Adaptive Streaming](streaming.md)
[Architecture](architecture.md)
[GitHub](https://github.com/fable-retold/pict-section-video)

<!-- docuserve:examples:start -->
| Example | Complexity | Launch |
|---------|------------|--------|
| [Video Player](examples/video%5Fplayer/README.md) | Basic | [Launch](examples/video%5Fplayer/index.html) |
<!-- docuserve:examples:end -->
