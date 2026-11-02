const libPictViewClass = require('pict-view');
const _DefaultConfiguration = require('./Pict-Section-Video-DefaultConfiguration.js');

/**
 * pict-section-video — a bespoke, responsive video player section.
 *
 * Drop it on a page, point it at a video URL, and it fits the whole frame to the stage on phones, tablets,
 * desktops and projected displays, with its own control bar (play/pause, a seek scrubber, a time readout,
 * mute + volume, a playback-rate cycle, download and maximize). Seeking rides the browser's native HTTP Range
 * requests, so a range-served file (orator-file-service, a Sluice depot, a bare 206 URL) scrubs without
 * downloading the whole clip.
 *
 * It is a single pict-view in the lightweight single-view shape (like pict-section-image / pict-section-code): a
 * stub container template, with the player DOM built imperatively in onAfterInitialRender — a <video> is
 * inherently imperative (its src, buffered/seekable ranges, and the load/timeupdate/play/pause events have no
 * template equivalent).
 *
 * Standalone, or driven as the video renderer inside pict-section-fileview: the fileview delegate mounts it with
 * ShowFullscreen:false and ShowDownload:false (fileview owns those) but keeps the control bar (ShowToolbar:true),
 * and feeds files through setVideo().
 *
 * Event wiring note: the control-bar buttons, the seek/volume inputs and the <video>'s media events use
 * element-property handlers (`el.onclick = ...`, `video.ontimeupdate = ...`), not addEventListener and not
 * template inline handlers. The pict rule against addEventListener is about listeners silently lost on template
 * re-render; this widget is built once imperatively and never re-rendered by the template engine, element-property
 * handlers cannot duplicate, and the <video>'s media events have no template-handler equivalent — the same
 * programmatic-element exception pict-section-code / pict-section-image document.
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
		this._controlsElement = null;
		this._playButtonElement = null;
		this._seekElement = null;
		this._currentTimeElement = null;
		this._durationElement = null;
		this._muteButtonElement = null;
		this._volumeElement = null;
		this._rateButtonElement = null;
		this._downloadElement = null;
		this._fullscreenButtonElement = null;

		// Fullscreen (fill-the-viewport) state + the document Escape handler installed only while maximized.
		this._fullscreen = false;
		this._keydownHandler = null;

		// View state.
		this._url = this.options.VideoURL || '';
		this._posterURL = this.options.PosterURL || '';
		this._title = this.options.Title || '';
		this._downloadURL = this.options.DownloadURL || '';
		this._downloadName = this.options.DownloadName || '';

		this._loaded = false;       // metadata (duration/dimensions) available
		this._error = false;
		this._playing = false;
		this._duration = 0;
		this._currentTime = 0;
		this._muted = !!this.options.Muted;
		this._volume = (typeof this.options.Volume === 'number') ? Math.min(1, Math.max(0, this.options.Volume)) : 1;
		this._playbackRate = 1;

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
		// container template over our built DOM. Instance state (_url, _currentTime) persists, so a rebuild re-loads
		// the current video; this makes a re-render self-healing rather than silently wiping the player.
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

		this._buildPlayerDOM();

		if (this._url)
		{
			this._loadVideo(this._url);
		}
	}

	// -----------------------------------------------------------------------------------------------------------
	// DOM construction (once)
	// -----------------------------------------------------------------------------------------------------------

	/**
	 * Build the player chrome into the target element, then grab references and wire the element-property handlers.
	 * Called once from onAfterInitialRender.
	 */
	_buildPlayerDOM()
	{
		const tmpBase = this.Hash;

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
			tmpControls = '<div class="psv-controls" id="' + tmpBase + '-Controls">'
				+ '<button type="button" class="psv-btn psv-play-btn" id="' + tmpBase + '-PlayBtn" title="Play">' + this._icon('Play') + '</button>'
				+ '<span class="psv-time psv-current" id="' + tmpBase + '-Current">0:00</span>'
				+ '<input type="range" class="psv-seek" id="' + tmpBase + '-Seek" min="0" max="1000" value="0" step="1" disabled title="Seek" />'
				+ '<span class="psv-time psv-duration" id="' + tmpBase + '-Duration">0:00</span>'
				+ '<button type="button" class="psv-btn psv-mute-btn" id="' + tmpBase + '-MuteBtn" title="Mute">' + this._icon(this._muted ? 'VolumeMute' : 'VolumeHigh') + '</button>'
				+ '<input type="range" class="psv-volume" id="' + tmpBase + '-Volume" min="0" max="100" value="' + Math.round(this._volume * 100) + '" step="1" title="Volume" />'
				+ '<button type="button" class="psv-btn psv-rate" id="' + tmpBase + '-RateBtn" title="Playback speed">1&times;</button>'
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
			+ '</div>'
			+ tmpControls
			+ '</div>';

		this.pict.ContentAssignment.assignContent(this.options.TargetElementAddress, tmpHTML);

		// Reference grab (querySelector within the owned subtree is fine — these are nodes we just built).
		this._rootElement = this._queryOwned('#' + tmpBase + '-Root');
		this._stageElement = this._queryOwned('#' + tmpBase + '-Stage');
		this._videoElement = this._queryOwned('#' + tmpBase + '-Video');
		this._loadingElement = this._queryOwned('#' + tmpBase + '-Loading');
		this._controlsElement = this._queryOwned('#' + tmpBase + '-Controls');
		this._playButtonElement = this._queryOwned('#' + tmpBase + '-PlayBtn');
		this._seekElement = this._queryOwned('#' + tmpBase + '-Seek');
		this._currentTimeElement = this._queryOwned('#' + tmpBase + '-Current');
		this._durationElement = this._queryOwned('#' + tmpBase + '-Duration');
		this._muteButtonElement = this._queryOwned('#' + tmpBase + '-MuteBtn');
		this._volumeElement = this._queryOwned('#' + tmpBase + '-Volume');
		this._rateButtonElement = this._queryOwned('#' + tmpBase + '-RateBtn');
		this._downloadElement = this._queryOwned('#' + tmpBase + '-Download');
		this._fullscreenButtonElement = this._queryOwned('#' + tmpBase + '-FullscreenBtn');

		this._wireMediaElement();
		this._wireControls();

		// Apply the initial volume/mute to the element so the control bar and the media agree from the first frame.
		if (this._videoElement)
		{
			try { this._videoElement.volume = this._volume; } catch (pError) { /* headless */ }
			this._videoElement.muted = this._muted;
		}

		// If a host re-render re-stamped the stub over a maximized player, the rebuilt root lost the class —
		// re-apply it so the rebuild stays in fullscreen (instance state persists). The Escape handler lives on
		// document, so it survives the rebuild and needs no re-attaching.
		if (this._fullscreen && this._rootElement)
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
		if (this.options.ClickToPlay)
		{
			this._videoElement.onclick = function () { tmpSelf.togglePlay(); };
		}
	}

	/** Wire the control-bar buttons + sliders (element-property handlers). */
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
	}

	/** querySelector scoped to the player subtree, via ContentAssignment, returning the element or null. */
	_queryOwned(pSelector)
	{
		let tmpSet = this.services.ContentAssignment.getElement(pSelector);
		return (tmpSet && tmpSet.length > 0) ? tmpSet[0] : null;
	}

	// -----------------------------------------------------------------------------------------------------------
	// Media loading
	// -----------------------------------------------------------------------------------------------------------

	_loadVideo(pURL)
	{
		this._loaded = false;
		this._error = false;
		this._playing = false;
		this._duration = 0;
		this._currentTime = 0;

		// Recover from a prior error: _paintErrorState replaced the stage contents and dropped the <video>, so
		// rebuild the player DOM (which recreates a fresh <video> + loading element) before loading.
		if (!this._videoElement && this.targetElement)
		{
			this._buildPlayerDOM();
		}
		if (!this._videoElement) { return; }

		if (this._posterURL) { this._videoElement.setAttribute('poster', this._posterURL); }
		else { this._videoElement.removeAttribute('poster'); }

		if (!pURL)
		{
			this._videoElement.removeAttribute('src');
			this._setLoadingVisible(false);
			this._refreshControls();
			return;
		}

		this._setLoadingVisible(true);
		this._videoElement.setAttribute('src', pURL);
		// Ask the element to (re)load the new source; harmless where load() is unavailable.
		try { if (typeof this._videoElement.load === 'function') { this._videoElement.load(); } }
		catch (pError) { /* headless / unsupported */ }

		this._refreshControls();
	}

	_onLoadedMetadata()
	{
		this._loaded = true;
		this._error = false;
		this._duration = this._readDuration();
		this._setLoadingVisible(false);
		this._refreshControls();
	}

	_onTimeUpdate()
	{
		this._currentTime = this._videoElement ? (this._videoElement.currentTime || 0) : 0;
		if (!this._duration) { this._duration = this._readDuration(); }
		this._refreshTimeDisplay();
		this._refreshSeek();
	}

	_onPlay() { this._playing = true; this._refreshPlayButton(); }
	_onPause() { this._playing = false; this._refreshPlayButton(); }
	_onEnded() { this._playing = false; this._refreshPlayButton(); }

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

	_onError()
	{
		this._loaded = false;
		this._error = true;
		this._playing = false;
		this._setLoadingVisible(false);
		this._paintErrorState();
	}

	/** The media element's duration, or 0 when it is not a finite positive number (unknown / headless). */
	_readDuration()
	{
		if (!this._videoElement) { return 0; }
		const tmpDuration = this._videoElement.duration;
		return (typeof tmpDuration === 'number' && isFinite(tmpDuration) && tmpDuration > 0) ? tmpDuration : 0;
	}

	_setLoadingVisible(pVisible)
	{
		if (this._loadingElement) { this._loadingElement.style.display = pVisible ? 'flex' : 'none'; }
	}

	_paintErrorState()
	{
		if (!this._stageElement) { return; }
		let tmpDownload = '';
		if (this._downloadURL || this._url)
		{
			tmpDownload = '<a class="psv-btn" href="' + this._esc(this._downloadURL || this._url) + '" download'
				+ (this._downloadName ? ('="' + this._esc(this._downloadName) + '"') : '')
				+ '>' + this._icon('Download') + ' Download</a>';
		}
		const tmpBase = this.Hash;
		this.pict.ContentAssignment.assignContent('#' + tmpBase + '-Stage',
			'<div class="psv-error"><span class="psv-error-glyph">' + this._icon('Play') + '</span>'
			+ '<p>This video could not be played.</p>' + tmpDownload + '</div>');
		// The <video> node was replaced by the error block; drop stale references so a later setVideo rebuilds.
		this._videoElement = null;
		this._loadingElement = null;
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
		this._refreshVolume();
		this._refreshRate();
		this._refreshDownload();
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
		if (this._durationElement) { this._durationElement.textContent = this._formatTime(this._duration); }
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
		const tmpHref = this._downloadURL || this._url;
		if (tmpHref)
		{
			this._downloadElement.setAttribute('href', tmpHref);
			if (this._downloadName) { this._downloadElement.setAttribute('download', this._downloadName); }
			this._downloadElement.style.display = 'inline-flex';
		}
		else
		{
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
	 * Point the player at a video. Accepts a URL string or a descriptor object
	 * ({ URL, PosterURL?, Title?, Name?, DownloadURL?, DownloadName? }). Resets playback to the start.
	 * @param {(string|Object)} pInput
	 */
	setVideo(pInput)
	{
		let tmpURL = '';
		let tmpPoster = '';
		let tmpTitle = this._title;
		let tmpDownloadURL = '';
		let tmpDownloadName = '';

		if (typeof pInput === 'string')
		{
			tmpURL = pInput;
		}
		else if (pInput && typeof pInput === 'object')
		{
			tmpURL = pInput.URL || pInput.Url || pInput.VideoURL || '';
			tmpPoster = pInput.PosterURL || pInput.Poster || '';
			tmpTitle = pInput.Title || pInput.Name || this._title;
			tmpDownloadURL = pInput.DownloadURL || '';
			tmpDownloadName = pInput.DownloadName || pInput.Name || '';
		}

		this._url = tmpURL;
		this._posterURL = tmpPoster || '';
		this._title = tmpTitle || '';
		this._downloadURL = tmpDownloadURL || tmpURL;
		this._downloadName = tmpDownloadName || '';

		if (this.targetElement)
		{
			this._loadVideo(tmpURL);
		}
	}

	/** Start playback (best-effort — a browser may reject autoplay; headless is a no-op). */
	play()
	{
		if (!this._videoElement) { return; }
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
	// Fullscreen — fill the browser viewport, and back
	// -----------------------------------------------------------------------------------------------------------

	/** Toggle the maximized (fill-the-viewport) presentation. */
	toggleFullscreen()
	{
		if (this._fullscreen) { this.exitFullscreen(); } else { this.enterFullscreen(); }
	}

	/** Maximize: lift the player out of its host box to fill the browser viewport (Esc or the button restores it). */
	enterFullscreen()
	{
		if (this._fullscreen) { return; }
		this._fullscreen = true;
		if (this._rootElement) { this._rootElement.classList.add('psv-fullscreen'); }
		this._installEscapeHandler();
		this._refreshFullscreenButton();
	}

	/** Restore the player to its host box. */
	exitFullscreen()
	{
		if (!this._fullscreen) { return; }
		this._fullscreen = false;
		if (this._rootElement) { this._rootElement.classList.remove('psv-fullscreen'); }
		this._removeEscapeHandler();
		this._refreshFullscreenButton();
	}

	/** Is the player currently maximized? */
	isFullscreen()
	{
		return this._fullscreen;
	}

	/** Swap the maximize/restore glyph + title to match the current state. */
	_refreshFullscreenButton()
	{
		if (!this._fullscreenButtonElement) { return; }
		this._fullscreenButtonElement.innerHTML = this._icon(this._fullscreen ? 'Minimize' : 'Maximize');
		this._fullscreenButtonElement.setAttribute('title', this._fullscreen ? 'Exit full screen' : 'Full screen');
	}

	/**
	 * Install a document-level Escape handler while maximized. A document keydown listener is the documented pict
	 * exception (a browser-level event with no element-level inline equivalent). It is added only while fullscreen
	 * and removed on exit / destroy.
	 */
	_installEscapeHandler()
	{
		if (this._keydownHandler || (typeof document === 'undefined') || (typeof document.addEventListener !== 'function')) { return; }
		let tmpSelf = this;
		this._keydownHandler = function (pEvent)
		{
			if (pEvent && pEvent.key === 'Escape' && tmpSelf._fullscreen) { tmpSelf.exitFullscreen(); }
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
			Playing: this._playing,
			Duration: this._duration,
			CurrentTime: this._currentTime,
			Muted: this._muted,
			Volume: this._volume,
			PlaybackRate: this._playbackRate,
			Fullscreen: this._fullscreen
		});
	}

	/** Tear down handlers and clear the player. */
	destroy()
	{
		this._removeEscapeHandler();
		this._fullscreen = false;

		if (this._videoElement)
		{
			try { this._videoElement.pause(); } catch (pError) { /* ok */ }
			this._videoElement.onloadedmetadata = null;
			this._videoElement.ontimeupdate = null;
			this._videoElement.onplay = null;
			this._videoElement.onpause = null;
			this._videoElement.onended = null;
			this._videoElement.onvolumechange = null;
			this._videoElement.onratechange = null;
			this._videoElement.onerror = null;
			this._videoElement.onclick = null;
			this._videoElement.removeAttribute('src');
			try { if (typeof this._videoElement.load === 'function') { this._videoElement.load(); } } catch (pError) { /* ok */ }
		}
		if (this._playButtonElement) { this._playButtonElement.onclick = null; }
		if (this._muteButtonElement) { this._muteButtonElement.onclick = null; }
		if (this._rateButtonElement) { this._rateButtonElement.onclick = null; }
		if (this._fullscreenButtonElement) { this._fullscreenButtonElement.onclick = null; }
		if (this._seekElement) { this._seekElement.oninput = null; }
		if (this._volumeElement) { this._volumeElement.oninput = null; }

		if (this.targetElement && this.pict && this.pict.ContentAssignment)
		{
			this.pict.ContentAssignment.assignContent(this.options.TargetElementAddress, '');
		}
		this._rootElement = null;
		this._stageElement = null;
		this._videoElement = null;
		this._loadingElement = null;
		this._controlsElement = null;
		this._playButtonElement = null;
		this._seekElement = null;
		this._currentTimeElement = null;
		this._durationElement = null;
		this._muteButtonElement = null;
		this._volumeElement = null;
		this._rateButtonElement = null;
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
