const libPictViewClass = require('pict-view');
const _DefaultConfiguration = require('./Pict-Section-Video-DefaultConfiguration.js');
const libStrategy = require('./Pict-Section-Video-Strategy.js');

const MESSAGE_UNPLAYABLE = 'This video could not be played.';
const MESSAGE_REVOKED = 'This link has expired or been revoked.';

// Fatal hls.js network errors (other than an expired / revoked link) retry startLoad() this many times before the
// player falls back to native HLS, then the progressive file, then the error state.
const HLS_NETWORK_RETRY_LIMIT = 3;

// hls.js publishes its event + error-type names as Hls.Events / Hls.ErrorTypes; these are the 1.x values, used only
// when a host-supplied class does not carry the tables.
const HLS_EVENT_DEFAULTS = (
{
	MANIFEST_PARSED: 'hlsManifestParsed',
	LEVEL_SWITCHED: 'hlsLevelSwitched',
	FRAG_BUFFERED: 'hlsFragBuffered',
	ERROR: 'hlsError'
});
const HLS_ERROR_TYPE_DEFAULTS = (
{
	NETWORK_ERROR: 'networkError',
	MEDIA_ERROR: 'mediaError'
});

// The <video> media-event handler properties the player owns (nulled on release / destroy).
const MEDIA_HANDLER_PROPERTIES = [ 'onloadedmetadata', 'ontimeupdate', 'onplay', 'onpause', 'onended', 'onvolumechange',
	'onratechange', 'onerror', 'onclick', 'onwaiting', 'onplaying', 'onprogress', 'onseeking', 'onseeked', 'oncanplay', 'onresize' ];

/**
 * pict-section-video — a bespoke, responsive video player section.
 *
 * Drop it on a page, point it at a video URL, and it fits the whole frame to the stage on phones, tablets,
 * desktops and projected displays, with its own control bar (play/pause, a seek scrubber with a buffered bar, a
 * time readout, mute + volume, a playback-rate cycle, a quality menu, download and fullscreen). Seeking rides the
 * browser's native HTTP Range requests, so a range-served file (orator-file-service, a Sluice depot, a bare 206 URL)
 * scrubs without downloading the whole clip.
 *
 * Adaptive streaming: a source carrying `Stream: { Type:'hls', Manifest, Renditions, ProgressiveURL }` resolves a
 * playback strategy (Pict-Section-Video-Strategy.js): native HLS on Safari, host-supplied hls.js (1.7.4 light;
 * never bundled or required — config HlsLibrary or window.Hls) elsewhere, the progressive file as a fallback.
 * The quality menu offers Auto, one entry per rung and Data saver; picks persist in localStorage.
 *
 * It is a single pict-view in the lightweight single-view shape (like pict-section-image / pict-section-code): a
 * stub container template, with the player DOM built imperatively in onAfterInitialRender — a <video> is
 * inherently imperative (its src, buffered/seekable ranges, and the load/timeupdate/play/pause events have no
 * template equivalent).
 *
 * Standalone, or driven as the video renderer inside pict-section-fileview: the fileview delegate mounts it with
 * ShowFullscreen:false and ShowDownload:false (fileview owns those) but keeps the control bar (ShowToolbar:true),
 * and feeds files through setSource() (or setVideo() on older fileviews).
 *
 * Event wiring note: the control-bar buttons, the seek/volume inputs, the quality menu and the <video>'s media
 * events use element-property handlers (`el.onclick = ...`, `video.ontimeupdate = ...`), not addEventListener and not
 * template inline handlers. The pict rule against addEventListener is about listeners silently lost on template
 * re-render; this widget is built once imperatively and never re-rendered by the template engine, element-property
 * handlers cannot duplicate, and the <video>'s media events have no template-handler equivalent — the same
 * programmatic-element exception pict-section-code / pict-section-image document.
 *
 * The few addEventListener calls are the documented exceptions, each installed only while needed and removed on
 * exit / destroy: document-level browser events with no element-level equivalent (the Escape key while maximized,
 * fullscreenchange while in real fullscreen, an outside pointerdown while the quality menu is open), the iPhone
 * <video>'s webkitendfullscreen (no `on…` property exists for it), and hls.js's own listener API (on/off).
 */
