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
	// An explicit download href + filename hint. DownloadURL defaults to VideoURL.
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
.psv-video { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; background: #000; cursor: pointer; }
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
.psv-seek { flex: 1 1 auto; min-width: 4rem; accent-color: var(--theme-color-brand-primary, #5650e6); cursor: pointer; }
.psv-volume { width: 4.5rem; flex: 0 0 auto; accent-color: var(--theme-color-brand-primary, #5650e6); cursor: pointer; }
`
});
