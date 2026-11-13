module.exports = (
{
	"RenderOnLoad": true,

	"DefaultRenderable": "VideoPlayer-Wrap",
	"DefaultDestinationAddress": "#VideoPlayer-Container-Div",

	"Templates":
	[
		{
			"Hash": "VideoPlayer-Container",
			// A stub — the player DOM is built imperatively in onAfterInitialRender (a <video> is an inherently
			// imperative element: its src, buffered/seekable ranges and the load/timeupdate/play/pause/error events
			// have no template equivalent). This mirrors pict-section-image / pict-section-code.
			"Template": "<!-- VideoPlayer-Container rendering soon -->"
		}
	],

	"Renderables":
	[
		{
			"RenderableHash": "VideoPlayer-Wrap",
			"TemplateHash": "VideoPlayer-Container",
			"DestinationAddress": "#VideoPlayer-Container-Div"
		}
	],

	// The element the player DOM is built into (defaults to the same div the stub renders into).
	"TargetElementAddress": "#VideoPlayer-Container-Div",

	// The initial video: a URL string, or false for an empty player until setVideo() is called.
	"VideoURL": false,
	// A poster image shown before playback (the <video poster> attribute).
	"PosterURL": false,
	// A human title shown by the player and used as the download filename hint.
	"Title": "",
	// An explicit download href + filename hint. Absent / false / '' falls back to the playing URL (for an HLS source,
	// its Stream.ProgressiveURL); null means NO download affordance anywhere (control bar and error state).
	"DownloadURL": false,
	"DownloadName": "",

	// Playback toggles (mapped straight onto the <video> element).
	"AutoPlay": false,
	"Loop": false,
	"Muted": false,
	// 'metadata' fetches just enough to learn duration + dimensions (the right default for a range-served file);
	// 'none' defers all network until play; 'auto' lets the browser buffer ahead.
	"Preload": "metadata",

	// Chrome + behavior toggles.
	"ShowToolbar": true,       // the bespoke control bar (play / seek / time / volume / rate / download)
	"ShowDownload": true,      // the download affordance in the control bar
	"ShowFullscreen": true,    // the maximize/restore button (fills the browser viewport and back; Esc exits)
	"ClickToPlay": true,       // clicking the video toggles play/pause

	// The playback-rate cycle the rate button steps through (1x is the resting value).
	"PlaybackRates": [ 0.5, 1, 1.25, 1.5, 2 ],
	// Initial volume (0..1).
	"Volume": 1,

	// Adaptive streaming (HLS). A source carrying Stream:{ Type:'hls', Manifest, Renditions, ProgressiveURL } plays
	// natively on Safari and through hls.js elsewhere. hls.js is NEVER bundled or required: the host supplies it
	// (hls.js 1.7.4 light, `hls.light.min.js`) either here or as the page global window.Hls.
	"HlsLibrary": null,
	// Merged over the player's hls.js defaults ({ autoStartLoad:false, maxBufferLength:30, maxMaxBufferLength:60,
	// capLevelToPlayerSize:true }); host keys win.
	"HlsConfig": {},
	// The quality menu (Auto / one entry per rung / Data saver) — hidden anyway when a source has fewer than two rungs.
	"ShowQuality": true,
	// Offer the Data saver entry (caps adaptive playback at SaverMaxHeight).
	"ShowDataSaver": true,
	// localStorage key the quality pick (and the last bandwidth estimate) persist under; '' / false disables it.
	"QualityStorageKey": "pict-section-video-quality",
	// Data saver ceiling, as a short side in pixels (540 → the 540p rung or the closest one below it).
	"SaverMaxHeight": 540,

	"CSS": `.psv-root
{
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
	width: 100%;
	box-sizing: border-box;
	background: var(--theme-color-background-panel, #ffffff);
	color: var(--theme-color-text-primary, #1f2733);
}
/* Maximized: the player leaves its host box and fills the browser viewport. Esc or the toolbar button restores it. */
.psv-root.psv-fullscreen
{
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	left: 0;
	width: 100vw;
	height: 100vh;
	border-radius: 0;
	z-index: 2147483000;
}
.psv-stage
{
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	background: #000;
}
/* The <video> box fills the stage and letterboxes the frame inside it (object-fit). A width/height:auto box would be
	exactly as big as the rung it decodes (300x150 before metadata), so hls.js capLevelToPlayerSize would measure the
	frame, not the player, and pin Auto at the starting rung; it would also leave the frame unscaled in fullscreen. */
.psv-video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; cursor: pointer; }
.psv-loading, .psv-error
{
	position: absolute;
	margin: auto;
	text-align: center;
	color: var(--theme-color-text-on-dark, #e8ebf0);
	padding: 1.6rem 1rem;
	font-size: 0.9rem;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.55rem;
}
.psv-error-glyph { font-size: 1.8rem; opacity: 0.7; }
.psv-controls
{
	display: flex;
	align-items: center;
	gap: 0.5rem;
	flex: 0 0 auto;
	padding: 0.45rem 0.7rem;
	border-top: 1px solid var(--theme-color-border-light, #e8ebf0);
	background: var(--theme-color-background-secondary, #f7f9fb);
}
.psv-spacer { flex: 1 1 auto; }
.psv-btn
{
	font-size: 0.8rem;
	font-weight: 600;
	padding: 0.3rem 0.5rem;
	min-width: 2rem;
	border-radius: 6px;
	border: 1px solid var(--theme-color-border-medium, #d5dbe3);
	background: var(--theme-color-background-panel, #ffffff);
	color: var(--theme-color-text-secondary, #45505f);
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 0.3rem;
	text-decoration: none;
	line-height: 1;
}
.psv-btn:hover { border-color: var(--theme-color-brand-primary, #5650e6); color: var(--theme-color-text-primary, #1f2733); text-decoration: none; }
.psv-btn[disabled] { opacity: 0.45; cursor: default; }
.psv-rate { font-variant-numeric: tabular-nums; min-width: 2.6rem; }
.psv-time { font-size: 0.74rem; color: var(--theme-color-text-muted, #6b7686); font-variant-numeric: tabular-nums; min-width: 2.8rem; text-align: center; user-select: none; }
.psv-seek-wrap { position: relative; flex: 1 1 auto; min-width: 4rem; display: flex; align-items: center; }
.psv-seek { flex: 1 1 auto; min-width: 4rem; width: 100%; accent-color: var(--theme-color-brand-primary, #5650e6); cursor: pointer; }
/* The buffered bar: a thin strip along the bottom of the seek track, as wide as the buffered range ahead of the playhead. */
.psv-buffer-track { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 2px; background: var(--theme-color-border-light, #e8ebf0); pointer-events: none; overflow: hidden; }
.psv-buffered { display: block; height: 100%; width: 0; background: var(--theme-color-text-muted, #9aa3b0); opacity: 0.6; }
.psv-volume { width: 4.5rem; flex: 0 0 auto; accent-color: var(--theme-color-brand-primary, #5650e6); cursor: pointer; }
/* Buffering spinner, centred on the stage while the media waits for data. It fades in after a short delay so a quick
	seek into buffered media never flashes it. */
.psv-spinner
{
	position: absolute;
	top: 50%;
	left: 50%;
	width: 2.4rem;
	height: 2.4rem;
	margin: -1.2rem 0 0 -1.2rem;
	border-radius: 50%;
	border: 3px solid rgba(255, 255, 255, 0.25);
	border-top-color: var(--theme-color-text-on-dark, #e8ebf0);
	opacity: 0;
	animation: psv-spin 0.9s linear infinite, psv-spinner-in 0.2s ease-out 0.35s forwards;
	pointer-events: none;
}
@keyframes psv-spin { to { transform: rotate(360deg); } }
@keyframes psv-spinner-in { to { opacity: 1; } }
/* Quality menu: a button after the rate button that opens a role=menu popover above the control bar. */
.psv-quality-wrap { position: relative; display: inline-flex; flex: 0 0 auto; }
.psv-quality-btn { font-variant-numeric: tabular-nums; min-width: 3rem; }
.psv-quality-menu
{
	position: absolute;
	right: 0;
	bottom: calc(100% + 6px);
	z-index: 5;
	min-width: 11rem;
	padding: 0.3rem;
	display: flex;
	flex-direction: column;
	gap: 0.1rem;
	border-radius: 8px;
	border: 1px solid var(--theme-color-border-medium, #d5dbe3);
	background: var(--theme-color-background-panel, #ffffff);
	box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}
.psv-quality-item
{
	display: flex;
	align-items: center;
	gap: 0.45rem;
	width: 100%;
	text-align: left;
	font-size: 0.8rem;
	padding: 0.4rem 0.55rem;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--theme-color-text-secondary, #45505f);
	cursor: pointer;
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
.psv-quality-item::before { content: ''; width: 0.45rem; height: 0.45rem; border-radius: 50%; flex: 0 0 auto; }
.psv-quality-item[aria-checked="true"] { color: var(--theme-color-text-primary, #1f2733); font-weight: 600; }
.psv-quality-item[aria-checked="true"]::before { background: var(--theme-color-brand-primary, #5650e6); }
.psv-quality-item:hover, .psv-quality-item:focus { background: var(--theme-color-background-secondary, #f2f4f7); outline: none; }
`
});