class PictSectionVideo extends libPictViewClass
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, _DefaultConfiguration, pOptions);
		super(pFable, tmpOptions, pServiceHash);

		this.initialRenderComplete = false;

		// DOM handles — built once in onAfterInitialRender.
		this.targetElement = false;
		this._rootElement = null;
		this._stageElement = null;
		this._videoElement = null;
		this._loadingElement = null;
		this._spinnerElement = null;
		this._controlsElement = null;
		this._playButtonElement = null;
		this._seekElement = null;
		this._bufferedElement = null;
		this._currentTimeElement = null;
		this._durationElement = null;
		this._muteButtonElement = null;
		this._volumeElement = null;
		this._rateButtonElement = null;
		this._qualityWrapElement = null;
		this._qualityButtonElement = null;
		this._qualityMenuElement = null;
		this._downloadElement = null;
		this._fullscreenButtonElement = null;

		// Quality menu state: the open flag, the built items ([{ Element, Value }]) and the outside-pointer handler.
		this._qualityMenuOpen = false;
		this._qualityItems = [];
		this._outsidePointerHandler = null;

		// Fullscreen state. Mode: 'api' (Fullscreen API on the root), 'webkit' (iPhone native <video> player),
		// 'css' (fill-the-viewport maximize) or '' when not fullscreen.
		this._fullscreen = false;
		this._fullscreenMode = '';
		// The requestFullscreen() still in flight ({ Root }) or null: it settles asynchronously, so an exit that comes
		// first cannot leave yet and the landing is undone when it settles (_onFullscreenRequestSettled).
		this._fullscreenPending = null;
		this._keydownHandler = null;
		this._fullscreenChangeHandler = null;
		this._webkitEndFullscreenHandler = null;
		this._webkitFullscreenVideo = null;

		// Source state.
		this._source = null;
		this._url = '';
		this._posterURL = '';
		this._title = '';
		this._downloadURL = '';      // '' = absent (fall back to the playing URL), null = no download, else the href
		this._downloadName = '';
		this._durationHint = 0;
		this._applySource(this._normalizeSource(
			{
				URL: this.options.VideoURL || '',
				PosterURL: this.options.PosterURL || '',
				Title: this.options.Title || '',
				DownloadURL: (this.options.DownloadURL === null) ? null : (this.options.DownloadURL || ''),
				DownloadName: this.options.DownloadName || ''
			}));

		// Playback-path state.
		this._strategy = '';
		this._playingURL = '';
		this._fallbackTried = { Native: false, Progressive: false };

		// hls.js state.
		this._hls = null;
		this._hlsClass = null;
		this._hlsConfig = null;
		this._hlsManifestParsed = false;
		this._hlsStarted = false;
		this._hlsLoadRequested = false;
		this._hlsStartLevelTouched = false;
		this._hlsMeasured = false;
		this._hlsNetworkPeak = 0;   // the fastest fragment (bits/s) this hls.js instance pulled over the network
		this._hlsNetworkRetries = 0;
		this._hlsMediaRecovered = false;

		// View state.
		this._loaded = false;       // metadata (duration/dimensions) available
		this._error = false;
		this._errorMessage = '';
		this._playing = false;
		this._duration = 0;
		this._currentTime = 0;
		this._muted = !!this.options.Muted;
		this._volume = (typeof this.options.Volume === 'number') ? Math.min(1, Math.max(0, this.options.Volume)) : 1;
		this._volumeWritable = true;
		this._playbackRate = 1;
		this._waiting = false;
		this._buffered = 0;
		this._loadingVisible = false;
		// A position to restore once the (re)loaded media reports metadata: { Time, Paused } or null.
		this._pendingRestore = null;

		// Quality: the pick ('auto' | 'saver' | a short side) restored from storage, and the short side now playing.
		this._quality = libStrategy.normalizeQuality(this._readStoredPreferences().Quality) || 'auto';
		this._playingHeight = 0;

		this._playbackRates = (Array.isArray(this.options.PlaybackRates) && this.options.PlaybackRates.length)
			? this.options.PlaybackRates.slice() : [ 1 ];
	}

	onBeforeInitialize()
	{
		super.onBeforeInitialize();
		this.targetElement = false;
	}

	onAfterRender(pRenderable)
	{
		// Ensure the CSS from all registered views is injected (pict rule for lazy-rendered views).
		this.pict.CSSMap.injectCSS();

		// Build the player when it isn't present — the first render, or a host re-render that re-stamped the stub
		// container template over our built DOM. Instance state (_source, _currentTime) persists, so a rebuild re-loads
		// the current video at the same position; this makes a re-render self-healing rather than silently wiping it.
		if (!this._playerPresent())
		{
			this.onAfterInitialRender();
			this.initialRenderComplete = true;
		}

		return super.onAfterRender(pRenderable);
	}

	/** Is the player DOM currently present in the target (false after the first render or a stub re-stamp)? */
	_playerPresent()
	{
		return !!this._queryOwned('#' + this.Hash + '-Stage');
	}

	onAfterInitialRender()
	{
		let tmpTargetElementSet = this.services.ContentAssignment.getElement(this.options.TargetElementAddress);
		if (!tmpTargetElementSet || tmpTargetElementSet.length < 1)
		{
			this.log.error(`PICT-Video Could not find target element [${this.options.TargetElementAddress}]!`);
			this.targetElement = false;
			return false;
		}
		this.targetElement = tmpTargetElementSet[0];

		// A self-heal rebuild keeps the reader's place: capture it from the outgoing <video> before it is released.
		const tmpRestore = this._capturePosition();

		this._buildPlayerDOM();

		if (this._strategy && !this._error && this._playingURL)
		{
			// Rebuild: reload exactly what was playing (same strategy, same rung) at the same position.
			this._loadVideo(this._playingURL, { Restore: tmpRestore });
		}
		else if (this._hasSourceMedia())
		{
			this._loadSource({ Restore: tmpRestore });
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// DOM construction (once)
	// -----------------------------------------------------------------------------------------------------------

	/**
	 * Build the player chrome into the target element, then grab references and wire the element-property handlers.
	 * Called once from onAfterInitialRender (and again to recover from an error state or a stub re-stamp).
	 */
	_buildPlayerDOM()
	{
		const tmpBase = this.Hash;

		// A rebuild replaces the <video>: detach hls.js and silence the outgoing element so it cannot keep playing.
		if (this._videoElement)
		{
			this._teardownHls();
			this._releaseVideoElement(this._videoElement);
		}
		this._closeQualityMenu(false);

		// Make sure the player glyphs exist in the icon registry before the control bar references them.
		this._ensureIcons();

		let tmpControls = '';
		if (this.options.ShowToolbar)
		{
			let tmpFullscreen = '';
			if (this.options.ShowFullscreen)
			{
				tmpFullscreen = '<button type="button" class="psv-btn psv-fullscreen-btn" id="' + tmpBase + '-FullscreenBtn" title="Full screen">'
					+ this._icon(this._fullscreen ? 'Minimize' : 'Maximize') + '</button>';
			}
			let tmpDownload = '';
			if (this.options.ShowDownload)
			{
				tmpDownload = '<a class="psv-btn psv-download" id="' + tmpBase + '-Download" style="display:none" href="#" download>'
					+ this._icon('Download') + '</a>';
			}
			let tmpQuality = '';
			if (this.options.ShowQuality)
			{
				// Hidden until a source offers at least two rungs (_refreshQuality).
				tmpQuality = '<span class="psv-quality-wrap" id="' + tmpBase + '-QualityWrap" style="display:none">'
					+ '<button type="button" class="psv-btn psv-quality-btn" id="' + tmpBase + '-QualityBtn" title="Quality"'
					+ ' aria-haspopup="menu" aria-expanded="false" aria-controls="' + tmpBase + '-QualityMenu">Auto</button>'
					+ '<div class="psv-quality-menu" id="' + tmpBase + '-QualityMenu" role="menu" aria-label="Quality" style="display:none"></div>'
					+ '</span>';
			}
			tmpControls = '<div class="psv-controls" id="' + tmpBase + '-Controls">'
				+ '<button type="button" class="psv-btn psv-play-btn" id="' + tmpBase + '-PlayBtn" title="Play">' + this._icon('Play') + '</button>'
				+ '<span class="psv-time psv-current" id="' + tmpBase + '-Current">0:00</span>'
				+ '<span class="psv-seek-wrap">'
				+ '<input type="range" class="psv-seek" id="' + tmpBase + '-Seek" min="0" max="1000" value="0" step="1" disabled title="Seek" />'
				+ '<span class="psv-buffer-track"><span class="psv-buffered" id="' + tmpBase + '-Buffered"></span></span>'
				+ '</span>'
				+ '<span class="psv-time psv-duration" id="' + tmpBase + '-Duration">0:00</span>'
				+ '<button type="button" class="psv-btn psv-mute-btn" id="' + tmpBase + '-MuteBtn" title="Mute">' + this._icon(this._muted ? 'VolumeMute' : 'VolumeHigh') + '</button>'
				+ '<input type="range" class="psv-volume" id="' + tmpBase + '-Volume" min="0" max="100" value="' + Math.round(this._volume * 100) + '" step="1" title="Volume" />'
				+ '<button type="button" class="psv-btn psv-rate" id="' + tmpBase + '-RateBtn" title="Playback speed">1&times;</button>'
				+ tmpQuality
				+ '<span class="psv-spacer"></span>'
				+ tmpFullscreen
				+ tmpDownload
				+ '</div>';
		}

		const tmpPosterAttribute = this._posterURL ? (' poster="' + this._esc(this._posterURL) + '"') : '';
		const tmpPreload = this._esc(this.options.Preload || 'metadata');
		const tmpVideoAttributes = ''
			+ (this.options.AutoPlay ? ' autoplay' : '')
			+ (this.options.Loop ? ' loop' : '')
			+ (this._muted ? ' muted' : '')
			+ ' playsinline preload="' + tmpPreload + '"' + tmpPosterAttribute;

		const tmpHTML = '<div class="psv-root" id="' + tmpBase + '-Root">'
			+ '<div class="psv-stage" id="' + tmpBase + '-Stage">'
			+ '<video class="psv-video" id="' + tmpBase + '-Video"' + tmpVideoAttributes + '></video>'
			+ '<div class="psv-loading" id="' + tmpBase + '-Loading" style="display:none">' + this._icon('Play') + ' Loading…</div>'
			+ '<div class="psv-spinner" id="' + tmpBase + '-Spinner" role="status" aria-label="Buffering" style="display:none"></div>'
			+ '</div>'
			+ tmpControls
			+ '</div>';

		this.pict.ContentAssignment.assignContent(this.options.TargetElementAddress, tmpHTML);

		// Reference grab (querySelector within the owned subtree is fine — these are nodes we just built).
		this._rootElement = this._queryOwned('#' + tmpBase + '-Root');
		this._stageElement = this._queryOwned('#' + tmpBase + '-Stage');
		this._videoElement = this._queryOwned('#' + tmpBase + '-Video');
		this._loadingElement = this._queryOwned('#' + tmpBase + '-Loading');
		this._spinnerElement = this._queryOwned('#' + tmpBase + '-Spinner');
		this._controlsElement = this._queryOwned('#' + tmpBase + '-Controls');
		this._playButtonElement = this._queryOwned('#' + tmpBase + '-PlayBtn');
		this._seekElement = this._queryOwned('#' + tmpBase + '-Seek');
		this._bufferedElement = this._queryOwned('#' + tmpBase + '-Buffered');
		this._currentTimeElement = this._queryOwned('#' + tmpBase + '-Current');
		this._durationElement = this._queryOwned('#' + tmpBase + '-Duration');
		this._muteButtonElement = this._queryOwned('#' + tmpBase + '-MuteBtn');
		this._volumeElement = this._queryOwned('#' + tmpBase + '-Volume');
		this._rateButtonElement = this._queryOwned('#' + tmpBase + '-RateBtn');
		this._qualityWrapElement = this._queryOwned('#' + tmpBase + '-QualityWrap');
		this._qualityButtonElement = this._queryOwned('#' + tmpBase + '-QualityBtn');
		this._qualityMenuElement = this._queryOwned('#' + tmpBase + '-QualityMenu');
		this._downloadElement = this._queryOwned('#' + tmpBase + '-Download');
		this._fullscreenButtonElement = this._queryOwned('#' + tmpBase + '-FullscreenBtn');
		this._loadingVisible = false;

		// iOS ignores writes to HTMLMediaElement.volume (the hardware buttons own it): a slider there would do nothing,
		// so probe once and hide it where a write does not stick.
		this._volumeWritable = this._probeVolumeWritable();
		if (this._volumeElement && !this._volumeWritable)
		{
			this._volumeElement.style.display = 'none';
		}

		this._wireMediaElement();
		this._wireControls();

		// Apply the initial volume/mute to the element so the control bar and the media agree from the first frame.
		if (this._videoElement)
		{
			try { this._videoElement.volume = this._volume; } catch (pError) { /* headless */ }
			this._videoElement.muted = this._muted;
		}

		// If a host re-render re-stamped the stub over a CSS-maximized player, the rebuilt root lost the class —
		// re-apply it so the rebuild stays maximized (instance state persists). The Escape handler lives on document,
		// so it survives the rebuild. (Real fullscreen ends by itself when its element leaves the DOM, and the
		// fullscreenchange handler then clears the state.)
		if (this._fullscreen && (this._fullscreenMode === 'css') && this._rootElement)
		{
			this._rootElement.classList.add('psv-fullscreen');
		}
	}

	/** Wire the <video>'s media events (element-property handlers; see the class note). */
	_wireMediaElement()
	{
		if (!this._videoElement) { return; }
		let tmpSelf = this;
		this._videoElement.onloadedmetadata = function () { tmpSelf._onLoadedMetadata(); };
		this._videoElement.ontimeupdate = function () { tmpSelf._onTimeUpdate(); };
		this._videoElement.onplay = function () { tmpSelf._onPlay(); };
		this._videoElement.onpause = function () { tmpSelf._onPause(); };
		this._videoElement.onended = function () { tmpSelf._onEnded(); };
		this._videoElement.onvolumechange = function () { tmpSelf._onVolumeChange(); };
		this._videoElement.onratechange = function () { tmpSelf._onRateChange(); };
		this._videoElement.onerror = function () { tmpSelf._onError(); };
		// Buffering: waiting/seeking raise the spinner; playing/canplay/seeked lower it; progress grows the buffered bar.
		this._videoElement.onwaiting = function () { tmpSelf._onWaiting(); };
		this._videoElement.onplaying = function () { tmpSelf._onPlaying(); };
		this._videoElement.oncanplay = function () { tmpSelf._onCanPlay(); };
		this._videoElement.onseeking = function () { tmpSelf._onSeeking(); };
		this._videoElement.onseeked = function () { tmpSelf._onSeeked(); };
		this._videoElement.onprogress = function () { tmpSelf._onProgress(); };
		// The intrinsic size changed (a native-HLS rung switch): the Auto label follows videoHeight.
		this._videoElement.onresize = function () { tmpSelf._onResize(); };
		if (this.options.ClickToPlay)
		{
			this._videoElement.onclick = function () { tmpSelf.togglePlay(); };
		}
	}

	/** Wire the control-bar buttons + sliders + quality menu (element-property handlers). */
	_wireControls()
	{
		if (!this.options.ShowToolbar) { return; }
		let tmpSelf = this;
		if (this._playButtonElement) { this._playButtonElement.onclick = function () { tmpSelf.togglePlay(); }; }
		if (this._muteButtonElement) { this._muteButtonElement.onclick = function () { tmpSelf.toggleMute(); }; }
		if (this._rateButtonElement) { this._rateButtonElement.onclick = function () { tmpSelf.cyclePlaybackRate(); }; }
		if (this._fullscreenButtonElement) { this._fullscreenButtonElement.onclick = function () { tmpSelf.toggleFullscreen(); }; }
		if (this._seekElement) { this._seekElement.oninput = function () { tmpSelf._onSeekInput(); }; }
		if (this._volumeElement) { this._volumeElement.oninput = function () { tmpSelf._onVolumeInput(); }; }
		if (this._qualityButtonElement)
		{
			this._qualityButtonElement.onclick = function () { tmpSelf.toggleQualityMenu(); };
			this._qualityButtonElement.onkeydown = function (pEvent) { tmpSelf._onQualityButtonKeydown(pEvent); };
		}
		if (this._qualityMenuElement)
		{
			this._qualityMenuElement.onkeydown = function (pEvent) { tmpSelf._onQualityMenuKeydown(pEvent); };
		}
	}

	/** querySelector scoped to the player subtree, via ContentAssignment, returning the element or null. */
	_queryOwned(pSelector)
	{
		let tmpSet = this.services.ContentAssignment.getElement(pSelector);
		return (tmpSet && tmpSet.length > 0) ? tmpSet[0] : null;
	}

	/** Pause an outgoing <video>, null its handlers and drop its source so a discarded element cannot keep playing. */
	_releaseVideoElement(pVideo)
	{
		if (!pVideo) { return; }
		try { pVideo.pause(); } catch (pError) { /* headless */ }
		for (let i = 0; i < MEDIA_HANDLER_PROPERTIES.length; i++)
		{
			pVideo[MEDIA_HANDLER_PROPERTIES[i]] = null;
		}
		if (this._webkitFullscreenVideo === pVideo)
		{
			this._removeWebkitEndFullscreenHandler();
			if (this._fullscreenMode === 'webkit')
			{
				this._fullscreen = false;
				this._fullscreenMode = '';
			}
		}
		try
		{
			pVideo.removeAttribute('src');
			if (typeof pVideo.load === 'function') { pVideo.load(); }
		}
		catch (pError) { /* headless */ }
	}

	/** Can this <video>'s volume be set from script? (False on iOS, where writes are silently ignored.) */
	_probeVolumeWritable()
	{
		const tmpVideo = this._videoElement;
		if (!tmpVideo) { return true; }
		try
		{
			const tmpOriginal = tmpVideo.volume;
			const tmpProbe = (tmpOriginal === 0.5) ? 0.25 : 0.5;
			tmpVideo.volume = tmpProbe;
			const tmpStuck = (Math.abs(Number(tmpVideo.volume) - tmpProbe) < 0.001);
			tmpVideo.volume = tmpOriginal;
			return tmpStuck;
		}
		catch (pError)
		{
			return false;
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// Source + strategy
	// -----------------------------------------------------------------------------------------------------------

	/**
	 * Normalize a setSource/setVideo input (a URL string or a descriptor) into the player's source shape. The
	 * DownloadURL keeps its three states: null (no download), '' (absent: fall back), or a non-empty string.
	 */
	_normalizeSource(pInput)
	{
		let tmpInput = {};
		if (typeof pInput === 'string')
		{
			tmpInput = { URL: pInput };
		}
		else if (pInput && (typeof pInput === 'object'))
		{
			tmpInput = pInput;
		}
		const tmpStream = (tmpInput.Stream && (typeof tmpInput.Stream === 'object')) ? tmpInput.Stream : null;
		let tmpURL = tmpInput.URL || tmpInput.Url || tmpInput.VideoURL || '';
		if (!tmpURL && tmpStream && tmpStream.Manifest) { tmpURL = tmpStream.Manifest; }

		let tmpDownloadURL = '';
		if (tmpInput.DownloadURL === null) { tmpDownloadURL = null; }
		else if ((typeof tmpInput.DownloadURL === 'string') && tmpInput.DownloadURL) { tmpDownloadURL = tmpInput.DownloadURL; }

		const tmpDuration = Number(tmpInput.Duration);
		return (
		{
			URL: tmpURL,
			Stream: tmpStream,
			PosterURL: tmpInput.PosterURL || tmpInput.Poster || '',
			Title: tmpInput.Title || tmpInput.Name || '',
			Name: tmpInput.Name || '',
			DownloadURL: tmpDownloadURL,
			DownloadName: tmpInput.DownloadName || tmpInput.Name || '',
			Duration: (isFinite(tmpDuration) && tmpDuration > 0) ? tmpDuration : 0
		});
	}

	/** Adopt a normalized source as the current one (instance fields only — no loading). */
	_applySource(pSource)
	{
		this._source = pSource;
		this._url = pSource.URL || '';
		this._posterURL = pSource.PosterURL || '';
		this._title = pSource.Title || '';
		this._downloadURL = pSource.DownloadURL;
		this._downloadName = pSource.DownloadName || '';
		this._durationHint = pSource.Duration || 0;
	}

	/** Does the current source name anything playable? */
	_hasSourceMedia()
	{
		const tmpSource = this._source;
		if (!tmpSource) { return false; }
		if (tmpSource.URL) { return true; }
		return !!(tmpSource.Stream && (tmpSource.Stream.Manifest || tmpSource.Stream.ProgressiveURL));
	}

	/** The hls.js class: config HlsLibrary, else the page global window.Hls, else null. Never bundled or required. */
	_resolveHlsLibrary()
	{
		if (this.options.HlsLibrary) { return this.options.HlsLibrary; }
		if ((typeof window !== 'undefined') && window && window.Hls) { return window.Hls; }
		return null;
	}

	/** Resolve the strategy for the current source and load it (fresh fallback ladder; keeps any Restore option). */
	_loadSource(pOptions)
	{
		const tmpOptions = pOptions || {};
		this._teardownHls();
		this._hlsNetworkRetries = 0;
		this._hlsMediaRecovered = false;

		// Recover from a prior error state (the <video> was dropped) before asking it what it can play.
		if (!this._videoElement && this.targetElement)
		{
			this._buildPlayerDOM();
		}
		if (!this._videoElement) { return; }

		if (!this._hasSourceMedia())
		{
			this._strategy = '';
			this._loadVideo('', tmpOptions);
			return;
		}

		const tmpSource = this._source;
		this._strategy = libStrategy.resolveStrategy(tmpSource, this._videoElement, this._resolveHlsLibrary(),
			(typeof window !== 'undefined') ? window : null);

		switch (this._strategy)
		{
			case libStrategy.STRATEGY_HLSJS:
				this._loadVideo(libStrategy.manifestURL(tmpSource), tmpOptions);
				break;
			case libStrategy.STRATEGY_NATIVE_HLS:
				this._loadVideo(this._nativeURLForQuality(), tmpOptions);
				break;
			case libStrategy.STRATEGY_PROGRESSIVE:
				this._loadVideo(libStrategy.progressiveURL(tmpSource), tmpOptions);
				break;
			default:
				this._failWith(MESSAGE_UNPLAYABLE);
				break;
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// Media loading
	// -----------------------------------------------------------------------------------------------------------

	/**
	 * Point the <video> at a URL using the current strategy (hls.js attaches; everything else sets src).
	 * @param {string} pURL
	 * @param {Object} [pOptions] - { PreservePosition: capture time + paused state now and restore them on
	 *   loadedmetadata; Restore: an already-captured { Time, Paused } }
	 */
	_loadVideo(pURL, pOptions)
	{
		const tmpOptions = pOptions || {};
		let tmpRestore = null;
		if (tmpOptions.Restore) { tmpRestore = tmpOptions.Restore; }
		else if (tmpOptions.PreservePosition) { tmpRestore = this._capturePosition(); }
		// Nothing to restore at the very start of a paused clip.
		if (tmpRestore && !(tmpRestore.Time > 0) && tmpRestore.Paused) { tmpRestore = null; }

		this._loaded = false;
		this._error = false;
		this._errorMessage = '';
		this._playing = false;
		// A restore reloads the same clip (another rung, a fallback file, a rebuilt element), so its known duration
		// holds until the new metadata replaces it — the readout and the scrubber keep the reader's place meanwhile.
		this._duration = tmpRestore ? (this._duration || 0) : 0;
		this._currentTime = tmpRestore ? (tmpRestore.Time || 0) : 0;
		this._pendingRestore = tmpRestore;
		this._waiting = false;
		this._buffered = 0;

		// Recover from a prior error: _paintErrorState replaced the stage contents and dropped the <video>, so
		// rebuild the player DOM (which recreates a fresh <video> + loading element) before loading.
		if (!this._videoElement && this.targetElement)
		{
			this._buildPlayerDOM();
		}
		if (!this._videoElement) { return; }

		// A mid-clip reload (rung switch, fallback, self-heal) keeps the frame black for a beat rather than flashing
		// the title poster; a fresh load shows the poster.
		if (this._posterURL && !(tmpRestore && tmpRestore.Time > 0)) { this._videoElement.setAttribute('poster', this._posterURL); }
		else { this._videoElement.removeAttribute('poster'); }

		if (!pURL)
		{
			this._teardownHls();
			this._playingURL = '';
			this._videoElement.removeAttribute('src');
			this._setLoadingVisible(false);
			this._refreshControls();
			return;
		}

		this._playingURL = pURL;
		if (this._strategy === libStrategy.STRATEGY_HLSJS)
		{
			// Visible until the manifest parses (then the poster + play button are ready; media loads on play).
			this._setLoadingVisible(true);
			this._attachHls(pURL);
		}
		else
		{
			this._teardownHls();
			// Preload:'none' fetches nothing until play, so a "Loading…" veil would sit over the poster forever
			// (a playing restore is the exception: it calls play() just below).
			this._setLoadingVisible((this.options.Preload !== 'none') || !!(tmpRestore && !tmpRestore.Paused));
			this._videoElement.setAttribute('src', pURL);
			// Ask the element to (re)load the new source; harmless where load() is unavailable.
			try { if (typeof this._videoElement.load === 'function') { this._videoElement.load(); } }
			catch (pError) { /* headless / unsupported */ }
			// Resume a playing restore straight away (Preload:'none' would otherwise never reach loadedmetadata).
			if (tmpRestore && !tmpRestore.Paused) { this.play(); }
		}

		this._refreshControls();
	}

	/** Where the reader is now: { Time, Paused }. A restore still pending (media never loaded) carries forward. */
	_capturePosition()
	{
		if (this._pendingRestore && !this._loaded)
		{
			return { Time: this._pendingRestore.Time || 0, Paused: !!this._pendingRestore.Paused && !this._playing };
		}
		let tmpTime = this._currentTime || 0;
		if (this._videoElement)
		{
			const tmpElementTime = Number(this._videoElement.currentTime);
			if (isFinite(tmpElementTime) && tmpElementTime > 0) { tmpTime = tmpElementTime; }
		}
		return { Time: tmpTime, Paused: !this._playing };
	}

	_onLoadedMetadata()
	{
		this._loaded = true;
		this._error = false;
		this._duration = this._readDuration();

		const tmpRestore = this._pendingRestore;
		this._pendingRestore = null;
		if (tmpRestore)
		{
			if (tmpRestore.Time > 0) { this.seekTo(tmpRestore.Time); }
			if (!tmpRestore.Paused) { this.play(); }
		}

		if (this._strategy !== libStrategy.STRATEGY_HLSJS) { this._readPlayingHeightFromElement(); }
		this._setLoadingVisible(false);
		this._refreshControls();
	}

	_onTimeUpdate()
	{
		if (this._pendingRestore && !this._loaded)
		{
			// A reload is in flight: the load algorithm reset the element to 0 (and queued this timeupdate). Keep showing
			// the reader's place until _onLoadedMetadata seeks back to it.
			this._currentTime = this._pendingRestore.Time || 0;
		}
		else
		{
			this._currentTime = this._videoElement ? (this._videoElement.currentTime || 0) : 0;
		}
		if (!this._duration) { this._duration = this._readDuration(); }
		this._refreshTimeDisplay();
		this._refreshSeek();
		this._refreshBuffered();
	}

	_onPlay()
	{
		this._playing = true;
		this._notePlayIntent(true);
		// Under hls.js (autoStartLoad:false) the first play — from our button, the <video>, autoplay or the OS media
		// keys — is what starts fragment loading.
		this._requestHlsLoad();
		this._refreshPlayButton();
	}

	_onPause()
	{
		// Only a pause of playback the player saw start is the reader's: _loadVideo already cleared _playing, so a
		// pause that a reload itself might cause cannot cancel the restore's resume.
		if (this._playing) { this._notePlayIntent(false); }
		this._playing = false;
		this._waiting = false;
		this._refreshSpinner();
		this._refreshPlayButton();
	}

	/**
	 * While a reload's restore is pending (a rung switch, a fallback step, a self-heal), a play or pause decides
	 * whether _onLoadedMetadata resumes playback — otherwise it would replay the state captured before the reload.
	 * @param {boolean} pPlaying
	 */
	_notePlayIntent(pPlaying)
	{
		if (this._pendingRestore && !this._loaded) { this._pendingRestore.Paused = !pPlaying; }
	}

	_onEnded()
	{
		this._playing = false;
		this._waiting = false;
		this._refreshSpinner();
		this._refreshPlayButton();
	}

	_onWaiting()
	{
		this._waiting = true;
		this._refreshSpinner();
	}

	_onPlaying()
	{
		this._waiting = false;
		this._playing = true;
		this._refreshSpinner();
		this._refreshPlayButton();
	}

	_onCanPlay()
	{
		this._waiting = false;
		this._setLoadingVisible(false);
	}

	_onSeeking()
	{
		this._waiting = true;
		this._refreshSpinner();
	}

	_onSeeked()
	{
		this._waiting = false;
		this._refreshBuffered();
		this._refreshSpinner();
	}

	_onProgress()
	{
		this._refreshBuffered();
	}

	_onResize()
	{
		// hls.js reports the playing level itself (LEVEL_SWITCHED); everything else reads the intrinsic size.
		if (this._strategy === libStrategy.STRATEGY_HLSJS) { return; }
		this._readPlayingHeightFromElement();
		this._refreshQuality();
	}

	_onVolumeChange()
	{
		if (!this._videoElement) { return; }
		this._muted = !!this._videoElement.muted;
		this._volume = (typeof this._videoElement.volume === 'number') ? this._videoElement.volume : this._volume;
		this._refreshVolume();
	}

	_onRateChange()
	{
		if (!this._videoElement) { return; }
		this._playbackRate = this._videoElement.playbackRate || 1;
		this._refreshRate();
	}

	/** The <video> element errored: recover (hls.js), fall down the ladder (HLS), or show the error state. */
	_onError()
	{
		if ((this._strategy === libStrategy.STRATEGY_HLSJS) && this._hls)
		{
			if (!this._hlsMediaRecovered)
			{
				this._hlsMediaRecovered = true;
				try
				{
					this._hls.recoverMediaError();
					return;
				}
				catch (pError) { /* fall through to the ladder */ }
			}
			this._fallBack();
			return;
		}
		if (libStrategy.isHlsSource(this._source))
		{
			this._fallBack();
			return;
		}
		this._failWith(MESSAGE_UNPLAYABLE);
	}

	/** The media element's duration, or 0 when it is not a finite positive number (unknown / headless). */
	_readDuration()
	{
		if (!this._videoElement) { return 0; }
		const tmpDuration = this._videoElement.duration;
		return (typeof tmpDuration === 'number' && isFinite(tmpDuration) && tmpDuration > 0) ? tmpDuration : 0;
	}

	/** Record the short side of the frame now playing, from the element's intrinsic size (when known). */
	_readPlayingHeightFromElement()
	{
		if (!this._videoElement) { return; }
		const tmpHeight = libStrategy.shortSide(this._videoElement.videoWidth, this._videoElement.videoHeight);
		if (tmpHeight > 0) { this._playingHeight = tmpHeight; }
	}

	_setLoadingVisible(pVisible)
	{
		this._loadingVisible = !!pVisible;
		if (this._loadingElement) { this._loadingElement.style.display = pVisible ? 'flex' : 'none'; }
		this._refreshSpinner();
	}

	/**
	 * Step down the fallback ladder after hls.js (or native HLS) gives up: native HLS (when this browser plays it)
	 * → the progressive file (Stream.ProgressiveURL, present only when downloads are allowed) → the error state.
	 * The reader's position carries across each step.
	 */
	_fallBack()
	{
		const tmpRestore = this._capturePosition();
		this._teardownHls();
		const tmpSource = this._source;
		if (libStrategy.isHlsSource(tmpSource))
		{
			if (!this._fallbackTried.Native && (this._strategy !== libStrategy.STRATEGY_NATIVE_HLS)
				&& this._videoElement && libStrategy.canPlayHls(this._videoElement))
			{
				this._fallbackTried.Native = true;
				this._strategy = libStrategy.STRATEGY_NATIVE_HLS;
				this.log.warn('PICT-Video falling back to native HLS playback.');
				this._loadVideo(this._nativeURLForQuality(), { Restore: tmpRestore });
				return;
			}
			if (!this._fallbackTried.Progressive && (this._strategy !== libStrategy.STRATEGY_PROGRESSIVE)
				&& tmpSource.Stream.ProgressiveURL)
			{
				this._fallbackTried.Progressive = true;
				this._strategy = libStrategy.STRATEGY_PROGRESSIVE;
				this.log.warn('PICT-Video falling back to the progressive file.');
				this._loadVideo(tmpSource.Stream.ProgressiveURL, { Restore: tmpRestore });
				return;
			}
		}
		this._failWith(MESSAGE_UNPLAYABLE);
	}

	/** Give up: tear down hls.js and paint the error state with a message. */
	_failWith(pMessage)
	{
		this._teardownHls();
		this._loaded = false;
		this._error = true;
		this._errorMessage = pMessage || MESSAGE_UNPLAYABLE;
		this._playing = false;
		this._waiting = false;
		this._buffered = 0;
		this._pendingRestore = null;
		this._setLoadingVisible(false);
		this._closeQualityMenu(false);
		this._paintErrorState(this._errorMessage);
		this._refreshControls();
	}

	_paintErrorState(pMessage)
	{
		if (!this._stageElement) { return; }
		const tmpMessage = pMessage || this._errorMessage || MESSAGE_UNPLAYABLE;
		let tmpDownload = '';
		const tmpHref = this._effectiveDownloadURL();
		if (tmpHref)
		{
			tmpDownload = '<a class="psv-btn" href="' + this._esc(tmpHref) + '" download'
				+ (this._downloadName ? ('="' + this._esc(this._downloadName) + '"') : '')
				+ '>' + this._icon('Download') + ' Download</a>';
		}
		// The <video> is about to be replaced by the error block: silence it first.
		this._releaseVideoElement(this._videoElement);
		const tmpBase = this.Hash;
		this.pict.ContentAssignment.assignContent('#' + tmpBase + '-Stage',
			'<div class="psv-error"><span class="psv-error-glyph">' + this._icon('Play') + '</span>'
			+ '<p>' + this._esc(tmpMessage) + '</p>' + tmpDownload + '</div>');
		// The <video> node was replaced by the error block; drop stale references so a later setSource rebuilds.
		this._videoElement = null;
		this._loadingElement = null;
		this._spinnerElement = null;
		this._loadingVisible = false;
	}

	/**
	 * The download href: an explicit DownloadURL wins; null means none at all; absent falls back to the playing URL —
	 * for an HLS source that is Stream.ProgressiveURL (a playlist is not a useful download), else the source URL.
	 */
	_effectiveDownloadURL()
	{
		if (this._downloadURL === null) { return ''; }
		if (this._downloadURL) { return this._downloadURL; }
		if (libStrategy.isHlsSource(this._source)) { return this._source.Stream.ProgressiveURL || ''; }
		return this._url || '';
	}

	// -----------------------------------------------------------------------------------------------------------
	// hls.js
	// -----------------------------------------------------------------------------------------------------------

	_hlsEvents()
	{
		return Object.assign({}, HLS_EVENT_DEFAULTS, (this._hlsClass && this._hlsClass.Events) || {});
	}

	_hlsErrorTypes()
	{
		return Object.assign({}, HLS_ERROR_TYPE_DEFAULTS, (this._hlsClass && this._hlsClass.ErrorTypes) || {});
	}

	/** Create an hls.js instance for the manifest and attach it to the <video> (the manifest loads now; media on play). */
	_attachHls(pURL)
	{
		this._teardownHls();
		const tmpHlsClass = this._resolveHlsLibrary();
		if (!tmpHlsClass || !this._videoElement)
		{
			this._fallBack();
			return;
		}

		// MSE owns the element's source while hls.js is attached.
		this._videoElement.removeAttribute('src');

		const tmpConfig = libStrategy.buildHlsConfig(this.options.HlsConfig, this._readStoredPreferences().BandwidthEstimate);
		let tmpHls = null;
		try
		{
			tmpHls = new tmpHlsClass(tmpConfig);
		}
		catch (pError)
		{
			this.log.warn('PICT-Video could not construct hls.js: ' + (pError && pError.message));
			this._fallBack();
			return;
		}

		this._hls = tmpHls;
		this._hlsClass = tmpHlsClass;
		this._hlsConfig = tmpConfig;
		this._hlsManifestParsed = false;
		this._hlsStarted = (tmpConfig.autoStartLoad !== false);
		this._hlsLoadRequested = false;
		this._hlsStartLevelTouched = false;
		this._hlsMeasured = false;
		this._hlsNetworkPeak = 0;

		// hls.js's own listener API — the documented third-party-library exception. Each handler ignores a stale
		// instance (one torn down while its events were still queued).
		const tmpEvents = this._hlsEvents();
		let tmpSelf = this;
		tmpHls.on(tmpEvents.MANIFEST_PARSED, function (pEvent, pData) { if (tmpSelf._hls === tmpHls) { tmpSelf._onHlsManifestParsed(pData); } });
		tmpHls.on(tmpEvents.LEVEL_SWITCHED, function (pEvent, pData) { if (tmpSelf._hls === tmpHls) { tmpSelf._onHlsLevelSwitched(pData); } });
		tmpHls.on(tmpEvents.FRAG_BUFFERED, function (pEvent, pData) { if (tmpSelf._hls === tmpHls) { tmpSelf._onHlsFragBuffered(pData); } });
		tmpHls.on(tmpEvents.ERROR, function (pEvent, pData) { if (tmpSelf._hls === tmpHls) { tmpSelf._onHlsError(pData); } });

		try
		{
			tmpHls.loadSource(pURL);
			tmpHls.attachMedia(this._videoElement);
		}
		catch (pError)
		{
			this.log.warn('PICT-Video hls.js failed to attach: ' + (pError && pError.message));
			this._fallBack();
		}
	}

	/** Destroy the hls.js instance (saving its bandwidth estimate first). Safe to call when none is attached. */
	_teardownHls()
	{
		if (!this._hls) { return; }
		this._saveBandwidthEstimate();
		const tmpHls = this._hls;
		this._hls = null;
		this._hlsManifestParsed = false;
		this._hlsStarted = false;
		this._hlsLoadRequested = false;
		try { tmpHls.destroy(); }
		catch (pError) { /* already gone */ }
	}

	_onHlsManifestParsed()
	{
		this._hlsManifestParsed = true;
		// Restore a remembered pick (Auto needs nothing: a first visit starts on hls.firstLevel, the ~540p rung).
		if (this._quality !== 'auto') { this._applyQualityToHls(); }

		if (!this._hlsStarted && (this._hlsLoadRequested || this.options.AutoPlay || (this.options.Preload === 'auto')
			|| (this._pendingRestore && !this._pendingRestore.Paused)))
		{
			this._startHlsLoad();
		}
		if (!this._hlsStarted)
		{
			// Ready to play: the poster and the play button stand; media loads on the first play.
			this._setLoadingVisible(false);
		}
		this._refreshQuality();
	}

	_onHlsLevelSwitched(pData)
	{
		const tmpIndex = pData ? Number(pData.level) : -1;
		const tmpLevel = (this._hls && Array.isArray(this._hls.levels) && tmpIndex > -1) ? this._hls.levels[tmpIndex] : null;
		if (tmpLevel) { this._playingHeight = libStrategy.shortSide(tmpLevel.width, tmpLevel.height); }
		this._refreshQuality();
	}

	_onHlsFragBuffered(pData)
	{
		// Only a main media fragment carries a real throughput sample (the init segment does not).
		if (pData && pData.frag && ((pData.frag.sn === 'initSegment') || (pData.frag.type && pData.frag.type !== 'main'))) { return; }
		this._hlsNetworkRetries = 0;
		// A fragment the browser served from its HTTP cache (or over loopback) says nothing about the network the next
		// visit will have: it neither counts as a measurement nor raises the ceiling the saved estimate is held to.
		const tmpSample = libStrategy.fragmentNetworkBandwidth(pData, this._performance());
		if (tmpSample <= 0) { return; }
		this._hlsNetworkPeak = Math.max(this._hlsNetworkPeak, tmpSample);
		this._hlsMeasured = true;
		this._saveBandwidthEstimate();
	}

	/** window.performance (for the Resource Timing cache-hit check), or null where there is none. */
	_performance()
	{
		try
		{
			if ((typeof window !== 'undefined') && window && window.performance) { return window.performance; }
		}
		catch (pError) { /* no performance timeline */ }
		return null;
	}

	/**
	 * hls.js error mapping:
	 *   NETWORK_ERROR with HTTP 401/403/404/410 → "This link has expired or been revoked." (no retries)
	 *   other fatal NETWORK_ERROR → retry (startLoad, or loadSource before the manifest parsed) up to 3×
	 *   fatal MEDIA_ERROR → recoverMediaError() once
	 *   anything else fatal, or retries exhausted → the fallback ladder (native HLS → progressive → error state)
	 */
	_onHlsError(pData)
	{
		if (!pData || !this._hls) { return; }
		const tmpTypes = this._hlsErrorTypes();
		if (pData.type === tmpTypes.NETWORK_ERROR)
		{
			if (libStrategy.isRevokedStatus(libStrategy.hlsErrorStatus(pData)))
			{
				this._failWith(MESSAGE_REVOKED);
				return;
			}
			if (!pData.fatal) { return; }
			if (this._hlsNetworkRetries < HLS_NETWORK_RETRY_LIMIT)
			{
				this._hlsNetworkRetries++;
				try
				{
					if (this._hlsManifestParsed) { this._hls.startLoad(); }
					else { this._hls.loadSource(this._playingURL); }
				}
				catch (pError) { this._fallBack(); }
				return;
			}
			this._fallBack();
			return;
		}
		if (!pData.fatal) { return; }
		if ((pData.type === tmpTypes.MEDIA_ERROR) && !this._hlsMediaRecovered)
		{
			this._hlsMediaRecovered = true;
			try
			{
				this._hls.recoverMediaError();
				return;
			}
			catch (pError) { /* fall through to the ladder */ }
		}
		this._fallBack();
	}

	/** Ask hls.js to start loading media (deferred until the manifest has parsed). */
	_requestHlsLoad()
	{
		if (!this._hls) { return; }
		this._hlsLoadRequested = true;
		if (this._hlsManifestParsed) { this._startHlsLoad(); }
	}

	_startHlsLoad()
	{
		if (!this._hls || this._hlsStarted) { return; }
		this._hlsStarted = true;
		const tmpStart = (this._pendingRestore && this._pendingRestore.Time > 0) ? this._pendingRestore.Time : -1;
		this._setLoadingVisible(true);
		try { this._hls.startLoad(tmpStart); }
		catch (pError) { this.log.warn('PICT-Video hls.js startLoad failed: ' + (pError && pError.message)); }
	}

	/**
	 * Apply the quality pick to hls.js. Data saver caps autoLevelCapping at the rung <= SaverMaxHeight (pausing the
	 * player-size capper, which would otherwise rewrite the cap); an explicit pick sets nextLevel while playing (the
	 * next fragment switches — no restart) or currentLevel while paused; Auto restores -1. Before loading starts the
	 * pick also seeds startLevel so the first fragment is already at the chosen rung.
	 */
	_applyQualityToHls()
	{
		const tmpHls = this._hls;
		if (!tmpHls || !this._hlsManifestParsed) { return; }
		const tmpLevels = libStrategy.qualityLevelsFromHls(tmpHls.levels);
		if (!tmpLevels.length) { return; }

		let tmpManual = -1;
		let tmpCap = -1;
		if (this._quality === 'saver')
		{
			const tmpSaver = libStrategy.saverLevel(tmpLevels, this.options.SaverMaxHeight);
			tmpCap = tmpSaver ? tmpSaver.Index : -1;
		}
		else if (typeof this._quality === 'number')
		{
			const tmpPicked = libStrategy.levelForHeight(tmpLevels, this._quality);
			tmpManual = tmpPicked ? tmpPicked.Index : -1;
		}

		try
		{
			if (tmpCap > -1)
			{
				if ('capLevelToPlayerSize' in tmpHls) { tmpHls.capLevelToPlayerSize = false; }
				tmpHls.autoLevelCapping = tmpCap;
			}
			else if (this._hlsConfig && this._hlsConfig.capLevelToPlayerSize && ('capLevelToPlayerSize' in tmpHls))
			{
				// While hls.js's player-size capper runs it owns autoLevelCapping, and (1.7+) recomputes it only when
				// its ResizeObserver fires -- so overwriting it here would leave Auto uncapped until the box next
				// resizes. Only leaving Data saver (which paused the capper) clears the saver cap and restarts it;
				// startCapping() measures the player at once.
				if (!tmpHls.capLevelToPlayerSize)
				{
					tmpHls.autoLevelCapping = -1;
					tmpHls.capLevelToPlayerSize = true;
					// hls.js 1.7.x's setter calls startCapping() before it stores the flag, and startCapping() returns
					// early while the flag is still false -- so the setter never restarts capping there. Restart it
					// directly; startCapping() is idempotent where the setter did work.
					const tmpCapper = tmpHls.capLevelController;
					if (tmpCapper && (typeof tmpCapper.startCapping === 'function')) { tmpCapper.startCapping(); }
				}
			}
			else
			{
				tmpHls.autoLevelCapping = -1;
			}

			if (!this._hlsStarted && ((tmpManual > -1) || (tmpCap > -1) || this._hlsStartLevelTouched))
			{
				let tmpStart = tmpManual;
				if (tmpStart < 0)
				{
					tmpStart = (this._hlsConfig && (typeof this._hlsConfig.startLevel === 'number'))
						? this._hlsConfig.startLevel : (Number(tmpHls.firstLevel) || 0);
					if ((tmpCap > -1) && (tmpStart > tmpCap)) { tmpStart = tmpCap; }
				}
				tmpHls.startLevel = tmpStart;
				this._hlsStartLevelTouched = true;
			}

			if (this._playing && this._hlsStarted) { tmpHls.nextLevel = tmpManual; }
			else { tmpHls.currentLevel = tmpManual; }
		}
		catch (pError)
		{
			this.log.warn('PICT-Video could not apply the quality pick: ' + (pError && pError.message));
		}
	}

	/**
	 * Persist hls.js's bandwidth estimate (beside the quality pick) once a fragment has been measured over the
	 * network, held to the fastest such fragment this session (hls.js also averages in cache hits, which read as
	 * ~800 Mbps and would start the next visit on the top rung whatever its real connection).
	 */
	_saveBandwidthEstimate()
	{
		if (!this._hls || !this._hlsMeasured) { return; }
		let tmpEstimate = NaN;
		try { tmpEstimate = Number(this._hls.bandwidthEstimate); }
		catch (pError) { return; }
		const tmpPersist = libStrategy.persistableEstimate(tmpEstimate, this._hlsNetworkPeak);
		if (tmpPersist <= 0) { return; }
		this._writeStoredPreferences({ BandwidthEstimate: tmpPersist });
	}

	// -----------------------------------------------------------------------------------------------------------
	// Quality
	// -----------------------------------------------------------------------------------------------------------

	/** Native-HLS rungs from Stream.Renditions (with their Playlist URLs). */
	_nativeLevels()
	{
		if (!libStrategy.isHlsSource(this._source)) { return []; }
		return libStrategy.qualityLevelsFromRenditions(this._source.Stream.Renditions);
	}

	/** The URL native HLS should play for the current pick: the master for Auto, else the picked rung's playlist. */
	_nativeURLForQuality()
	{
		const tmpManifest = libStrategy.manifestURL(this._source);
		if (this._quality === 'auto') { return tmpManifest; }
		const tmpLevels = this._nativeLevels().filter(function (pLevel) { return !!pLevel.Playlist; });
		if (!tmpLevels.length) { return tmpManifest; }
		const tmpLevel = (this._quality === 'saver')
			? libStrategy.saverLevel(tmpLevels, this.options.SaverMaxHeight)
			: libStrategy.levelForHeight(tmpLevels, this._quality);
		return (tmpLevel && tmpLevel.Playlist) ? tmpLevel.Playlist : tmpManifest;
	}

	/** Entries for the quality menu: Auto, one per rung (by short side, highest first), then Data saver. */
	_qualityMenuEntries()
	{
		let tmpEntries = [ { Value: 'auto', Label: this._qualityEntryLabel('auto') } ];
		const tmpLevels = this.getQualityLevels();
		let tmpSeen = {};
		for (let i = 0; i < tmpLevels.length; i++)
		{
			const tmpLevel = tmpLevels[i];
			if (!(tmpLevel.Height > 0) || tmpSeen[tmpLevel.Height]) { continue; }
			tmpSeen[tmpLevel.Height] = true;
			tmpEntries.push({ Value: tmpLevel.Height, Label: tmpLevel.Label });
		}
		if (this.options.ShowDataSaver)
		{
			tmpEntries.push({ Value: 'saver', Label: this._qualityEntryLabel('saver') });
		}
		return tmpEntries;
	}

	/** 'Auto (720p)' / 'Data saver (360p)' while that mode is active and the playing rung is known. */
	_qualityEntryLabel(pValue)
	{
		const tmpBase = (pValue === 'saver') ? 'Data saver' : 'Auto';
		if ((this._quality === pValue) && (this._playingHeight > 0))
		{
			return tmpBase + ' (' + this._playingHeight + 'p)';
		}
		return tmpBase;
	}

	/** The compact quality-button label: 'Auto', 'Saver' or '1080p'. */
	_qualityButtonLabel()
	{
		if (this._quality === 'saver') { return 'Saver'; }
		if (typeof this._quality === 'number') { return this._quality + 'p'; }
		return 'Auto';
	}

	/** Show / hide the quality button and keep its label (and an open menu) current. */
	_refreshQuality()
	{
		if (!this._qualityWrapElement) { return; }
		const tmpShow = !!this.options.ShowQuality && !this._error && (this.getQualityLevels().length >= 2);
		this._qualityWrapElement.style.display = tmpShow ? 'inline-flex' : 'none';
		if (!tmpShow)
		{
			this._closeQualityMenu(false);
			return;
		}
		if (this._qualityButtonElement)
		{
			this._qualityButtonElement.textContent = this._qualityButtonLabel();
			const tmpTitle = (this._quality === 'auto') ? this._qualityEntryLabel('auto')
				: ((this._quality === 'saver') ? this._qualityEntryLabel('saver') : (this._quality + 'p'));
			this._qualityButtonElement.setAttribute('title', 'Quality: ' + tmpTitle);
		}
		if (this._qualityMenuOpen) { this._syncQualityItems(); }
	}

	/** Open or close the quality menu. */
	toggleQualityMenu()
	{
		if (this._qualityMenuOpen) { this._closeQualityMenu(true); }
		else { this._openQualityMenu('checked'); }
	}

	/** Open the quality menu and focus an item: 'checked' (the current pick), 'first' or 'last'. */
	_openQualityMenu(pFocus)
	{
		if (!this._qualityMenuElement || this._qualityMenuOpen) { return; }
		if (!this._qualityWrapElement || this._qualityWrapElement.style.display === 'none') { return; }
		this._renderQualityItems();
		this._qualityMenuElement.style.display = 'flex';
		this._qualityMenuOpen = true;
		if (this._qualityButtonElement) { this._qualityButtonElement.setAttribute('aria-expanded', 'true'); }
		this._installOutsidePointerHandler();

		let tmpIndex = 0;
		if (pFocus === 'last') { tmpIndex = this._qualityItems.length - 1; }
		else if (pFocus === 'checked')
		{
			for (let i = 0; i < this._qualityItems.length; i++)
			{
				if (this._qualityItems[i].Value === this._quality) { tmpIndex = i; break; }
			}
		}
		this._focusQualityItem(tmpIndex);
	}

	/** Close the quality menu (optionally returning focus to its button). */
	_closeQualityMenu(pRestoreFocus)
	{
		if (!this._qualityMenuOpen) { return; }
		this._qualityMenuOpen = false;
		if (this._qualityMenuElement) { this._qualityMenuElement.style.display = 'none'; }
		if (this._qualityButtonElement)
		{
			this._qualityButtonElement.setAttribute('aria-expanded', 'false');
			if (pRestoreFocus) { try { this._qualityButtonElement.focus(); } catch (pError) { /* headless */ } }
		}
		this._removeOutsidePointerHandler();
	}

	/** (Re)build the menu items as role=menuitemradio buttons with element-property click handlers. */
	_renderQualityItems()
	{
		const tmpMenu = this._qualityMenuElement;
		if (!tmpMenu) { return; }
		this._clearQualityItems();
		const tmpDocument = tmpMenu.ownerDocument;
		const tmpEntries = this._qualityMenuEntries();
		let tmpSelf = this;
		for (let i = 0; i < tmpEntries.length; i++)
		{
			const tmpValue = tmpEntries[i].Value;
			const tmpItem = tmpDocument.createElement('button');
			tmpItem.setAttribute('type', 'button');
			tmpItem.className = 'psv-quality-item';
			tmpItem.setAttribute('role', 'menuitemradio');
			tmpItem.setAttribute('tabindex', '-1');
			tmpItem.setAttribute('data-quality', String(tmpValue));
			tmpItem.setAttribute('aria-checked', (tmpValue === this._quality) ? 'true' : 'false');
			tmpItem.textContent = tmpEntries[i].Label;
			tmpItem.onclick = function () { tmpSelf._pickQualityFromMenu(tmpValue); };
			tmpMenu.appendChild(tmpItem);
			this._qualityItems.push({ Element: tmpItem, Value: tmpValue });
		}
	}

	/** Update the open menu's labels + checked state in place (rebuilding only when the rung list changed). */
	_syncQualityItems()
	{
		const tmpEntries = this._qualityMenuEntries();
		let tmpSame = (tmpEntries.length === this._qualityItems.length);
		for (let i = 0; tmpSame && i < tmpEntries.length; i++)
		{
			if (tmpEntries[i].Value !== this._qualityItems[i].Value) { tmpSame = false; }
		}
		if (!tmpSame)
		{
			const tmpFocused = this._focusedQualityIndex();
			this._renderQualityItems();
			if (tmpFocused > -1) { this._focusQualityItem(Math.min(tmpFocused, this._qualityItems.length - 1)); }
			return;
		}
		for (let i = 0; i < tmpEntries.length; i++)
		{
			const tmpItem = this._qualityItems[i].Element;
			if (tmpItem.textContent !== tmpEntries[i].Label) { tmpItem.textContent = tmpEntries[i].Label; }
			tmpItem.setAttribute('aria-checked', (tmpEntries[i].Value === this._quality) ? 'true' : 'false');
		}
	}

	_clearQualityItems()
	{
		for (let i = 0; i < this._qualityItems.length; i++)
		{
			this._qualityItems[i].Element.onclick = null;
		}
		this._qualityItems = [];
		if (this._qualityMenuElement)
		{
			while (this._qualityMenuElement.firstChild) { this._qualityMenuElement.removeChild(this._qualityMenuElement.firstChild); }
		}
	}

	_focusedQualityIndex()
	{
		if (typeof document === 'undefined') { return -1; }
		for (let i = 0; i < this._qualityItems.length; i++)
		{
			if (this._qualityItems[i].Element === document.activeElement) { return i; }
		}
		return -1;
	}

	_focusQualityItem(pIndex)
	{
		const tmpEntry = this._qualityItems[pIndex];
		if (!tmpEntry) { return; }
		try { tmpEntry.Element.focus(); } catch (pError) { /* headless */ }
	}

	_pickQualityFromMenu(pValue)
	{
		this.setQuality(pValue);
		this._closeQualityMenu(true);
	}

	/** Menu-button keys: ArrowDown opens on the first item, ArrowUp on the last. */
	_onQualityButtonKeydown(pEvent)
	{
		if (!pEvent) { return; }
		if (pEvent.key === 'ArrowDown' || pEvent.key === 'ArrowUp')
		{
			if (typeof pEvent.preventDefault === 'function') { pEvent.preventDefault(); }
			if (!this._qualityMenuOpen) { this._openQualityMenu((pEvent.key === 'ArrowUp') ? 'last' : 'first'); }
		}
	}

	/** Menu keys: ArrowDown/ArrowUp move (wrapping), Home/End jump, Escape closes back to the button, Tab closes. */
	_onQualityMenuKeydown(pEvent)
	{
		if (!pEvent || !this._qualityItems.length) { return; }
		const tmpCount = this._qualityItems.length;
		const tmpIndex = this._focusedQualityIndex();
		let tmpNext = -1;
		switch (pEvent.key)
		{
			case 'ArrowDown':
				tmpNext = (tmpIndex + 1) % tmpCount;
				break;
			case 'ArrowUp':
				tmpNext = (tmpIndex <= 0) ? (tmpCount - 1) : (tmpIndex - 1);
				break;
			case 'Home':
				tmpNext = 0;
				break;
			case 'End':
				tmpNext = tmpCount - 1;
				break;
			case 'Escape':
				if (typeof pEvent.preventDefault === 'function') { pEvent.preventDefault(); }
				// Keep the Escape inside the menu (a maximized player would otherwise also leave fullscreen).
				if (typeof pEvent.stopPropagation === 'function') { pEvent.stopPropagation(); }
				this._closeQualityMenu(true);
				return;
			case 'Tab':
				this._closeQualityMenu(false);
				return;
			default:
				return;
		}
		if (typeof pEvent.preventDefault === 'function') { pEvent.preventDefault(); }
		this._focusQualityItem(tmpNext);
	}

	/**
	 * Close the quality menu on a pointerdown outside it. A document-level listener is the documented pict exception
	 * (no element-level equivalent for "anywhere else"); it exists only while the menu is open.
	 */
	_installOutsidePointerHandler()
	{
		if (this._outsidePointerHandler || (typeof document === 'undefined') || (typeof document.addEventListener !== 'function')) { return; }
		let tmpSelf = this;
		this._outsidePointerHandler = function (pEvent)
		{
			const tmpWrap = tmpSelf._qualityWrapElement;
			if (tmpWrap && pEvent && pEvent.target && (typeof tmpWrap.contains === 'function') && tmpWrap.contains(pEvent.target)) { return; }
			tmpSelf._closeQualityMenu(false);
		};
		document.addEventListener('pointerdown', this._outsidePointerHandler);
	}

	_removeOutsidePointerHandler()
	{
		if (this._outsidePointerHandler && (typeof document !== 'undefined') && (typeof document.removeEventListener === 'function'))
		{
			document.removeEventListener('pointerdown', this._outsidePointerHandler);
		}
		this._outsidePointerHandler = null;
	}

	// -----------------------------------------------------------------------------------------------------------
	// Storage (localStorage, every access guarded — private mode / opaque origins / disabled storage all throw)
	// -----------------------------------------------------------------------------------------------------------

	_storage()
	{
		try
		{
			if ((typeof window !== 'undefined') && window && window.localStorage) { return window.localStorage; }
		}
		catch (pError) { /* storage unavailable */ }
		return null;
	}

	/** The persisted { Quality, BandwidthEstimate } object ({} when absent or unreadable). */
	_readStoredPreferences()
	{
		const tmpKey = this.options.QualityStorageKey;
		if (!tmpKey) { return {}; }
		try
		{
			const tmpStorage = this._storage();
			if (!tmpStorage) { return {}; }
			const tmpRaw = tmpStorage.getItem(tmpKey);
			if (!tmpRaw) { return {}; }
			const tmpParsed = JSON.parse(tmpRaw);
			return (tmpParsed && (typeof tmpParsed === 'object') && !Array.isArray(tmpParsed)) ? tmpParsed : {};
		}
		catch (pError)
		{
			return {};
		}
	}

	_writeStoredPreferences(pPatch)
	{
		const tmpKey = this.options.QualityStorageKey;
		if (!tmpKey) { return false; }
		try
		{
			const tmpStorage = this._storage();
			if (!tmpStorage) { return false; }
			tmpStorage.setItem(tmpKey, JSON.stringify(Object.assign({}, this._readStoredPreferences(), pPatch)));
			return true;
		}
		catch (pError)
		{
			return false;
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// Control-bar input handlers
	// -----------------------------------------------------------------------------------------------------------

	/** The seek slider moved — map its 0..1000 position onto currentTime. */
	_onSeekInput()
	{
		if (!this._videoElement || !this._seekElement) { return; }
		const tmpDuration = this._duration || this._readDuration();
		if (!tmpDuration) { return; }
		const tmpFraction = Number(this._seekElement.value) / 1000;
		this.seekTo(tmpFraction * tmpDuration);
	}

	/** The volume slider moved — map its 0..100 position onto the element volume (and unmute). */
	_onVolumeInput()
	{
		if (!this._volumeElement) { return; }
		this.setVolume(Number(this._volumeElement.value) / 100);
	}

	// -----------------------------------------------------------------------------------------------------------
	// Control refresh
	// -----------------------------------------------------------------------------------------------------------

	_refreshControls()
	{
		this._refreshPlayButton();
		this._refreshTimeDisplay();
		this._refreshSeek();
		this._refreshBuffered();
		this._refreshVolume();
		this._refreshRate();
		this._refreshQuality();
		this._refreshDownload();
		this._refreshSpinner();
	}

	_refreshPlayButton()
	{
		if (!this._playButtonElement) { return; }
		this._playButtonElement.innerHTML = this._icon(this._playing ? 'Pause' : 'Play');
		this._playButtonElement.setAttribute('title', this._playing ? 'Pause' : 'Play');
	}

	_refreshTimeDisplay()
	{
		if (this._currentTimeElement) { this._currentTimeElement.textContent = this._formatTime(this._currentTime); }
		// Until metadata arrives, show the descriptor's Duration hint (an hls.js player loads nothing before play).
		if (this._durationElement) { this._durationElement.textContent = this._formatTime(this._duration || this._durationHint); }
	}

	_refreshSeek()
	{
		if (!this._seekElement) { return; }
		const tmpDuration = this._duration || this._readDuration();
		this._seekElement.disabled = !tmpDuration;
		// Do not clobber the slider while the reader is scrubbing it (it owns the focus during a drag/keyboard seek).
		if (this._isElementFocused(this._seekElement)) { return; }
		const tmpValue = tmpDuration ? Math.round((this._currentTime / tmpDuration) * 1000) : 0;
		this._seekElement.value = String(Math.max(0, Math.min(1000, tmpValue)));
	}

	/** Recompute the buffered end around the playhead and size the buffered bar on the seek track. */
	_refreshBuffered()
	{
		if (this._videoElement)
		{
			const tmpElementTime = Number(this._videoElement.currentTime);
			const tmpTime = (isFinite(tmpElementTime) && tmpElementTime > 0) ? tmpElementTime : this._currentTime;
			let tmpRanges = null;
			try { tmpRanges = this._videoElement.buffered; } catch (pError) { tmpRanges = null; }
			this._buffered = libStrategy.bufferedEndAt(tmpRanges, tmpTime);
		}
		if (!this._bufferedElement) { return; }
		const tmpDuration = this._duration || this._readDuration();
		const tmpPercent = (tmpDuration > 0) ? Math.max(0, Math.min(100, (this._buffered / tmpDuration) * 100)) : 0;
		this._bufferedElement.style.width = (Math.round(tmpPercent * 10) / 10) + '%';
	}

	/** The buffering spinner shows while the media waits for data (and the initial "Loading…" veil is not up). */
	_refreshSpinner()
	{
		if (!this._spinnerElement) { return; }
		const tmpShow = this._waiting && !this._loadingVisible && !this._error;
		this._spinnerElement.style.display = tmpShow ? 'block' : 'none';
	}

	_refreshVolume()
	{
		if (this._muteButtonElement)
		{
			const tmpSilent = this._muted || this._volume <= 0;
			this._muteButtonElement.innerHTML = this._icon(tmpSilent ? 'VolumeMute' : 'VolumeHigh');
			this._muteButtonElement.setAttribute('title', tmpSilent ? 'Unmute' : 'Mute');
		}
		if (this._volumeElement && !this._isElementFocused(this._volumeElement))
		{
			this._volumeElement.value = String(Math.round((this._muted ? 0 : this._volume) * 100));
		}
	}

	_refreshRate()
	{
		if (!this._rateButtonElement) { return; }
		const tmpRate = this._playbackRate || 1;
		// Trim a trailing .0 (1.0 → "1", 1.25 → "1.25").
		const tmpLabel = (Math.round(tmpRate * 100) / 100).toString();
		this._rateButtonElement.innerHTML = tmpLabel + '&times;';
	}

	_refreshDownload()
	{
		if (!this._downloadElement) { return; }
		const tmpHref = this._effectiveDownloadURL();
		if (tmpHref)
		{
			this._downloadElement.setAttribute('href', tmpHref);
			if (this._downloadName) { this._downloadElement.setAttribute('download', this._downloadName); }
			this._downloadElement.style.display = 'inline-flex';
		}
		else
		{
			this._downloadElement.removeAttribute('href');
			this._downloadElement.style.display = 'none';
		}
	}

	_isElementFocused(pElement)
	{
		return !!(pElement && (typeof document !== 'undefined') && document.activeElement === pElement);
	}

	// -----------------------------------------------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------------------------------------------

	/**
	 * Point the player at a source and pick its playback path. Resets playback to the start.
	 * @param {Object} pSource - { URL, Stream?: { Type:'hls', Manifest, Renditions, ProgressiveURL }, PosterURL?, Title?,
	 *   Name?, DownloadURL? (null = no download anywhere), DownloadName?, Duration? (seconds, shown until metadata) }
	 */
	setSource(pSource)
	{
		let tmpSource = this._normalizeSource(pSource);
		// Keep the prior title when the new source names none (as setVideo always has).
		if (!tmpSource.Title) { tmpSource.Title = this._title; }
		this._applySource(tmpSource);
		this._fallbackTried = { Native: false, Progressive: false };
		this._playingHeight = 0;
		this._pendingRestore = null;
		this._currentTime = 0;

		if (this.targetElement)
		{
			this._loadSource();
		}
	}

	/**
	 * Point the player at a video. Accepts a URL string (shorthand for setSource({ URL })) or a descriptor object
	 * (passed to setSource). Resets playback to the start.
	 * @param {(string|Object)} pInput
	 */
	setVideo(pInput)
	{
		if (typeof pInput === 'string')
		{
			return this.setSource({ URL: pInput });
		}
		return this.setSource((pInput && (typeof pInput === 'object')) ? pInput : {});
	}

	/** The current playback path: 'native-hls' | 'hls.js' | 'progressive' | 'unsupported' ('' before a load). */
	getStrategy()
	{
		return this._strategy;
	}

	/**
	 * The available rungs, highest first: [{ Index, Height (short side), Width, PixelHeight, Bandwidth, Label }].
	 * From hls.js `levels` under hls.js, from Stream.Renditions under native HLS; [] for a progressive file.
	 */
	getQualityLevels()
	{
		let tmpLevels = [];
		if (this._strategy === libStrategy.STRATEGY_HLSJS)
		{
			tmpLevels = this._hls ? libStrategy.qualityLevelsFromHls(this._hls.levels) : [];
		}
		else if (this._strategy === libStrategy.STRATEGY_NATIVE_HLS)
		{
			tmpLevels = this._nativeLevels();
		}
		return tmpLevels.map(function (pLevel)
		{
			return (
			{
				Index: pLevel.Index,
				Height: pLevel.Height,
				Width: pLevel.Width,
				PixelHeight: pLevel.PixelHeight,
				Bandwidth: pLevel.Bandwidth,
				Label: pLevel.Label
			});
		});
	}

	/**
	 * Pick a quality: 'auto', 'saver' (Data saver) or a short side in pixels (e.g. 1080). The pick persists under
	 * QualityStorageKey. Under hls.js an explicit pick switches at the next fragment while playing (no restart) or
	 * immediately while paused; under native HLS it loads that rung's playlist at the same position.
	 * @return {boolean} false when the pick is not understood
	 */
	setQuality(pQuality)
	{
		const tmpQuality = libStrategy.normalizeQuality(pQuality);
		if (tmpQuality === null) { return false; }
		this._quality = tmpQuality;
		this._writeStoredPreferences({ Quality: tmpQuality });

		if ((this._strategy === libStrategy.STRATEGY_HLSJS) && this._hls)
		{
			this._applyQualityToHls();
		}
		else if ((this._strategy === libStrategy.STRATEGY_NATIVE_HLS) && this._videoElement)
		{
			const tmpURL = this._nativeURLForQuality();
			if (tmpURL && (tmpURL !== this._playingURL))
			{
				this._loadVideo(tmpURL, { PreservePosition: true });
			}
		}
		this._refreshQuality();
		return true;
	}

	/** The current pick: 'auto' | 'saver' | a short side in pixels. */
	getQuality()
	{
		return this._quality;
	}

	/** Start playback (best-effort — a browser may reject autoplay; headless is a no-op). */
	play()
	{
		if (!this._videoElement) { return; }
		this._notePlayIntent(true);
		this._requestHlsLoad();
		try
		{
			const tmpResult = this._videoElement.play();
			if (tmpResult && (typeof tmpResult.catch === 'function')) { tmpResult.catch(() => { /* autoplay rejected */ }); }
		}
		catch (pError) { /* headless / unsupported */ }
	}

	/** Pause playback. */
	pause()
	{
		if (!this._videoElement) { return; }
		// Noted here and not only in _onPause: during a reload the element is often already paused (load() pauses it
		// silently), so this call fires no pause event.
		this._notePlayIntent(false);
		try { this._videoElement.pause(); } catch (pError) { /* headless */ }
	}

	/** Toggle play/pause. */
	togglePlay()
	{
		if (this._playing) { this.pause(); } else { this.play(); }
	}

	/** Seek to an absolute time in seconds (clamped to the known duration). */
	seekTo(pSeconds)
	{
		if (!this._videoElement) { return; }
		let tmpSeconds = Number(pSeconds);
		if (!isFinite(tmpSeconds) || tmpSeconds < 0) { tmpSeconds = 0; }
		const tmpDuration = this._duration || this._readDuration();
		if (tmpDuration && tmpSeconds > tmpDuration) { tmpSeconds = tmpDuration; }
		if (this._pendingRestore && !this._loaded)
		{
			// A reload is in flight: move its restore point, or loadedmetadata would seek back to the old one.
			this._pendingRestore.Time = tmpSeconds;
		}
		else if (this._hls && !this._hlsStarted)
		{
			// hls.js has loaded nothing yet: remember the start point for startLoad() rather than seeking an empty element.
			this._pendingRestore = { Time: tmpSeconds, Paused: !this._playing };
		}
		try { this._videoElement.currentTime = tmpSeconds; } catch (pError) { /* headless */ }
		this._currentTime = tmpSeconds;
		this._refreshTimeDisplay();
	}

	/** Set the volume (0..1); any positive volume also unmutes. */
	setVolume(pVolume)
	{
		let tmpVolume = Number(pVolume);
		if (!isFinite(tmpVolume)) { tmpVolume = 0; }
		tmpVolume = Math.min(1, Math.max(0, tmpVolume));
		this._volume = tmpVolume;
		if (this._videoElement)
		{
			try { this._videoElement.volume = tmpVolume; } catch (pError) { /* headless */ }
			this._videoElement.muted = (tmpVolume <= 0);
		}
		this._muted = (tmpVolume <= 0);
		this._refreshVolume();
	}

	/** Toggle mute. */
	toggleMute()
	{
		this._muted = !this._muted;
		if (this._videoElement) { this._videoElement.muted = this._muted; }
		this._refreshVolume();
	}

	/** Step to the next playback rate in the configured cycle. */
	cyclePlaybackRate()
	{
		if (!this._playbackRates.length) { return; }
		let tmpIndex = this._playbackRates.indexOf(this._playbackRate);
		tmpIndex = (tmpIndex + 1) % this._playbackRates.length;
		this.setPlaybackRate(this._playbackRates[tmpIndex]);
	}

	/** Set the playback rate directly. */
	setPlaybackRate(pRate)
	{
		let tmpRate = Number(pRate);
		if (!isFinite(tmpRate) || tmpRate <= 0) { tmpRate = 1; }
		this._playbackRate = tmpRate;
		if (this._videoElement) { try { this._videoElement.playbackRate = tmpRate; } catch (pError) { /* headless */ } }
		this._refreshRate();
	}

	// -----------------------------------------------------------------------------------------------------------
	// Fullscreen — real fullscreen where the platform allows it, a fill-the-viewport maximize otherwise
	// -----------------------------------------------------------------------------------------------------------

	/** Toggle fullscreen. */
	toggleFullscreen()
	{
		if (this.isFullscreen()) { return this.exitFullscreen(); }
		return this.enterFullscreen();
	}

	/**
	 * Go fullscreen: requestFullscreen() on the player root (desktop, Android, iPad), else webkitEnterFullscreen() on
	 * the <video> (iPhone's native player), else the CSS maximize (fill the browser viewport; Esc restores).
	 * @return {boolean} true when it acted (or the player is already fullscreen)
	 */
	enterFullscreen()
	{
		if (this._fullscreen) { return true; }
		const tmpRoot = this._rootElement;
		const tmpVideo = this._videoElement;
		if (!tmpRoot && !tmpVideo) { return false; }

		const tmpRequest = tmpRoot ? (tmpRoot.requestFullscreen || tmpRoot.webkitRequestFullscreen) : null;
		if (typeof tmpRequest === 'function')
		{
			this._fullscreen = true;
			this._fullscreenMode = 'api';
			const tmpPending = { Root: tmpRoot };
			this._fullscreenPending = tmpPending;
			tmpRoot.classList.add('psv-fullscreen');
			this._installFullscreenChangeHandler();
			this._refreshFullscreenButton();
			let tmpSelf = this;
			try
			{
				const tmpResult = tmpRequest.call(tmpRoot);
				// The prefixed form returns nothing: its landing is seen only as a (webkit)fullscreenchange.
				if (tmpResult && (typeof tmpResult.then === 'function'))
				{
					tmpResult.then(
						function () { tmpSelf._onFullscreenRequestSettled(tmpPending); },
						function () { tmpSelf._onFullscreenRequestRejected(tmpPending); });
				}
			}
			catch (pError)
			{
				this._onFullscreenRequestRejected(tmpPending);
			}
			return true;
		}

		if (tmpVideo && (typeof tmpVideo.webkitEnterFullscreen === 'function'))
		{
			try
			{
				tmpVideo.webkitEnterFullscreen();
				this._fullscreen = true;
				this._fullscreenMode = 'webkit';
				this._installWebkitEndFullscreenHandler(tmpVideo);
				this._refreshFullscreenButton();
				return true;
			}
			catch (pError)
			{
				// Not ready yet (no metadata) — fall through to the CSS maximize.
			}
		}

		return this._enterCSSFullscreen();
	}

	/** Leave fullscreen, whichever kind is active. @return {boolean} true when it acted */
	exitFullscreen()
	{
		if (!this._fullscreen) { return false; }
		const tmpMode = this._fullscreenMode;
		this._fullscreen = false;
		this._fullscreenMode = '';
		if (this._rootElement) { this._rootElement.classList.remove('psv-fullscreen'); }
		this._removeEscapeHandler();

		if ((tmpMode === 'api') && this._rootElement && (this._fullscreenElement() === this._rootElement))
		{
			// The request has landed: nothing is left in flight to undo later.
			this._fullscreenPending = null;
			this._exitDocumentFullscreen();
		}
		else if (tmpMode === 'webkit')
		{
			const tmpVideo = this._webkitFullscreenVideo || this._videoElement;
			this._removeWebkitEndFullscreenHandler();
			if (tmpVideo && (typeof tmpVideo.webkitExitFullscreen === 'function'))
			{
				try { tmpVideo.webkitExitFullscreen(); } catch (pError) { /* already out */ }
			}
		}

		// A requestFullscreen() still in flight (a quick second click) has nothing to leave yet: keep its
		// fullscreenchange listener so the landing is undone; otherwise the listener goes now.
		if (!this._fullscreenPending) { this._removeFullscreenChangeHandler(); }

		this._refreshFullscreenButton();
		return true;
	}

	/** Ask the document to leave real fullscreen (standard or webkit-prefixed); a no-op where neither exists. */
	_exitDocumentFullscreen()
	{
		const tmpExit = (typeof document !== 'undefined') ? (document.exitFullscreen || document.webkitExitFullscreen) : null;
		if (typeof tmpExit !== 'function') { return; }
		try
		{
			const tmpResult = tmpExit.call(document);
			if (tmpResult && (typeof tmpResult.catch === 'function')) { tmpResult.catch(() => { /* already out */ }); }
		}
		catch (pError) { /* already out */ }
	}

	/** Is the player fullscreen (real or maximized)? Kept honest by fullscreenchange / webkitendfullscreen. */
	isFullscreen()
	{
		return this._fullscreen;
	}

	/** The CSS maximize: lift the player out of its host box to fill the browser viewport (Esc or the button restores). */
	_enterCSSFullscreen()
	{
		if (!this._rootElement) { return false; }
		this._fullscreen = true;
		this._fullscreenMode = 'css';
		this._rootElement.classList.add('psv-fullscreen');
		this._installEscapeHandler();
		this._refreshFullscreenButton();
		return true;
	}

	/**
	 * A requestFullscreen() landed (its promise resolved, or — for the prefixed form — its fullscreenchange arrived).
	 * Still wanted: fullscreenchange tracks it from here. Exited while it was in flight: leave real fullscreen now.
	 * @param {Object} pPending - the { Root } enterFullscreen() issued (a superseded or already-settled one is ignored)
	 */
	_onFullscreenRequestSettled(pPending)
	{
		if (!pPending || (this._fullscreenPending !== pPending)) { return; }
		this._fullscreenPending = null;
		if (this._fullscreenMode === 'api') { return; }
		this._removeFullscreenChangeHandler();
		if (this._fullscreenElement() === pPending.Root) { this._exitDocumentFullscreen(); }
	}

	/** requestFullscreen() was refused (no user gesture, disallowed in an iframe): keep the CSS maximize instead. */
	_onFullscreenRequestRejected(pPending)
	{
		if (!pPending || (this._fullscreenPending !== pPending)) { return; }
		this._fullscreenPending = null;
		if (this._fullscreenMode !== 'api')
		{
			// Exited while it was in flight: the listener was kept only for this request.
			this._removeFullscreenChangeHandler();
			return;
		}
		if ((this._rootElement !== pPending.Root) || (this._fullscreenElement() === pPending.Root)) { return; }
		this._removeFullscreenChangeHandler();
		this._fullscreenMode = 'css';
		this._installEscapeHandler();
	}

	/** The document's current fullscreen element (standard or webkit-prefixed), or null. */
	_fullscreenElement()
	{
		if (typeof document === 'undefined') { return null; }
		return document.fullscreenElement || document.webkitFullscreenElement || null;
	}

	/** fullscreenchange: leaving real fullscreen (Esc, the browser UI, a swipe) clears our state. */
	_onFullscreenChange()
	{
		const tmpPending = this._fullscreenPending;
		if (this._fullscreenMode !== 'api')
		{
			// Only a request still in flight keeps this listener past an exit; act once it has landed.
			if (tmpPending && (this._fullscreenElement() === tmpPending.Root)) { this._onFullscreenRequestSettled(tmpPending); }
			else if (!tmpPending) { this._removeFullscreenChangeHandler(); }
			return;
		}
		if (this._rootElement && (this._fullscreenElement() === this._rootElement))
		{
			// Landed (or still in): nothing in flight any more.
			this._fullscreenPending = null;
			this._fullscreen = true;
			this._refreshFullscreenButton();
			return;
		}
		// Our request has not landed yet: this change is someone else's (another element leaving fullscreen).
		if (tmpPending && (tmpPending.Root === this._rootElement)) { return; }
		this._fullscreen = false;
		this._fullscreenMode = '';
		if (this._rootElement) { this._rootElement.classList.remove('psv-fullscreen'); }
		this._removeFullscreenChangeHandler();
		this._refreshFullscreenButton();
	}

	/** webkitendfullscreen: the iPhone's native player was dismissed. */
	_onWebkitEndFullscreen()
	{
		if (this._fullscreenMode !== 'webkit') { return; }
		this._fullscreen = false;
		this._fullscreenMode = '';
		this._removeWebkitEndFullscreenHandler();
		this._refreshFullscreenButton();
	}

	/** Swap the maximize/restore glyph + title to match the current state. */
	_refreshFullscreenButton()
	{
		if (!this._fullscreenButtonElement) { return; }
		this._fullscreenButtonElement.innerHTML = this._icon(this._fullscreen ? 'Minimize' : 'Maximize');
		this._fullscreenButtonElement.setAttribute('title', this._fullscreen ? 'Exit full screen' : 'Full screen');
	}

	/**
	 * Install a document-level Escape handler while CSS-maximized. A document keydown listener is the documented pict
	 * exception (a browser-level event with no element-level inline equivalent). It is added only while maximized
	 * and removed on exit / destroy. (Real fullscreen gets Escape from the browser itself.)
	 */
	_installEscapeHandler()
	{
		if (this._keydownHandler || (typeof document === 'undefined') || (typeof document.addEventListener !== 'function')) { return; }
		let tmpSelf = this;
		this._keydownHandler = function (pEvent)
		{
			if (pEvent && pEvent.key === 'Escape' && tmpSelf._fullscreen && (tmpSelf._fullscreenMode === 'css')) { tmpSelf.exitFullscreen(); }
		};
		document.addEventListener('keydown', this._keydownHandler);
	}

	/** Remove the document-level Escape handler. */
	_removeEscapeHandler()
	{
		if (this._keydownHandler && (typeof document !== 'undefined') && (typeof document.removeEventListener === 'function'))
		{
			document.removeEventListener('keydown', this._keydownHandler);
		}
		this._keydownHandler = null;
	}

	/**
	 * Listen for fullscreenchange (and Safari's webkitfullscreenchange) while in real fullscreen — the same documented
	 * document-level exception as the Escape handler; installed on enter, removed on exit / destroy.
	 */
	_installFullscreenChangeHandler()
	{
		if (this._fullscreenChangeHandler || (typeof document === 'undefined') || (typeof document.addEventListener !== 'function')) { return; }
		let tmpSelf = this;
		this._fullscreenChangeHandler = function () { tmpSelf._onFullscreenChange(); };
		document.addEventListener('fullscreenchange', this._fullscreenChangeHandler);
		document.addEventListener('webkitfullscreenchange', this._fullscreenChangeHandler);
	}

	_removeFullscreenChangeHandler()
	{
		if (this._fullscreenChangeHandler && (typeof document !== 'undefined') && (typeof document.removeEventListener === 'function'))
		{
			document.removeEventListener('fullscreenchange', this._fullscreenChangeHandler);
			document.removeEventListener('webkitfullscreenchange', this._fullscreenChangeHandler);
		}
		this._fullscreenChangeHandler = null;
	}

	/**
	 * Listen for the iPhone native player closing. `webkitendfullscreen` has no `on…` element property, so this is
	 * an addEventListener on our own <video> (installed on enter, removed on exit / release / destroy).
	 */
	_installWebkitEndFullscreenHandler(pVideo)
	{
		this._removeWebkitEndFullscreenHandler();
		if (!pVideo || (typeof pVideo.addEventListener !== 'function')) { return; }
		let tmpSelf = this;
		this._webkitEndFullscreenHandler = function () { tmpSelf._onWebkitEndFullscreen(); };
		this._webkitFullscreenVideo = pVideo;
		pVideo.addEventListener('webkitendfullscreen', this._webkitEndFullscreenHandler);
	}

	_removeWebkitEndFullscreenHandler()
	{
		if (this._webkitEndFullscreenHandler && this._webkitFullscreenVideo && (typeof this._webkitFullscreenVideo.removeEventListener === 'function'))
		{
			this._webkitFullscreenVideo.removeEventListener('webkitendfullscreen', this._webkitEndFullscreenHandler);
		}
		this._webkitEndFullscreenHandler = null;
		this._webkitFullscreenVideo = null;
	}

	/** Register the player glyphs in the icon registry (idempotent; no-op without an Icon provider). */
	_ensureIcons()
	{
		if (!this.pict || !this.pict.providers || !this.pict.providers.Icon || (typeof this.pict.providers.Icon.registerSet !== 'function')) { return; }
		this.pict.providers.Icon.registerSet(
		{
			Outline:
			{
				Play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>',
				Pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
				VolumeHigh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
				VolumeMute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
				Maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
				Minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
			}
		});
	}

	/** A snapshot of the player's current state (handy for hosts and tests). */
	getState()
	{
		return (
		{
			URL: this._url,
			Loaded: this._loaded,
			Error: this._error,
			ErrorMessage: this._errorMessage,
			Playing: this._playing,
			Duration: this._duration || this._durationHint,
			CurrentTime: this._currentTime,
			Muted: this._muted,
			Volume: this._volume,
			PlaybackRate: this._playbackRate,
			Fullscreen: this._fullscreen,
			Strategy: this._strategy,
			Quality: this._quality,
			PlayingHeight: this._playingHeight,
			Levels: this.getQualityLevels(),
			Buffered: this._buffered,
			Waiting: this._waiting
		});
	}

	/** Tear down handlers, hls.js and fullscreen, and clear the player. */
	destroy()
	{
		this._closeQualityMenu(false);
		this._removeOutsidePointerHandler();
		this._clearQualityItems();

		// Leave real fullscreen if we hold it, then drop every fullscreen listener. (A request still in flight is undone
		// by _onFullscreenRequestSettled if it lands; the root leaving the document normally refuses it.)
		if ((this._fullscreenMode === 'api') && this._rootElement && (this._fullscreenElement() === this._rootElement))
		{
			this._fullscreenPending = null;
			this._exitDocumentFullscreen();
		}
		this._removeEscapeHandler();
		this._removeFullscreenChangeHandler();
		this._removeWebkitEndFullscreenHandler();
		this._fullscreen = false;
		this._fullscreenMode = '';

		this._teardownHls();
		this._pendingRestore = null;

		if (this._videoElement)
		{
			this._releaseVideoElement(this._videoElement);
		}
		if (this._playButtonElement) { this._playButtonElement.onclick = null; }
		if (this._muteButtonElement) { this._muteButtonElement.onclick = null; }
		if (this._rateButtonElement) { this._rateButtonElement.onclick = null; }
		if (this._fullscreenButtonElement) { this._fullscreenButtonElement.onclick = null; }
		if (this._seekElement) { this._seekElement.oninput = null; }
		if (this._volumeElement) { this._volumeElement.oninput = null; }
		if (this._qualityButtonElement)
		{
			this._qualityButtonElement.onclick = null;
			this._qualityButtonElement.onkeydown = null;
		}
		if (this._qualityMenuElement) { this._qualityMenuElement.onkeydown = null; }

		if (this.targetElement && this.pict && this.pict.ContentAssignment)
		{
			this.pict.ContentAssignment.assignContent(this.options.TargetElementAddress, '');
		}
		this._rootElement = null;
		this._stageElement = null;
		this._videoElement = null;
		this._loadingElement = null;
		this._spinnerElement = null;
		this._controlsElement = null;
		this._playButtonElement = null;
		this._seekElement = null;
		this._bufferedElement = null;
		this._currentTimeElement = null;
		this._durationElement = null;
		this._muteButtonElement = null;
		this._volumeElement = null;
		this._rateButtonElement = null;
		this._qualityWrapElement = null;
		this._qualityButtonElement = null;
		this._qualityMenuElement = null;
		this._downloadElement = null;
		this._fullscreenButtonElement = null;
	}

	// -----------------------------------------------------------------------------------------------------------
	// Small utilities
	// -----------------------------------------------------------------------------------------------------------

	/** A themable glyph from the icon registry; '' when no registry is present. */
	_icon(pName)
	{
		if (!this.pict || (typeof this.pict.icon !== 'function')) { return ''; }
		try { return this.pict.icon(pName); }
		catch (pError) { return ''; }
	}

	/** Format seconds as m:ss (or h:mm:ss past an hour); '0:00' for an unknown/zero duration. */
	_formatTime(pSeconds)
	{
		let tmpSeconds = Number(pSeconds);
		if (!isFinite(tmpSeconds) || tmpSeconds < 0) { tmpSeconds = 0; }
		tmpSeconds = Math.floor(tmpSeconds);
		const tmpHours = Math.floor(tmpSeconds / 3600);
		const tmpMinutes = Math.floor((tmpSeconds % 3600) / 60);
		const tmpSecs = tmpSeconds % 60;
		const tmpPad = function (pValue) { return (pValue < 10) ? ('0' + pValue) : String(pValue); };
		if (tmpHours > 0) { return tmpHours + ':' + tmpPad(tmpMinutes) + ':' + tmpPad(tmpSecs); }
		return tmpMinutes + ':' + tmpPad(tmpSecs);
	}

	/** Escape HTML metacharacters for safe interpolation into built markup. */
	_esc(pText)
	{
		if (pText === null || typeof pText === 'undefined') { return ''; }
		return String(pText)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
}

module.exports = PictSectionVideo;

module.exports.default_configuration = _DefaultConfiguration;
module.exports.Strategy = libStrategy;
