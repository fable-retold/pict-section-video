/*
	Unit tests for Pict-Section-Video

	These run against a real jsdom document (browser-env, no mocked ContentAssignment) so the <video> element, the
	control bar, the seek/volume inputs and the loadedmetadata/timeupdate/play/pause/error paths are genuinely
	exercised. jsdom has no media pipeline, so the media methods are stubbed to quiet no-ops at the prototype and the
	media events are simulated by invoking the element-property handlers directly (as the image suite simulates load).
*/

const libBrowserEnv = require('browser-env');
libBrowserEnv();

// jsdom does not implement the media pipeline; make play/pause/load quiet no-ops so the tests emit no jsdom noise.
// Individual tests still override these on a specific element to spy on the calls (shadowing the prototype).
if ((typeof window !== 'undefined') && window.HTMLMediaElement)
{
	window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
	window.HTMLMediaElement.prototype.pause = function () {};
	window.HTMLMediaElement.prototype.load = function () {};
}

const Chai = require('chai');
const Expect = Chai.expect;

const libPict = require('pict');
const libPictSectionVideo = require('../source/Pict-Section-Video.js');
const libStrategy = require('../source/Pict-Section-Video-Strategy.js');
const libFS = require('fs');
const libPath = require('path');

let _HostSerial = 0;

/**
 * Stand up a pict app with a real host div and a mounted video view. Returns { pict, view, hostId, viewHash }.
 * The view is rendered once (RenderOnLoad:false + explicit render()).
 */
function buildView(pConfigOverrides)
{
	const tmpHostId = 'VideoHost' + (++_HostSerial);
	const tmpHost = document.createElement('div');
	tmpHost.id = tmpHostId;
	document.body.appendChild(tmpHost);

	const tmpPict = new libPict();
	const tmpViewHash = 'TestVideo' + _HostSerial;

	const tmpConfig = Object.assign({}, libPictSectionVideo.default_configuration,
	{
		RenderOnLoad: false,
		DefaultDestinationAddress: '#' + tmpHostId,
		TargetElementAddress: '#' + tmpHostId,
		Renderables: [ { RenderableHash: 'VideoPlayer-Wrap', TemplateHash: 'VideoPlayer-Container', DestinationAddress: '#' + tmpHostId } ]
	}, pConfigOverrides || {});

	tmpPict.addView(tmpViewHash, tmpConfig, libPictSectionVideo);
	const tmpView = tmpPict.views[tmpViewHash];
	tmpView.render();

	return { pict: tmpPict, view: tmpView, hostId: tmpHostId, viewHash: tmpViewHash };
}

/** Fake the media element having loaded metadata at a given duration, then fire its handler. */
function simulateMetadata(pView, pDuration)
{
	Object.defineProperty(pView._videoElement, 'duration', { configurable: true, value: pDuration });
	if (typeof pView._videoElement.onloadedmetadata === 'function') { pView._videoElement.onloadedmetadata(); }
}

/** Define a fixed currentTime getter on the element, then fire the timeupdate handler. */
function simulateTimeUpdate(pView, pCurrentTime)
{
	Object.defineProperty(pView._videoElement, 'currentTime', { configurable: true, get: function () { return pCurrentTime; } });
	if (typeof pView._videoElement.ontimeupdate === 'function') { pView._videoElement.ontimeupdate(); }
}

/** Make the element's currentTime a plain writable value again (what a real reload does), so a restore-seek sticks. */
function resetCurrentTime(pView)
{
	Object.defineProperty(pView._videoElement, 'currentTime', { configurable: true, writable: true, value: 0 });
}

/** A TimeRanges-shaped object from [[start, end], ...]. */
function makeRanges(pPairs)
{
	return (
	{
		length: pPairs.length,
		start: function (pIndex) { return pPairs[pIndex][0]; },
		end: function (pIndex) { return pPairs[pIndex][1]; }
	});
}

/** Dispatch a keydown at an element (bubbling, so the menu's element-property handler sees it). */
function pressKey(pElement, pKey)
{
	pElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: pKey, bubbles: true, cancelable: true }));
}

/** Pretend the browser put pElement (or nothing, for null) into fullscreen. */
function setFullscreenElement(pElement)
{
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: function () { return pElement; } });
}
function clearFullscreenElement()
{
	delete document.fullscreenElement;
	delete document.exitFullscreen;
}

/**
 * Swap window.localStorage for an in-memory store (jsdom's about:blank origin throws on every access, which is the
 * "storage unavailable" case the other suites run under). Returns { store, data, restore }.
 */
function installFakeStorage()
{
	const tmpOriginal = Object.getOwnPropertyDescriptor(window, 'localStorage');
	const tmpData = {};
	const tmpStore =
	{
		getItem: function (pKey) { return Object.prototype.hasOwnProperty.call(tmpData, pKey) ? tmpData[pKey] : null; },
		setItem: function (pKey, pValue) { tmpData[pKey] = String(pValue); },
		removeItem: function (pKey) { delete tmpData[pKey]; }
	};
	Object.defineProperty(window, 'localStorage', { configurable: true, value: tmpStore });
	return (
	{
		store: tmpStore,
		data: tmpData,
		restore: function ()
		{
			if (tmpOriginal) { Object.defineProperty(window, 'localStorage', tmpOriginal); }
			else { delete window.localStorage; }
		}
	});
}

/** hls.js-shaped levels, ascending by bitrate as hls.js sorts them (index 1 = the 540p rung = firstLevel). */
function makeHlsLevels()
{
	return [
		{ width: 640, height: 360, bitrate: 900000, name: '360p' },
		{ width: 960, height: 540, bitrate: 2200000, name: '540p' },
		{ width: 1280, height: 720, bitrate: 3500000, name: '720p' },
		{ width: 1920, height: 1080, bitrate: 6234000, name: '1080p' }
	];
}

/** A descriptor shaped like fileview's descriptorFromMediaPackage output (top rung first). */
function makeHlsSource(pOverrides)
{
	const tmpBase = '/media/1a2b3c4d';
	return Object.assign(
	{
		URL: tmpBase + '/master.m3u8',
		Title: 'Coast flight',
		Name: 'Coast flight',
		PosterURL: tmpBase + '/poster.jpg',
		DownloadURL: null,
		Duration: 312,
		Stream:
		{
			Type: 'hls',
			Manifest: tmpBase + '/master.m3u8',
			Renditions:
			[
				{ Name: '1080p', ShortSide: 1080, Width: 1920, Height: 1080, Bandwidth: 6234000, Codecs: 'avc1.640028,mp4a.40.2', Playlist: tmpBase + '/v0/index.m3u8' },
				{ Name: '720p', ShortSide: 720, Width: 1280, Height: 720, Bandwidth: 3500000, Codecs: 'avc1.64001f,mp4a.40.2', Playlist: tmpBase + '/v1/index.m3u8' },
				{ Name: '540p', ShortSide: 540, Width: 960, Height: 540, Bandwidth: 2200000, Codecs: 'avc1.64001f,mp4a.40.2', Playlist: tmpBase + '/v2/index.m3u8' },
				{ Name: '360p', ShortSide: 360, Width: 640, Height: 360, Bandwidth: 900000, Codecs: 'avc1.64001e,mp4a.40.2', Playlist: tmpBase + '/v3/index.m3u8' }
			],
			ProgressiveURL: null
		}
	}, pOverrides || {});
}

/**
 * An hls.js FRAG_BUFFERED payload for one main media fragment: pBytes loaded, first byte → last byte in
 * pTransferMS (hls.js's LoadStats shape — loading.first is when the headers arrived). A cache hit or loopback lands
 * well under hls.js's 50 ms sample floor; a real network transfer does not.
 */
function makeFragBuffered(pBytes, pTransferMS, pOverrides)
{
	const tmpStats =
	{
		aborted: false,
		loaded: pBytes,
		total: pBytes,
		loading: { start: 1000, first: 1040, end: 1040 + pTransferMS },
		parsing: { start: 1040 + pTransferMS, end: 1045 + pTransferMS },
		buffering: { start: 1045 + pTransferMS, first: 1046 + pTransferMS, end: 1050 + pTransferMS }
	};
	const tmpFrag = { sn: 7, type: 'main', url: 'http://localhost/media/1a2b3c4d/v2/media.mp4', stats: tmpStats };
	return Object.assign({ frag: tmpFrag, part: null, stats: tmpStats, id: 'main' }, pOverrides || {});
}

/** A Performance stand-in whose getEntriesByName returns the given Resource Timing entries for any name. */
function makePerformance(pEntries)
{
	return { getEntriesByName: function (pName) { return (pEntries || []).filter(function (pEntry) { return pEntry.name === pName; }); } };
}

/**
 * A stand-in for the hls.js class: the static surface (isSupported / Events / ErrorTypes / ErrorDetails) and the
 * instance surface the player drives, recording every call. emit() fires registered handlers the way hls.js does
 * (listener(eventName, data)).
 */
class FakeHls
{
	constructor(pConfig)
	{
		this.config = pConfig || {};
		this.handlers = {};
		this.levels = [];
		this.currentLevel = -1;
		this.nextLevel = -1;
		this.loadLevel = -1;
		this.startLevel = undefined;
		this.autoLevelCapping = -1;
		this.bandwidthEstimate = NaN;
		this.firstLevel = 0;
		this.capLevelToPlayerSize = !!this.config.capLevelToPlayerSize;
		this.media = null;
		this.url = '';
		this.destroyed = false;
		this.calls = { loadSource: [], attachMedia: 0, startLoad: [], stopLoad: 0, recoverMediaError: 0, destroy: 0 };
		FakeHls.instances.push(this);
	}

	static isSupported() { return FakeHls.supported; }

	static last() { return FakeHls.instances[FakeHls.instances.length - 1] || null; }

	static reset()
	{
		FakeHls.instances = [];
		FakeHls.supported = true;
	}

	on(pEvent, fHandler)
	{
		if (!this.handlers[pEvent]) { this.handlers[pEvent] = []; }
		this.handlers[pEvent].push(fHandler);
	}

	off(pEvent, fHandler)
	{
		if (!this.handlers[pEvent]) { return; }
		this.handlers[pEvent] = this.handlers[pEvent].filter(function (fCandidate) { return fCandidate !== fHandler; });
	}

	emit(pEvent, pData)
	{
		const tmpHandlers = (this.handlers[pEvent] || []).slice();
		for (let i = 0; i < tmpHandlers.length; i++) { tmpHandlers[i](pEvent, pData); }
	}

	loadSource(pURL) { this.url = pURL; this.calls.loadSource.push(pURL); }
	attachMedia(pMedia) { this.media = pMedia; this.calls.attachMedia++; }
	startLoad(pStartPosition) { this.calls.startLoad.push((typeof pStartPosition === 'undefined') ? -1 : pStartPosition); }
	stopLoad() { this.calls.stopLoad++; }
	recoverMediaError() { this.calls.recoverMediaError++; }
	destroy() { this.destroyed = true; this.calls.destroy++; this.handlers = {}; this.media = null; }

	/** Test helper: the manifest arrived and parsed. */
	parseManifest(pLevels)
	{
		this.levels = pLevels || makeHlsLevels();
		this.firstLevel = (this.levels.length > 1) ? 1 : 0;
		this.emit(FakeHls.Events.MANIFEST_PARSED, { levels: this.levels, firstLevel: this.firstLevel });
	}

	/** Test helper: an hls.js ERROR event. */
	fail(pData)
	{
		this.emit(FakeHls.Events.ERROR, pData);
	}
}
FakeHls.supported = true;
FakeHls.instances = [];
FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_SWITCHED: 'hlsLevelSwitched', FRAG_BUFFERED: 'hlsFragBuffered', ERROR: 'hlsError', MEDIA_ATTACHED: 'hlsMediaAttached' };
FakeHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', MUX_ERROR: 'muxError', OTHER_ERROR: 'otherError' };
FakeHls.ErrorDetails = { MANIFEST_LOAD_ERROR: 'manifestLoadError', LEVEL_LOAD_ERROR: 'levelLoadError', FRAG_LOAD_ERROR: 'fragLoadError', BUFFER_APPEND_ERROR: 'bufferAppendError', INTERNAL_EXCEPTION: 'internalException' };

/** Mount a player with FakeHls as the host-supplied library and feed it the HLS descriptor. Returns the harness + hls. */
function buildHlsView(pConfigOverrides, pSourceOverrides)
{
	const tmpHarness = buildView(Object.assign({ HlsLibrary: FakeHls }, pConfigOverrides || {}));
	tmpHarness.view.setSource(makeHlsSource(pSourceOverrides));
	tmpHarness.hls = FakeHls.last();
	return tmpHarness;
}

/** The quality menu's item labels (open the menu first). */
function menuLabels(pView)
{
	return pView._qualityItems.map(function (pItem) { return pItem.Element.textContent; });
}

suite
(
	'PictSectionVideo',
	() =>
	{
		suite
		(
			'Module Exports',
			() =>
			{
				test('Main class should be exported', (fDone) =>
				{
					Expect(libPictSectionVideo).to.be.a('function');
					return fDone();
				});
				test('Default configuration should be exported with the player keys', (fDone) =>
				{
					const tmpConfiguration = libPictSectionVideo.default_configuration;
					Expect(tmpConfiguration).to.be.an('object');
					Expect(tmpConfiguration).to.have.property('DefaultRenderable');
					Expect(tmpConfiguration).to.have.property('TargetElementAddress');
					Expect(tmpConfiguration).to.have.property('PlaybackRates');
					Expect(tmpConfiguration).to.have.property('CSS');
					return fDone();
				});
			}
		);

		suite
		(
			'Rendering the chrome',
			() =>
			{
				test('builds the stage and a <video> into the target', (fDone) =>
				{
					const tmpHarness = buildView();
					Expect(document.getElementById(tmpHarness.viewHash + '-Stage')).to.not.equal(null);
					const tmpVideo = document.getElementById(tmpHarness.viewHash + '-Video');
					Expect(tmpVideo).to.not.equal(null);
					Expect(tmpVideo.tagName.toLowerCase()).to.equal('video');
					return fDone();
				});
				test('renders the control bar by default (play / seek / mute / rate)', (fDone) =>
				{
					const tmpHarness = buildView();
					Expect(document.getElementById(tmpHarness.viewHash + '-Controls')).to.not.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-PlayBtn')).to.not.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-Seek')).to.not.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-MuteBtn')).to.not.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-RateBtn')).to.not.equal(null);
					return fDone();
				});
				test('omits the control bar when ShowToolbar is false', (fDone) =>
				{
					const tmpHarness = buildView({ ShowToolbar: false });
					Expect(document.getElementById(tmpHarness.viewHash + '-Controls')).to.equal(null);
					// The stage + video are still built.
					Expect(document.getElementById(tmpHarness.viewHash + '-Video')).to.not.equal(null);
					return fDone();
				});
				test('a re-render self-heals the player DOM after the stub template re-stamps', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
					Expect(document.getElementById(tmpHarness.viewHash + '-Stage')).to.equal(null);
					tmpHarness.view.render();
					Expect(document.getElementById(tmpHarness.viewHash + '-Stage')).to.not.equal(null);
					return fDone();
				});
			}
		);

		suite
		(
			'Loading a video',
			() =>
			{
				test('setVideo assigns the src and shows the loading state', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('https://host/clip.mp4');
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('flex');
					Expect(tmpHarness.view.getState().Loaded).to.equal(false);
					return fDone();
				});
				test('seeds the initial video + poster from config', (fDone) =>
				{
					const tmpHarness = buildView({ VideoURL: 'https://host/seed.mp4', PosterURL: 'https://host/poster.jpg' });
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('https://host/seed.mp4');
					Expect(tmpHarness.view._videoElement.getAttribute('poster')).to.equal('https://host/poster.jpg');
					return fDone();
				});
				test('on loadedmetadata the duration shows, loading hides, and the scrubber enables', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpHarness.view, 125);   // 2:05
					Expect(tmpHarness.view.getState().Loaded).to.equal(true);
					Expect(tmpHarness.view.getState().Duration).to.equal(125);
					Expect(tmpHarness.view._durationElement.textContent).to.equal('2:05');
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('none');
					Expect(tmpHarness.view._seekElement.disabled).to.equal(false);
					return fDone();
				});
				test('reveals the download affordance once a URL is set', (fDone) =>
				{
					const tmpHarness = buildView();
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					tmpHarness.view.setVideo('https://host/clip.mp4');
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('inline-flex');
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('https://host/clip.mp4');
					return fDone();
				});
				test('timeupdate advances the current-time readout and the scrubber position', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpHarness.view, 120);
					simulateTimeUpdate(tmpHarness.view, 30);
					Expect(tmpHarness.view.getState().CurrentTime).to.equal(30);
					Expect(tmpHarness.view._currentTimeElement.textContent).to.equal('0:30');
					Expect(tmpHarness.view._seekElement.value).to.equal('250');   // 30/120 * 1000
					return fDone();
				});
				test('formats durations past an hour as h:mm:ss', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/movie.mp4');
					simulateMetadata(tmpHarness.view, 3725);   // 1:02:05
					Expect(tmpHarness.view._durationElement.textContent).to.equal('1:02:05');
					return fDone();
				});
			}
		);

		suite
		(
			'Playback controls',
			() =>
			{
				test('togglePlay drives the media element and the play/pause glyph tracks the media events', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					const tmpCalls = { play: 0, pause: 0 };
					tmpHarness.view._videoElement.play = function () { tmpCalls.play++; return Promise.resolve(); };
					tmpHarness.view._videoElement.pause = function () { tmpCalls.pause++; };

					tmpHarness.view.togglePlay();                 // not playing → play()
					Expect(tmpCalls.play).to.equal(1);
					tmpHarness.view._videoElement.onplay();       // the media confirms it started
					Expect(tmpHarness.view.getState().Playing).to.equal(true);

					tmpHarness.view.togglePlay();                 // playing → pause()
					Expect(tmpCalls.pause).to.equal(1);
					tmpHarness.view._videoElement.onpause();
					Expect(tmpHarness.view.getState().Playing).to.equal(false);
					return fDone();
				});
				test('the seek slider maps its position onto an absolute time', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpHarness.view, 200);
					tmpHarness.view._seekElement.value = '500';
					tmpHarness.view._seekElement.oninput();   // 500/1000 * 200 = 100s
					Expect(tmpHarness.view.getState().CurrentTime).to.equal(100);
					return fDone();
				});
				test('toggleMute mutes/unmutes the element and swaps the glyph', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					Expect(tmpHarness.view.getState().Muted).to.equal(false);
					tmpHarness.view.toggleMute();
					Expect(tmpHarness.view._videoElement.muted).to.equal(true);
					Expect(tmpHarness.view.getState().Muted).to.equal(true);
					tmpHarness.view.toggleMute();
					Expect(tmpHarness.view._videoElement.muted).to.equal(false);
					return fDone();
				});
				test('setVolume sets the element volume and a zero volume mutes', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					tmpHarness.view.setVolume(0.5);
					Expect(tmpHarness.view._videoElement.volume).to.equal(0.5);
					Expect(tmpHarness.view.getState().Volume).to.equal(0.5);
					tmpHarness.view.setVolume(0);
					Expect(tmpHarness.view.getState().Muted).to.equal(true);
					return fDone();
				});
				test('cyclePlaybackRate steps through the configured rates and sets the element', (fDone) =>
				{
					const tmpHarness = buildView({ PlaybackRates: [ 0.5, 1, 1.5, 2 ] });
					tmpHarness.view.setVideo('https://host/clip.mp4');
					tmpHarness.view.cyclePlaybackRate();   // 1 → 1.5
					Expect(tmpHarness.view.getState().PlaybackRate).to.equal(1.5);
					Expect(tmpHarness.view._videoElement.playbackRate).to.equal(1.5);
					return fDone();
				});
				test('playback controls stay on the stubbed prototype when not overridden (no throw)', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					// Exercise the real play/pause path (prototype no-ops) to prove they are guarded.
					tmpHarness.view.play();
					tmpHarness.view.pause();
					return fDone();
				});
			}
		);

		suite
		(
			'Fullscreen (fill the viewport)',
			() =>
			{
				test('renders the fullscreen button by default and omits it when ShowFullscreen is false', (fDone) =>
				{
					const tmpOn = buildView();
					Expect(document.getElementById(tmpOn.viewHash + '-FullscreenBtn')).to.not.equal(null);
					const tmpOff = buildView({ ShowFullscreen: false });
					Expect(document.getElementById(tmpOff.viewHash + '-FullscreenBtn')).to.equal(null);
					Expect(document.getElementById(tmpOff.viewHash + '-PlayBtn')).to.not.equal(null);
					return fDone();
				});
				test('toggleFullscreen adds then removes the psv-fullscreen class and tracks state', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpRoot = document.getElementById(tmpHarness.viewHash + '-Root');
					Expect(tmpHarness.view.isFullscreen()).to.equal(false);
					tmpHarness.view.toggleFullscreen();
					Expect(tmpHarness.view.isFullscreen()).to.equal(true);
					Expect(tmpRoot.classList.contains('psv-fullscreen')).to.equal(true);
					tmpHarness.view.toggleFullscreen();
					Expect(tmpHarness.view.isFullscreen()).to.equal(false);
					Expect(tmpRoot.classList.contains('psv-fullscreen')).to.equal(false);
					return fDone();
				});
				test('the Escape key exits fullscreen', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.enterFullscreen();
					Expect(tmpHarness.view.isFullscreen()).to.equal(true);
					document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
					Expect(tmpHarness.view.isFullscreen()).to.equal(false);
					return fDone();
				});
				test('destroy detaches the Escape handler (a later Escape does not re-enter)', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.enterFullscreen();
					tmpHarness.view.destroy();
					Expect(tmpHarness.view._keydownHandler).to.equal(null);
					document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
					Expect(tmpHarness.view.getState().Fullscreen).to.equal(false);
					return fDone();
				});
			}
		);

		suite
		(
			'Error handling + lifecycle',
			() =>
			{
				test('a media error paints the error state', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/missing.mp4');
					tmpHarness.view._videoElement.onerror();
					Expect(tmpHarness.view.getState().Error).to.equal(true);
					const tmpStage = document.getElementById(tmpHarness.viewHash + '-Stage');
					Expect(tmpStage.querySelector('.psv-error')).to.not.equal(null);
					return fDone();
				});
				test('setVideo after an error rebuilds a fresh <video> and recovers', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/missing.mp4');
					tmpHarness.view._videoElement.onerror();
					Expect(tmpHarness.view.getState().Error).to.equal(true);

					tmpHarness.view.setVideo('https://host/good.mp4');
					Expect(tmpHarness.view._videoElement).to.not.equal(null);
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('https://host/good.mp4');
					simulateMetadata(tmpHarness.view, 10);
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					Expect(tmpHarness.view.getState().Loaded).to.equal(true);
					return fDone();
				});
				test('setVideo accepts a descriptor object (URL, Title, PosterURL)', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo({ URL: 'https://host/talk.mp4', Title: 'The Talk', PosterURL: 'https://host/art.jpg', Name: 'talk.mp4' });
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('https://host/talk.mp4');
					Expect(tmpHarness.view._videoElement.getAttribute('poster')).to.equal('https://host/art.jpg');
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('https://host/talk.mp4');
					return fDone();
				});
				test('destroy clears the player and detaches handlers', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					tmpHarness.view.destroy();
					Expect(tmpHarness.view._videoElement).to.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-Stage')).to.equal(null);
					return fDone();
				});
				test('two instances on one page do not collide (distinct ids)', (fDone) =>
				{
					const tmpA = buildView();
					const tmpB = buildView();
					Expect(tmpA.viewHash).to.not.equal(tmpB.viewHash);
					tmpA.view.setVideo('https://host/a.mp4');
					tmpB.view.setVideo('https://host/b.mp4');
					Expect(tmpA.view._videoElement.getAttribute('src')).to.equal('https://host/a.mp4');
					Expect(tmpB.view._videoElement.getAttribute('src')).to.equal('https://host/b.mp4');
					Expect(document.getElementById(tmpA.viewHash + '-Stage'))
						.to.not.equal(document.getElementById(tmpB.viewHash + '-Stage'));
					return fDone();
				});
			}
		);

		suite
		(
			'Strategy (pure)',
			() =>
			{
				const tmpHls = makeHlsSource();
				const tmpPlain = { URL: 'https://host/clip.mp4' };
				const fVideo = function (pAnswer) { return { canPlayType: function () { return pAnswer; } }; };
				const tmpSupportedHls = { isSupported: function () { return true; } };
				const tmpUnsupportedHls = { isSupported: function () { return false; } };

				test('exports the resolver, progressiveURL and HLS_MIME', (fDone) =>
				{
					Expect(libStrategy.resolveStrategy).to.be.a('function');
					Expect(libStrategy.progressiveURL).to.be.a('function');
					Expect(libStrategy.HLS_MIME).to.equal('application/vnd.apple.mpegurl');
					Expect(libPictSectionVideo.Strategy).to.equal(libStrategy);
					return fDone();
				});
				test('Safari (canPlayType + ManagedMediaSource) plays HLS natively even when hls.js is supported', (fDone) =>
				{
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo('maybe'), tmpSupportedHls, { ManagedMediaSource: function () {} }))
						.to.equal('native-hls');
					return fDone();
				});
				test('Chrome (answers canPlayType, no MMS, hls.js supported) plays through hls.js', (fDone) =>
				{
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo('maybe'), tmpSupportedHls, {})).to.equal('hls.js');
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo(''), tmpSupportedHls, {})).to.equal('hls.js');
					return fDone();
				});
				test('iOS before 17.1 (no MMS, no hls.js support, canPlayType passes) plays natively', (fDone) =>
				{
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo('probably'), tmpUnsupportedHls, {})).to.equal('native-hls');
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo('maybe'), null, null)).to.equal('native-hls');
					return fDone();
				});
				test('no HLS support but a ProgressiveURL → progressive; a plain file → progressive', (fDone) =>
				{
					const tmpWithFile = makeHlsSource();
					tmpWithFile.Stream = Object.assign({}, tmpWithFile.Stream, { ProgressiveURL: '/media/1a2b3c4d/download.mp4' });
					Expect(libStrategy.resolveStrategy(tmpWithFile, fVideo(''), tmpUnsupportedHls, {})).to.equal('progressive');
					Expect(libStrategy.progressiveURL(tmpWithFile)).to.equal('/media/1a2b3c4d/download.mp4');
					Expect(libStrategy.resolveStrategy(tmpPlain, fVideo(''), null, {})).to.equal('progressive');
					Expect(libStrategy.progressiveURL(tmpPlain)).to.equal('https://host/clip.mp4');
					return fDone();
				});
				test('nothing that can play the stream → unsupported', (fDone) =>
				{
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo(''), tmpUnsupportedHls, {})).to.equal('unsupported');
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo('no'), null, null)).to.equal('unsupported');
					Expect(libStrategy.resolveStrategy(tmpHls, null, null, null)).to.equal('unsupported');
					return fDone();
				});
				test('an isSupported that throws counts as unsupported', (fDone) =>
				{
					const tmpThrows = { isSupported: function () { throw new Error('no MSE'); } };
					Expect(libStrategy.resolveStrategy(tmpHls, fVideo(''), tmpThrows, {})).to.equal('unsupported');
					return fDone();
				});
				test('quality levels from hls.js: highest first, short side for portrait, labelled with bandwidth', (fDone) =>
				{
					const tmpLevels = libStrategy.qualityLevelsFromHls(makeHlsLevels());
					Expect(tmpLevels.map((pLevel) => pLevel.Label)).to.deep.equal([ '1080p · 6 Mbps', '720p · 3.5 Mbps', '540p · 2.2 Mbps', '360p · 900 kbps' ]);
					Expect(tmpLevels[0]).to.deep.equal({ Index: 3, Height: 1080, Width: 1920, PixelHeight: 1080, Bandwidth: 6234000, Label: '1080p · 6 Mbps' });
					const tmpPortrait = libStrategy.qualityLevelsFromHls([ { width: 1080, height: 1920, bitrate: 6000000 } ]);
					Expect(tmpPortrait[0].Height).to.equal(1080);
					Expect(tmpPortrait[0].PixelHeight).to.equal(1920);
					return fDone();
				});
				test('quality levels from Stream.Renditions keep the rendition index and playlist', (fDone) =>
				{
					const tmpLevels = libStrategy.qualityLevelsFromRenditions(makeHlsSource().Stream.Renditions);
					Expect(tmpLevels.map((pLevel) => pLevel.Height)).to.deep.equal([ 1080, 720, 540, 360 ]);
					Expect(tmpLevels[2].Index).to.equal(2);
					Expect(tmpLevels[2].Playlist).to.equal('/media/1a2b3c4d/v2/index.m3u8');
					// Older renditions without ShortSide fall back to min(Width, Height).
					Expect(libStrategy.qualityLevelsFromRenditions([ { Width: 720, Height: 1280, Bandwidth: 1 } ])[0].Height).to.equal(720);
					return fDone();
				});
				test('levelForHeight picks an exact rung, else the closest below, else the lowest; saverLevel caps at 540', (fDone) =>
				{
					const tmpLevels = libStrategy.qualityLevelsFromHls(makeHlsLevels());
					Expect(libStrategy.levelForHeight(tmpLevels, 720).Height).to.equal(720);
					Expect(libStrategy.levelForHeight(tmpLevels, 900).Height).to.equal(720);
					Expect(libStrategy.levelForHeight(tmpLevels, 200).Height).to.equal(360);
					Expect(libStrategy.saverLevel(tmpLevels, 540).Index).to.equal(1);
					Expect(libStrategy.saverLevel(tmpLevels, 480).Height).to.equal(360);
					Expect(libStrategy.levelForHeight([], 720)).to.equal(null);
					return fDone();
				});
				test('normalizeQuality accepts auto / saver / a short side and rejects the rest', (fDone) =>
				{
					Expect(libStrategy.normalizeQuality('auto')).to.equal('auto');
					Expect(libStrategy.normalizeQuality('saver')).to.equal('saver');
					Expect(libStrategy.normalizeQuality(1080)).to.equal(1080);
					Expect(libStrategy.normalizeQuality('720p')).to.equal(720);
					Expect(libStrategy.normalizeQuality('high')).to.equal(null);
					Expect(libStrategy.normalizeQuality(-5)).to.equal(null);
					Expect(libStrategy.normalizeQuality(undefined)).to.equal(null);
					return fDone();
				});
				test('buildHlsConfig: defaults, a saved estimate, and host keys on top', (fDone) =>
				{
					const tmpFirst = libStrategy.buildHlsConfig({}, undefined);
					Expect(tmpFirst).to.deep.equal({ autoStartLoad: false, maxBufferLength: 30, maxMaxBufferLength: 60, capLevelToPlayerSize: true });
					Expect(tmpFirst).to.not.have.property('startLevel');
					const tmpSaved = libStrategy.buildHlsConfig({}, 4200000);
					Expect(tmpSaved.startLevel).to.equal(-1);
					Expect(tmpSaved.testBandwidth).to.equal(false);
					Expect(tmpSaved.abrEwmaDefaultEstimate).to.equal(4200000);
					const tmpHost = libStrategy.buildHlsConfig({ maxBufferLength: 10, debug: true }, 0);
					Expect(tmpHost.maxBufferLength).to.equal(10);
					Expect(tmpHost.debug).to.equal(true);
					Expect(tmpHost.autoStartLoad).to.equal(false);
					return fDone();
				});
				test('fragmentNetworkBandwidth: a real transfer measures bits per second, first byte to last', (fDone) =>
				{
					// 1.5 MB in 4 s = 3 Mbps.
					Expect(libStrategy.fragmentNetworkBandwidth(makeFragBuffered(1500000, 4000), null)).to.equal(3000000);
					// Part stats (LL-HLS) win when the part loaded something.
					const tmpPart = makeFragBuffered(1500000, 4000);
					tmpPart.part = { stats: makeFragBuffered(500000, 2000).stats };
					Expect(libStrategy.fragmentNetworkBandwidth(tmpPart, null)).to.equal(2000000);
					return fDone();
				});
				test('fragmentNetworkBandwidth: a cache hit or loopback (under the hls.js 50 ms sample floor) measures nothing', (fDone) =>
				{
					// The live case: a 4.9 MB fragment in 6 ms reads as ~800 Mbps inside hls.js.
					Expect(libStrategy.fragmentNetworkBandwidth(makeFragBuffered(4900000, 6), null)).to.equal(0);
					// A small fragment's floor is bytes / 100000 ms (as hls.js): 200 kB in 1 ms is under it, in 3 ms is not.
					Expect(libStrategy.fragmentNetworkBandwidth(makeFragBuffered(200000, 1), null)).to.equal(0);
					Expect(libStrategy.fragmentNetworkBandwidth(makeFragBuffered(200000, 3), null)).to.be.above(0);
					return fDone();
				});
				test('fragmentNetworkBandwidth: Resource Timing transferSize 0 (an HTTP-cache hit) measures nothing', (fDone) =>
				{
					// Slow enough to clear the floor (a cold disk cache), but the browser says no byte crossed the wire.
					const tmpData = makeFragBuffered(4900000, 80);
					const tmpURL = tmpData.frag.url;
					const tmpCached = makePerformance([ { name: tmpURL, startTime: 1000.4, responseEnd: 1119, transferSize: 0, encodedBodySize: 4900000, decodedBodySize: 4900000 } ]);
					Expect(libStrategy.fragmentNetworkBandwidth(tmpData, tmpCached)).to.equal(0);
					// The same request over the network counts.
					const tmpNetwork = makePerformance([ { name: tmpURL, startTime: 1000.4, responseEnd: 1119, transferSize: 4900400, encodedBodySize: 4900000, decodedBodySize: 4900000 } ]);
					Expect(libStrategy.fragmentNetworkBandwidth(tmpData, tmpNetwork)).to.equal(490000000);
					// An entry for an earlier request of the same byte-ranged file is not this fragment's.
					const tmpEarlier = makePerformance([ { name: tmpURL, startTime: 200, responseEnd: 260, transferSize: 0, encodedBodySize: 4900000, decodedBodySize: 4900000 } ]);
					Expect(libStrategy.fragmentNetworkBandwidth(tmpData, tmpEarlier)).to.equal(490000000);
					// A cross-origin entry without Timing-Allow-Origin (every size 0) proves nothing either way.
					const tmpOpaque = makePerformance([ { name: tmpURL, startTime: 1000.4, responseEnd: 1119, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 } ]);
					Expect(libStrategy.fragmentNetworkBandwidth(tmpData, tmpOpaque)).to.equal(490000000);
					// A Performance that throws is ignored.
					const tmpThrows = { getEntriesByName: function () { throw new Error('nope'); } };
					Expect(libStrategy.fragmentNetworkBandwidth(tmpData, tmpThrows)).to.equal(490000000);
					return fDone();
				});
				test('fragmentNetworkBandwidth: no stats, an aborted load or nothing loaded measures nothing', (fDone) =>
				{
					Expect(libStrategy.fragmentNetworkBandwidth(null, null)).to.equal(0);
					Expect(libStrategy.fragmentNetworkBandwidth({ frag: { sn: 1, type: 'main' } }, null)).to.equal(0);
					const tmpAborted = makeFragBuffered(1500000, 4000);
					tmpAborted.stats.aborted = true;
					Expect(libStrategy.fragmentNetworkBandwidth(tmpAborted, null)).to.equal(0);
					Expect(libStrategy.fragmentNetworkBandwidth(makeFragBuffered(0, 4000), null)).to.equal(0);
					return fDone();
				});
				test('persistableEstimate: hls.js\'s estimate, never above what the network was seen to deliver', (fDone) =>
				{
					Expect(libStrategy.persistableEstimate(4200000, 6000000)).to.equal(4200000);
					Expect(libStrategy.persistableEstimate(50900000.4, 3000000)).to.equal(3000000);
					Expect(libStrategy.persistableEstimate(4200000, 0)).to.equal(0);
					Expect(libStrategy.persistableEstimate(NaN, 3000000)).to.equal(0);
					Expect(libStrategy.persistableEstimate(-1, 3000000)).to.equal(0);
					return fDone();
				});
				test('error status helpers: 401/403/404/410 mean revoked; status read from response or networkDetails', (fDone) =>
				{
					[ 401, 403, 404, 410 ].forEach((pStatus) => Expect(libStrategy.isRevokedStatus(pStatus)).to.equal(true));
					Expect(libStrategy.isRevokedStatus(500)).to.equal(false);
					Expect(libStrategy.hlsErrorStatus({ response: { code: 410 } })).to.equal(410);
					Expect(libStrategy.hlsErrorStatus({ networkDetails: { status: 403 } })).to.equal(403);
					Expect(libStrategy.hlsErrorStatus({})).to.equal(0);
					return fDone();
				});
				test('bufferedEndAt finds the range holding the playhead', (fDone) =>
				{
					const tmpRanges = makeRanges([ [ 0, 10 ], [ 20, 45 ] ]);
					Expect(libStrategy.bufferedEndAt(tmpRanges, 30)).to.equal(45);
					Expect(libStrategy.bufferedEndAt(tmpRanges, 5)).to.equal(10);
					Expect(libStrategy.bufferedEndAt(tmpRanges, 15)).to.equal(0);
					Expect(libStrategy.bufferedEndAt(null, 1)).to.equal(0);
					return fDone();
				});
			}
		);

		suite
		(
			'setSource + hls.js',
			() =>
			{
				setup(() => { FakeHls.reset(); });
				teardown(() => { FakeHls.reset(); delete window.Hls; });

				test('getStrategy is empty before a load and progressive for a plain URL', (fDone) =>
				{
					const tmpHarness = buildView();
					Expect(tmpHarness.view.getStrategy()).to.equal('');
					tmpHarness.view.setVideo('https://host/clip.mp4');
					Expect(tmpHarness.view.getStrategy()).to.equal('progressive');
					Expect(tmpHarness.view.getQualityLevels()).to.deep.equal([]);
					return fDone();
				});
				test('an HLS source attaches hls.js: manifest on mount, no src attribute, merged config', (fDone) =>
				{
					const tmpHarness = buildHlsView({ HlsConfig: { maxBufferLength: 12 } });
					const tmpHls = tmpHarness.hls;
					Expect(tmpHarness.view.getStrategy()).to.equal('hls.js');
					Expect(tmpHls).to.not.equal(null);
					Expect(tmpHls.calls.loadSource).to.deep.equal([ '/media/1a2b3c4d/master.m3u8' ]);
					Expect(tmpHls.media).to.equal(tmpHarness.view._videoElement);
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal(null);
					Expect(tmpHls.config.autoStartLoad).to.equal(false);
					Expect(tmpHls.config.maxMaxBufferLength).to.equal(60);
					Expect(tmpHls.config.capLevelToPlayerSize).to.equal(true);
					Expect(tmpHls.config.maxBufferLength).to.equal(12);
					// First visit: no saved estimate, so startLevel stays unset (hls.firstLevel = the 540p rung).
					Expect(tmpHls.config).to.not.have.property('startLevel');
					Expect(tmpHls.calls.startLoad).to.deep.equal([]);
					return fDone();
				});
				test('window.Hls is used when no HlsLibrary is configured', (fDone) =>
				{
					window.Hls = FakeHls;
					const tmpHarness = buildView();
					tmpHarness.view.setSource(makeHlsSource());
					Expect(tmpHarness.view.getStrategy()).to.equal('hls.js');
					Expect(FakeHls.instances.length).to.equal(1);
					return fDone();
				});
				test('setVideo with a descriptor object forwards the Stream (it is setSource)', (fDone) =>
				{
					const tmpHarness = buildView({ HlsLibrary: FakeHls });
					tmpHarness.view.setVideo(makeHlsSource());
					Expect(tmpHarness.view.getStrategy()).to.equal('hls.js');
					return fDone();
				});
				test('the manifest parse hides the loading veil; media loads only on the first play()', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('flex');
					tmpHarness.hls.parseManifest();
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('none');
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(0);
					tmpHarness.view.play();
					Expect(tmpHarness.hls.calls.startLoad).to.deep.equal([ -1 ]);
					tmpHarness.view.play();
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(1);
					return fDone();
				});
				test('a play that starts on the <video> itself (onplay) also starts loading', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view._videoElement.onplay();
					Expect(tmpHarness.hls.calls.startLoad).to.deep.equal([ -1 ]);
					return fDone();
				});
				test('a play before the manifest parses starts loading once it does', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.view.play();
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(0);
					tmpHarness.hls.parseManifest();
					Expect(tmpHarness.hls.calls.startLoad).to.deep.equal([ -1 ]);
					return fDone();
				});
				test('AutoPlay starts loading as soon as the manifest parses', (fDone) =>
				{
					const tmpHarness = buildHlsView({ AutoPlay: true });
					tmpHarness.hls.parseManifest();
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(1);
					return fDone();
				});
				test('a seek before loading starts becomes the startLoad position', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.seekTo(42);
					tmpHarness.view.play();
					Expect(tmpHarness.hls.calls.startLoad).to.deep.equal([ 42 ]);
					return fDone();
				});
				test('the Duration hint shows until metadata arrives', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					Expect(tmpHarness.view._durationElement.textContent).to.equal('5:12');
					Expect(tmpHarness.view.getState().Duration).to.equal(312);
					simulateMetadata(tmpHarness.view, 311.5);
					Expect(tmpHarness.view.getState().Duration).to.equal(311.5);
					return fDone();
				});
				test('a new source destroys the previous hls.js instance', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					const tmpFirst = tmpHarness.hls;
					tmpHarness.view.setVideo('https://host/plain.mp4');
					Expect(tmpFirst.destroyed).to.equal(true);
					Expect(tmpHarness.view.getStrategy()).to.equal('progressive');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('https://host/plain.mp4');
					return fDone();
				});
				test('destroy() calls hls.destroy()', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.view.destroy();
					Expect(tmpHarness.hls.calls.destroy).to.equal(1);
					Expect(tmpHarness.view._hls).to.equal(null);
					return fDone();
				});
				test('getState reports Strategy, Quality, PlayingHeight, Levels, Buffered and Waiting', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 1 });
					const tmpState = tmpHarness.view.getState();
					Expect(tmpState.Strategy).to.equal('hls.js');
					Expect(tmpState.Quality).to.equal('auto');
					Expect(tmpState.PlayingHeight).to.equal(540);
					Expect(tmpState.Levels.length).to.equal(4);
					Expect(tmpState.Buffered).to.equal(0);
					Expect(tmpState.Waiting).to.equal(false);
					return fDone();
				});
			}
		);

		suite
		(
			'Quality menu',
			() =>
			{
				setup(() => { FakeHls.reset(); });
				teardown(() => { FakeHls.reset(); });

				test('the quality button sits after the rate button and stays hidden until there are two rungs', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					const tmpWrap = document.getElementById(tmpHarness.viewHash + '-QualityWrap');
					Expect(tmpWrap).to.not.equal(null);
					Expect(document.getElementById(tmpHarness.viewHash + '-RateBtn').nextElementSibling).to.equal(tmpWrap);
					Expect(tmpWrap.style.display).to.equal('none');
					tmpHarness.hls.parseManifest();
					Expect(tmpWrap.style.display).to.equal('inline-flex');
					Expect(tmpHarness.view._qualityButtonElement.textContent).to.equal('Auto');
					return fDone();
				});
				test('hidden with a single rung, for a progressive file, and absent with ShowQuality:false', (fDone) =>
				{
					const tmpSingle = buildHlsView();
					tmpSingle.hls.parseManifest([ { width: 1280, height: 720, bitrate: 3000000 } ]);
					Expect(tmpSingle.view._qualityWrapElement.style.display).to.equal('none');

					const tmpPlain = buildView();
					tmpPlain.view.setVideo('https://host/clip.mp4');
					Expect(tmpPlain.view._qualityWrapElement.style.display).to.equal('none');

					const tmpOff = buildHlsView({ ShowQuality: false });
					tmpOff.hls.parseManifest();
					Expect(document.getElementById(tmpOff.viewHash + '-QualityWrap')).to.equal(null);
					Expect(document.getElementById(tmpOff.viewHash + '-QualityBtn')).to.equal(null);
					return fDone();
				});
				test('getQualityLevels lists the hls.js rungs highest first in the contract shape', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					const tmpLevels = tmpHarness.view.getQualityLevels();
					Expect(tmpLevels.map((pLevel) => pLevel.Index)).to.deep.equal([ 3, 2, 1, 0 ]);
					Expect(Object.keys(tmpLevels[0]).sort()).to.deep.equal([ 'Bandwidth', 'Height', 'Index', 'Label', 'PixelHeight', 'Width' ]);
					return fDone();
				});
				test('opening renders a role=menu of Auto, one entry per rung and Data saver, with Auto checked', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view._qualityButtonElement.click();
					const tmpMenu = tmpHarness.view._qualityMenuElement;
					Expect(tmpMenu.getAttribute('role')).to.equal('menu');
					Expect(tmpMenu.style.display).to.equal('flex');
					Expect(tmpHarness.view._qualityButtonElement.getAttribute('aria-expanded')).to.equal('true');
					Expect(menuLabels(tmpHarness.view)).to.deep.equal([ 'Auto', '1080p · 6 Mbps', '720p · 3.5 Mbps', '540p · 2.2 Mbps', '360p · 900 kbps', 'Data saver' ]);
					Expect(tmpHarness.view._qualityItems[0].Element.getAttribute('role')).to.equal('menuitemradio');
					Expect(tmpHarness.view._qualityItems[0].Element.getAttribute('aria-checked')).to.equal('true');
					Expect(tmpHarness.view._qualityItems[1].Element.getAttribute('aria-checked')).to.equal('false');
					// Focus lands on the checked entry.
					Expect(document.activeElement).to.equal(tmpHarness.view._qualityItems[0].Element);
					tmpHarness.view._qualityButtonElement.click();
					Expect(tmpMenu.style.display).to.equal('none');
					return fDone();
				});
				test('ShowDataSaver:false drops the Data saver entry', (fDone) =>
				{
					const tmpHarness = buildHlsView({ ShowDataSaver: false });
					tmpHarness.hls.parseManifest();
					tmpHarness.view.toggleQualityMenu();
					Expect(menuLabels(tmpHarness.view)).to.not.include('Data saver');
					Expect(menuLabels(tmpHarness.view).length).to.equal(5);
					return fDone();
				});
				test('the Auto label follows LEVEL_SWITCHED under hls.js (live while the menu is open)', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.toggleQualityMenu();
					tmpHarness.hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 2 });
					Expect(menuLabels(tmpHarness.view)[0]).to.equal('Auto (720p)');
					Expect(tmpHarness.view.getState().PlayingHeight).to.equal(720);
					Expect(tmpHarness.view._qualityButtonElement.getAttribute('title')).to.equal('Quality: Auto (720p)');
					return fDone();
				});
				test('arrow keys move through the items (wrapping), Escape closes back to the button', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					const tmpView = tmpHarness.view;
					tmpView.toggleQualityMenu();
					Expect(document.activeElement).to.equal(tmpView._qualityItems[0].Element);
					pressKey(document.activeElement, 'ArrowDown');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[1].Element);
					pressKey(document.activeElement, 'ArrowUp');
					pressKey(document.activeElement, 'ArrowUp');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[5].Element);
					pressKey(document.activeElement, 'ArrowDown');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[0].Element);
					pressKey(document.activeElement, 'End');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[5].Element);
					pressKey(document.activeElement, 'Home');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[0].Element);
					pressKey(document.activeElement, 'Escape');
					Expect(tmpView._qualityMenuOpen).to.equal(false);
					Expect(tmpView._qualityMenuElement.style.display).to.equal('none');
					Expect(document.activeElement).to.equal(tmpView._qualityButtonElement);
					return fDone();
				});
				test('ArrowDown / ArrowUp on the button open the menu on the first / last item', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					const tmpView = tmpHarness.view;
					pressKey(tmpView._qualityButtonElement, 'ArrowUp');
					Expect(tmpView._qualityMenuOpen).to.equal(true);
					Expect(document.activeElement).to.equal(tmpView._qualityItems[tmpView._qualityItems.length - 1].Element);
					pressKey(document.activeElement, 'Escape');
					pressKey(tmpView._qualityButtonElement, 'ArrowDown');
					Expect(document.activeElement).to.equal(tmpView._qualityItems[0].Element);
					return fDone();
				});
				test('Escape inside the menu does not also leave a maximized player', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.enterFullscreen();
					tmpHarness.view.toggleQualityMenu();
					pressKey(document.activeElement, 'Escape');
					Expect(tmpHarness.view._qualityMenuOpen).to.equal(false);
					Expect(tmpHarness.view.isFullscreen()).to.equal(true);
					tmpHarness.view.exitFullscreen();
					return fDone();
				});
				test('a pointerdown outside closes the menu; one inside does not', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.toggleQualityMenu();
					tmpHarness.view._qualityItems[2].Element.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
					Expect(tmpHarness.view._qualityMenuOpen).to.equal(true);
					document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
					Expect(tmpHarness.view._qualityMenuOpen).to.equal(false);
					Expect(tmpHarness.view._outsidePointerHandler).to.equal(null);
					return fDone();
				});
				test('a pick while paused sets currentLevel; the button and checked item follow', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.toggleQualityMenu();
					tmpHarness.view._qualityItems[1].Element.click();   // 1080p
					Expect(tmpHarness.hls.currentLevel).to.equal(3);
					Expect(tmpHarness.hls.nextLevel).to.equal(-1);
					// Before loading starts the pick also seeds startLevel, so the first fragment is already 1080p.
					Expect(tmpHarness.hls.startLevel).to.equal(3);
					Expect(tmpHarness.view.getQuality()).to.equal(1080);
					Expect(tmpHarness.view._qualityMenuOpen).to.equal(false);
					Expect(tmpHarness.view._qualityButtonElement.textContent).to.equal('1080p');
					tmpHarness.view.toggleQualityMenu();
					Expect(tmpHarness.view._qualityItems[1].Element.getAttribute('aria-checked')).to.equal('true');
					Expect(tmpHarness.view._qualityItems[0].Element.getAttribute('aria-checked')).to.equal('false');
					return fDone();
				});
				test('a pick while playing sets nextLevel (switch at the next fragment, no restart)', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.play();
					tmpHarness.view._videoElement.onplay();
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(1);
					Expect(tmpHarness.view.setQuality(360)).to.equal(true);
					Expect(tmpHarness.hls.nextLevel).to.equal(0);
					Expect(tmpHarness.hls.currentLevel).to.equal(-1);
					// No restart: the same hls.js instance, one manifest load, one startLoad.
					Expect(FakeHls.instances.length).to.equal(1);
					Expect(tmpHarness.hls.calls.loadSource.length).to.equal(1);
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(1);
					tmpHarness.view.setQuality('auto');
					Expect(tmpHarness.hls.nextLevel).to.equal(-1);
					return fDone();
				});
				test('Data saver caps autoLevelCapping at the <=540p rung (pausing the player-size capper); Auto lifts it', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.setQuality('saver');
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(1);
					Expect(tmpHarness.hls.capLevelToPlayerSize).to.equal(false);
					Expect(tmpHarness.hls.currentLevel).to.equal(-1);
					Expect(tmpHarness.view._qualityButtonElement.textContent).to.equal('Saver');
					tmpHarness.view.setQuality('auto');
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(-1);
					Expect(tmpHarness.hls.capLevelToPlayerSize).to.equal(true);
					return fDone();
				});
				test('an explicit pick and a return to Auto leave the player-size capper\'s autoLevelCapping alone', (fDone) =>
				{
					// hls.js 1.7 recomputes the player-size cap only from a ResizeObserver callback, so a cap the player
					// overwrites stays overwritten until the box next resizes (Auto would climb past the player's size).
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.hls.autoLevelCapping = 1;   // what hls.js's capper set for a ~800px-wide box
					tmpHarness.view.setQuality(1080);
					Expect(tmpHarness.hls.currentLevel).to.equal(3);
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(1);
					tmpHarness.view.setQuality('auto');
					Expect(tmpHarness.hls.currentLevel).to.equal(-1);
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(1);
					Expect(tmpHarness.hls.capLevelToPlayerSize).to.equal(true);
					return fDone();
				});
				test('leaving Data saver restarts the capper even where hls.js\'s setter cannot (1.7.x)', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					const tmpHls = tmpHarness.hls;
					// Model hls.js 1.7.4: its own config object (not the one the player passed), and a setter that calls
					// startCapping() BEFORE storing config.capLevelToPlayerSize, while startCapping() returns early as long
					// as that flag is false -- so the setter alone never restarts capping.
					tmpHls.config = Object.assign({}, tmpHls.config);
					tmpHls.capLevelController =
						{
							capping: true,
							startCapping: function () { if (this.capping || !tmpHls.config.capLevelToPlayerSize) { return; } this.capping = true; },
							stopCapping: function () { this.capping = false; }
						};
					Object.defineProperty(tmpHls, 'capLevelToPlayerSize',
						{
							configurable: true,
							enumerable: true,
							get: function () { return !!tmpHls.config.capLevelToPlayerSize; },
							set: function (pValue)
							{
								const tmpNew = !!pValue;
								if (tmpNew === !!tmpHls.config.capLevelToPlayerSize) { return; }
								if (tmpNew) { tmpHls.capLevelController.startCapping(); }
								else { tmpHls.capLevelController.stopCapping(); tmpHls.autoLevelCapping = -1; }
								tmpHls.config.capLevelToPlayerSize = tmpNew;
							}
						});
					tmpHls.parseManifest();
					tmpHarness.view.setQuality('saver');
					Expect(tmpHls.capLevelController.capping).to.equal(false);
					Expect(tmpHls.autoLevelCapping).to.equal(1);
					tmpHarness.view.setQuality('auto');
					Expect(tmpHls.capLevelToPlayerSize).to.equal(true);
					Expect(tmpHls.capLevelController.capping).to.equal(true);
					return fDone();
				});
				test('with the player-size capper configured off, leaving Data saver clears its cap', (fDone) =>
				{
					const tmpHarness = buildHlsView({ HlsConfig: { capLevelToPlayerSize: false } });
					tmpHarness.hls.parseManifest();
					tmpHarness.view.setQuality('saver');
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(1);
					tmpHarness.view.setQuality('auto');
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(-1);
					Expect(tmpHarness.hls.capLevelToPlayerSize).to.equal(false);
					return fDone();
				});
				test('SaverMaxHeight moves the Data saver ceiling', (fDone) =>
				{
					const tmpHarness = buildHlsView({ SaverMaxHeight: 400 });
					tmpHarness.hls.parseManifest();
					tmpHarness.view.setQuality('saver');
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(0);
					return fDone();
				});
				test('an unknown pick is refused', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					Expect(tmpHarness.view.setQuality('ultra')).to.equal(false);
					Expect(tmpHarness.view.getQuality()).to.equal('auto');
					return fDone();
				});
				test('with storage unavailable (jsdom throws on localStorage) picks still work in memory', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					Expect(() => tmpHarness.view.setQuality(720)).to.not.throw();
					Expect(tmpHarness.view.getQuality()).to.equal(720);
					return fDone();
				});
			}
		);

		suite
		(
			'Quality persistence (localStorage)',
			() =>
			{
				let _Storage = null;
				setup(() => { FakeHls.reset(); _Storage = installFakeStorage(); });
				teardown(() => { FakeHls.reset(); _Storage.restore(); _Storage = null; });

				test('a pick persists under QualityStorageKey and is restored (and applied) on the next load', (fDone) =>
				{
					const tmpFirst = buildHlsView();
					tmpFirst.hls.parseManifest();
					tmpFirst.view.setQuality(720);
					Expect(JSON.parse(_Storage.data['pict-section-video-quality']).Quality).to.equal(720);

					const tmpSecond = buildHlsView();
					Expect(tmpSecond.view.getQuality()).to.equal(720);
					tmpSecond.hls.parseManifest();
					Expect(tmpSecond.hls.currentLevel).to.equal(2);
					return fDone();
				});
				test('a restored Data saver pick caps the next player', (fDone) =>
				{
					_Storage.store.setItem('pict-section-video-quality', JSON.stringify({ Quality: 'saver' }));
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					Expect(tmpHarness.hls.autoLevelCapping).to.equal(1);
					// Start level is held at or under the cap too.
					Expect(tmpHarness.hls.startLevel).to.equal(1);
					return fDone();
				});
				test('a custom QualityStorageKey is honoured; an empty key disables persistence', (fDone) =>
				{
					const tmpCustom = buildHlsView({ QualityStorageKey: 'my-player' });
					tmpCustom.hls.parseManifest();
					tmpCustom.view.setQuality(540);
					Expect(JSON.parse(_Storage.data['my-player']).Quality).to.equal(540);

					const tmpOff = buildHlsView({ QualityStorageKey: '' });
					tmpOff.hls.parseManifest();
					tmpOff.view.setQuality(360);
					Expect(Object.keys(_Storage.data)).to.deep.equal([ 'my-player' ]);
					return fDone();
				});
				test('the bandwidth estimate is saved only after a real fragment, and seeds the next visit', (fDone) =>
				{
					const tmpFirst = buildHlsView();
					tmpFirst.hls.parseManifest();
					tmpFirst.view.play();
					// hls.js reports its default estimate before measuring anything: never persist that.
					tmpFirst.hls.bandwidthEstimate = 500000;
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, { frag: { sn: 'initSegment', type: 'main' } });
					Expect(_Storage.data['pict-section-video-quality']).to.equal(undefined);
					tmpFirst.hls.bandwidthEstimate = 4200000;
					// 1.5 MB in 2 s over the network (6 Mbps): hls.js's smoothed 4.2 Mbps is what is kept.
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, makeFragBuffered(1500000, 2000));
					Expect(JSON.parse(_Storage.data['pict-section-video-quality']).BandwidthEstimate).to.equal(4200000);

					const tmpSecond = buildHlsView();
					Expect(tmpSecond.hls.config.startLevel).to.equal(-1);
					Expect(tmpSecond.hls.config.testBandwidth).to.equal(false);
					Expect(tmpSecond.hls.config.abrEwmaDefaultEstimate).to.equal(4200000);
					return fDone();
				});
				test('a play served from the HTTP cache (or loopback) never seeds the next visit', (fDone) =>
				{
					// The live case: media is served `immutable`, a replay reads 4.9 MB fragments from the cache in a few
					// ms, and hls.js's estimator reads that as ~760 Mbps. Persisting it would start every later visit on the
					// top rung whatever the real network.
					const tmpFirst = buildHlsView();
					tmpFirst.hls.parseManifest();
					tmpFirst.view.play();
					tmpFirst.hls.bandwidthEstimate = 758569277;
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, makeFragBuffered(4900000, 6));
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, makeFragBuffered(4900000, 4));
					Expect(_Storage.data['pict-section-video-quality']).to.equal(undefined);
					// Nor on teardown.
					tmpFirst.view.setSource(makeHlsSource());
					Expect(_Storage.data['pict-section-video-quality']).to.equal(undefined);

					// The next visit is a first visit again: hls.js starts on the ~540p first variant.
					const tmpSecond = buildHlsView();
					Expect(tmpSecond.hls.config).to.not.have.property('startLevel');
					Expect(tmpSecond.hls.config).to.not.have.property('abrEwmaDefaultEstimate');
					return fDone();
				});
				test('a cache-inflated estimate is held to what the network actually delivered', (fDone) =>
				{
					// Cached fragments first (hls.js mixes them into its average), then one real 3 Mbps transfer: hls.js still
					// reports ~51 Mbps, but nothing this session crossed the network faster than 3 Mbps.
					const tmpFirst = buildHlsView();
					tmpFirst.hls.parseManifest();
					tmpFirst.view.play();
					tmpFirst.hls.bandwidthEstimate = 758569277;
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, makeFragBuffered(4900000, 6));
					tmpFirst.hls.bandwidthEstimate = 50900000;
					tmpFirst.hls.emit(FakeHls.Events.FRAG_BUFFERED, makeFragBuffered(1500000, 4000));
					Expect(JSON.parse(_Storage.data['pict-section-video-quality']).BandwidthEstimate).to.equal(3000000);
					// The teardown save follows the same rule.
					tmpFirst.hls.bandwidthEstimate = 61000000;
					tmpFirst.view.setSource(makeHlsSource());
					Expect(JSON.parse(_Storage.data['pict-section-video-quality']).BandwidthEstimate).to.equal(3000000);
					return fDone();
				});
				test('storage that throws on read and write is tolerated', (fDone) =>
				{
					_Storage.store.getItem = function () { throw new Error('SecurityError'); };
					_Storage.store.setItem = function () { throw new Error('QuotaExceededError'); };
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					Expect(() => tmpHarness.view.setQuality(1080)).to.not.throw();
					Expect(tmpHarness.hls.currentLevel).to.equal(3);
					return fDone();
				});
			}
		);

		suite
		(
			'Native HLS',
			() =>
			{
				let _Storage = null;
				setup(() => { FakeHls.reset(); _Storage = installFakeStorage(); });
				teardown(() => { FakeHls.reset(); _Storage.restore(); _Storage = null; delete window.ManagedMediaSource; });

				/** A player whose <video> answers canPlayType for HLS (no hls.js configured unless given). */
				function buildNativeView(pConfigOverrides, pSourceOverrides)
				{
					const tmpHarness = buildView(pConfigOverrides);
					tmpHarness.view._videoElement.canPlayType = function (pMIME) { return (pMIME === libStrategy.HLS_MIME) ? 'maybe' : ''; };
					tmpHarness.view.setSource(makeHlsSource(pSourceOverrides));
					return tmpHarness;
				}

				test('plays the master natively and lists the rungs from Stream.Renditions', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					Expect(tmpHarness.view.getStrategy()).to.equal('native-hls');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/master.m3u8');
					Expect(tmpHarness.view.getQualityLevels().map((pLevel) => pLevel.Label))
						.to.deep.equal([ '1080p · 6 Mbps', '720p · 3.5 Mbps', '540p · 2.2 Mbps', '360p · 900 kbps' ]);
					Expect(tmpHarness.view._qualityWrapElement.style.display).to.equal('inline-flex');
					return fDone();
				});
				test('Safari with ManagedMediaSource stays native even when hls.js is on the page', (fDone) =>
				{
					window.ManagedMediaSource = function () {};
					const tmpHarness = buildNativeView({ HlsLibrary: FakeHls });
					Expect(tmpHarness.view.getStrategy()).to.equal('native-hls');
					Expect(FakeHls.instances.length).to.equal(0);
					return fDone();
				});
				test('the Auto label follows videoHeight on resize (short side, so portrait reads right)', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpVideo = tmpHarness.view._videoElement;
					Object.defineProperty(tmpVideo, 'videoWidth', { configurable: true, value: 1280 });
					Object.defineProperty(tmpVideo, 'videoHeight', { configurable: true, value: 720 });
					tmpVideo.onresize();
					Expect(tmpHarness.view.getState().PlayingHeight).to.equal(720);
					tmpHarness.view.toggleQualityMenu();
					Expect(menuLabels(tmpHarness.view)[0]).to.equal('Auto (720p)');
					Object.defineProperty(tmpVideo, 'videoWidth', { configurable: true, value: 1080 });
					Object.defineProperty(tmpVideo, 'videoHeight', { configurable: true, value: 1920 });
					tmpVideo.onresize();
					Expect(tmpHarness.view.getState().PlayingHeight).to.equal(1080);
					return fDone();
				});
				test('a pick loads that rung\'s playlist, keeping the position and the playing state', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 42);
					tmpView._videoElement.onplay();

					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView.setQuality(1080);
					Expect(tmpView._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/v0/index.m3u8');
					// The readout holds the place while the rung reloads.
					Expect(tmpView.getState().CurrentTime).to.equal(42);

					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(42);
					Expect(tmpPlays).to.be.at.least(1);
					return fDone();
				});
				test('a pick while paused restores the position without playing', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 100);
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView.setQuality(360);
					Expect(tmpView._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/v3/index.m3u8');
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(100);
					Expect(tmpPlays).to.equal(0);
					return fDone();
				});
				test('a pause while the picked rung reloads is kept: loadedmetadata restores the time without playing', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 60);
					tmpView._videoElement.onplay();
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView.setQuality(1080);
					// The native element resumes a playing restore at once ...
					Expect(tmpPlays).to.equal(1);
					tmpView._videoElement.onplay();
					// ... and the reader taps pause before the new playlist reports its metadata.
					tmpView.togglePlay();
					tmpView._videoElement.onpause();
					tmpPlays = 0;
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(60);
					Expect(tmpPlays).to.equal(0);
					Expect(tmpView.getState().Playing).to.equal(false);
					return fDone();
				});
				test('a pause from outside the control bar (the OS media keys) during the reload sticks too', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 60);
					tmpView._videoElement.onplay();
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView.setQuality(1080);
					tmpView._videoElement.onplay();
					// Only the element's pause event — no call through the view.
					tmpView._videoElement.onpause();
					tmpPlays = 0;
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(60);
					Expect(tmpPlays).to.equal(0);
					return fDone();
				});
				test('a play while a paused restore reloads resumes playback once metadata arrives', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 100);
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView.setQuality(360);
					Expect(tmpPlays).to.equal(0);
					tmpView.togglePlay();
					tmpPlays = 0;
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(100);
					Expect(tmpPlays).to.equal(1);
					return fDone();
				});
				test('the readout and scrubber hold the place through the reload (its timeupdate at 0 does not flash 0:00)', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					const tmpView = tmpHarness.view;
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 42);
					const tmpSeekValue = String(Math.round((42 / 312) * 1000));
					Expect(tmpView._seekElement.value).to.equal(tmpSeekValue);
					tmpView.setQuality(1080);
					// The load algorithm resets the position to 0 and its duration to NaN, then queues a timeupdate.
					Object.defineProperty(tmpView._videoElement, 'duration', { configurable: true, value: NaN });
					simulateTimeUpdate(tmpView, 0);
					Expect(tmpView.getState().CurrentTime).to.equal(42);
					Expect(tmpView.getState().Duration).to.equal(312);
					Expect(tmpView._currentTimeElement.textContent).to.equal('0:42');
					Expect(tmpView._durationElement.textContent).to.equal('5:12');
					Expect(tmpView._seekElement.value).to.equal(tmpSeekValue);
					Expect(tmpView._seekElement.disabled).to.equal(false);

					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(42);
					// Restored: timeupdate drives the readout again.
					simulateTimeUpdate(tmpView, 43);
					Expect(tmpView.getState().CurrentTime).to.equal(43);
					Expect(tmpView._currentTimeElement.textContent).to.equal('0:43');
					return fDone();
				});
				test('Data saver loads the <=540p rung playlist; Auto goes back to the master', (fDone) =>
				{
					const tmpHarness = buildNativeView();
					tmpHarness.view.setQuality('saver');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/v2/index.m3u8');
					tmpHarness.view.setQuality('auto');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/master.m3u8');
					return fDone();
				});
				test('a remembered pick loads its rung directly', (fDone) =>
				{
					_Storage.store.setItem('pict-section-video-quality', JSON.stringify({ Quality: 720 }));
					const tmpHarness = buildNativeView();
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/v1/index.m3u8');
					return fDone();
				});
			}
		);

		suite
		(
			'Error mapping + fallback ladder',
			() =>
			{
				setup(() => { FakeHls.reset(); });
				teardown(() => { FakeHls.reset(); });

				[ 401, 403, 404, 410 ].forEach((pStatus) =>
				{
					test('an hls.js network error with HTTP ' + pStatus + ' shows the revoked message (no retries)', (fDone) =>
					{
						const tmpHarness = buildHlsView();
						tmpHarness.hls.parseManifest();
						tmpHarness.view.play();
						tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.NETWORK_ERROR, details: FakeHls.ErrorDetails.FRAG_LOAD_ERROR, fatal: true, response: { code: pStatus, text: 'Gone' } });
						const tmpStage = document.getElementById(tmpHarness.viewHash + '-Stage');
						Expect(tmpHarness.view.getState().Error).to.equal(true);
						Expect(tmpStage.querySelector('.psv-error p').textContent).to.equal('This link has expired or been revoked.');
						Expect(tmpHarness.hls.calls.startLoad.length).to.equal(1);
						Expect(tmpHarness.hls.destroyed).to.equal(true);
						return fDone();
					});
				});
				test('with DownloadURL:null the revoked state offers no download link anywhere', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.NETWORK_ERROR, details: FakeHls.ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true, response: { code: 410 } });
					const tmpStage = document.getElementById(tmpHarness.viewHash + '-Stage');
					Expect(tmpStage.querySelector('.psv-error')).to.not.equal(null);
					Expect(tmpStage.querySelector('a')).to.equal(null);
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					// And the quality button hides with the error.
					Expect(tmpHarness.view._qualityWrapElement.style.display).to.equal('none');
					return fDone();
				});
				test('other fatal network errors retry startLoad 3 times, then fall back', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.play();
					const tmpNetwork = { type: FakeHls.ErrorTypes.NETWORK_ERROR, details: FakeHls.ErrorDetails.FRAG_LOAD_ERROR, fatal: true, response: { code: 0 } };
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.fail(tmpNetwork);
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(4);   // the first play + 3 retries
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					tmpHarness.hls.fail(tmpNetwork);
					// No native HLS, no ProgressiveURL: the ladder ends at the error state.
					Expect(tmpHarness.view.getState().Error).to.equal(true);
					Expect(tmpHarness.view.getState().ErrorMessage).to.equal('This video could not be played.');
					return fDone();
				});
				test('a manifest that fails before parsing is re-requested with loadSource', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.NETWORK_ERROR, details: FakeHls.ErrorDetails.MANIFEST_LOAD_ERROR, fatal: true, response: { code: 503 } });
					Expect(tmpHarness.hls.calls.loadSource.length).to.equal(2);
					return fDone();
				});
				test('a buffered fragment resets the retry budget', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view.play();
					const tmpNetwork = { type: FakeHls.ErrorTypes.NETWORK_ERROR, fatal: true, response: { code: 502 } };
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.emit(FakeHls.Events.FRAG_BUFFERED, { frag: { sn: 3, type: 'main' } });
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.fail(tmpNetwork);
					tmpHarness.hls.fail(tmpNetwork);
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					return fDone();
				});
				test('non-fatal errors are left to hls.js', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.NETWORK_ERROR, fatal: false, response: { code: 500 } });
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.MEDIA_ERROR, fatal: false });
					Expect(tmpHarness.hls.calls.startLoad.length).to.equal(0);
					Expect(tmpHarness.hls.calls.recoverMediaError).to.equal(0);
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					return fDone();
				});
				test('a fatal MEDIA_ERROR calls recoverMediaError once, then falls back', (fDone) =>
				{
					const tmpHarness = buildHlsView({}, { Stream: Object.assign({}, makeHlsSource().Stream, { ProgressiveURL: '/media/1a2b3c4d/download.mp4' }) });
					tmpHarness.hls.parseManifest();
					const tmpMedia = { type: FakeHls.ErrorTypes.MEDIA_ERROR, details: FakeHls.ErrorDetails.BUFFER_APPEND_ERROR, fatal: true };
					tmpHarness.hls.fail(tmpMedia);
					Expect(tmpHarness.hls.calls.recoverMediaError).to.equal(1);
					Expect(tmpHarness.view.getStrategy()).to.equal('hls.js');
					tmpHarness.hls.fail(tmpMedia);
					Expect(tmpHarness.hls.calls.recoverMediaError).to.equal(1);
					Expect(tmpHarness.hls.destroyed).to.equal(true);
					Expect(tmpHarness.view.getStrategy()).to.equal('progressive');
					Expect(tmpHarness.view._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/download.mp4');
					return fDone();
				});
				test('a <video> error under hls.js tries recoverMediaError first', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.parseManifest();
					tmpHarness.view._videoElement.onerror();
					Expect(tmpHarness.hls.calls.recoverMediaError).to.equal(1);
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					return fDone();
				});
				test('the full ladder: hls.js → native HLS → progressive → error state, keeping the position', (fDone) =>
				{
					const tmpHarness = buildView({ HlsLibrary: FakeHls });
					const tmpView = tmpHarness.view;
					// Chrome-like: canPlayType answers, no ManagedMediaSource, hls.js supported → hls.js first.
					tmpView._videoElement.canPlayType = function () { return 'maybe'; };
					tmpView.setSource(makeHlsSource({ DownloadURL: null, Stream: Object.assign({}, makeHlsSource().Stream, { ProgressiveURL: '/media/1a2b3c4d/download.mp4' }) }));
					const tmpHls = FakeHls.last();
					Expect(tmpView.getStrategy()).to.equal('hls.js');
					tmpHls.parseManifest();
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 61);

					tmpHls.fail({ type: FakeHls.ErrorTypes.OTHER_ERROR, details: FakeHls.ErrorDetails.INTERNAL_EXCEPTION, fatal: true });
					Expect(tmpHls.destroyed).to.equal(true);
					Expect(tmpView.getStrategy()).to.equal('native-hls');
					Expect(tmpView._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/master.m3u8');
					Expect(tmpView.getState().CurrentTime).to.equal(61);

					tmpView._videoElement.onerror();
					Expect(tmpView.getStrategy()).to.equal('progressive');
					Expect(tmpView._videoElement.getAttribute('src')).to.equal('/media/1a2b3c4d/download.mp4');
					Expect(tmpView.getState().CurrentTime).to.equal(61);

					tmpView._videoElement.onerror();
					Expect(tmpView.getState().Error).to.equal(true);
					const tmpStage = document.getElementById(tmpHarness.viewHash + '-Stage');
					Expect(tmpStage.querySelector('.psv-error p').textContent).to.equal('This video could not be played.');
					// DownloadURL:null → no link even though a progressive file exists.
					Expect(tmpStage.querySelector('a')).to.equal(null);
					return fDone();
				});
				test('an HLS source this browser cannot play at all is unsupported', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setSource(makeHlsSource());
					Expect(tmpHarness.view.getStrategy()).to.equal('unsupported');
					Expect(tmpHarness.view.getState().Error).to.equal(true);
					return fDone();
				});
				test('a fresh setSource after a failure starts a fresh ladder', (fDone) =>
				{
					const tmpHarness = buildHlsView();
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.NETWORK_ERROR, fatal: true, response: { code: 410 } });
					Expect(tmpHarness.view.getState().Error).to.equal(true);
					tmpHarness.view.setSource(makeHlsSource());
					Expect(tmpHarness.view.getState().Error).to.equal(false);
					Expect(tmpHarness.view.getStrategy()).to.equal('hls.js');
					Expect(FakeHls.instances.length).to.equal(2);
					Expect(tmpHarness.view._videoElement).to.not.equal(null);
					return fDone();
				});
			}
		);

		suite
		(
			'DownloadURL',
			() =>
			{
				test('absent falls back to the playing URL; an explicit string wins', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setSource({ URL: 'https://host/clip.mp4' });
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('https://host/clip.mp4');
					tmpHarness.view.setSource({ URL: 'https://host/clip.mp4', DownloadURL: '' });
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('https://host/clip.mp4');
					tmpHarness.view.setSource({ URL: 'https://host/clip.mp4', DownloadURL: 'https://host/original.mov', DownloadName: 'original.mov' });
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('https://host/original.mov');
					Expect(tmpHarness.view._downloadElement.getAttribute('download')).to.equal('original.mov');
					return fDone();
				});
				test('null hides the control-bar download and the error-state link', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setSource({ URL: 'https://host/clip.mp4', DownloadURL: null });
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					tmpHarness.view._videoElement.onerror();
					const tmpStage = document.getElementById(tmpHarness.viewHash + '-Stage');
					Expect(tmpStage.querySelector('.psv-error')).to.not.equal(null);
					Expect(tmpStage.querySelector('a')).to.equal(null);
					return fDone();
				});
				test('a progressive error state still links the file when DownloadURL is absent', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setSource({ URL: 'https://host/clip.mp4' });
					tmpHarness.view._videoElement.onerror();
					const tmpLink = document.getElementById(tmpHarness.viewHash + '-Stage').querySelector('a');
					Expect(tmpLink).to.not.equal(null);
					Expect(tmpLink.getAttribute('href')).to.equal('https://host/clip.mp4');
					return fDone();
				});
				test('an HLS source never offers the playlist: absent → its ProgressiveURL, or nothing', (fDone) =>
				{
					FakeHls.reset();
					const tmpHarness = buildView({ HlsLibrary: FakeHls });
					const tmpSource = makeHlsSource();
					delete tmpSource.DownloadURL;
					tmpHarness.view.setSource(tmpSource);
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					const tmpWithFile = makeHlsSource({ Stream: Object.assign({}, makeHlsSource().Stream, { ProgressiveURL: '/media/1a2b3c4d/download.mp4' }) });
					delete tmpWithFile.DownloadURL;
					tmpHarness.view.setSource(tmpWithFile);
					Expect(tmpHarness.view._downloadElement.getAttribute('href')).to.equal('/media/1a2b3c4d/download.mp4');
					FakeHls.reset();
					return fDone();
				});
				test('a DownloadURL:null in the view config suppresses the download from the start', (fDone) =>
				{
					const tmpHarness = buildView({ VideoURL: 'https://host/seed.mp4', DownloadURL: null });
					Expect(tmpHarness.view._downloadElement.style.display).to.equal('none');
					return fDone();
				});
			}
		);

		suite
		(
			'PreservePosition + self-heal',
			() =>
			{
				test('a self-heal rebuild resumes at the same position and keeps playing', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpView, 120);
					simulateTimeUpdate(tmpView, 42);
					tmpView._videoElement.onplay();
					const tmpOldVideo = tmpView._videoElement;

					const tmpPrototypePlay = window.HTMLMediaElement.prototype.play;
					let tmpPlays = 0;
					window.HTMLMediaElement.prototype.play = function () { tmpPlays++; return Promise.resolve(); };
					try
					{
						tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
						tmpView.render();
						Expect(tmpView._videoElement).to.not.equal(tmpOldVideo);
						// The outgoing element is silenced.
						Expect(tmpOldVideo.onplay).to.equal(null);
						Expect(tmpOldVideo.getAttribute('src')).to.equal(null);
						Expect(tmpView._videoElement.getAttribute('src')).to.equal('https://host/clip.mp4');
						Expect(tmpView.getState().CurrentTime).to.equal(42);
						simulateMetadata(tmpView, 120);
						Expect(tmpView._videoElement.currentTime).to.equal(42);
						Expect(tmpPlays).to.be.at.least(1);
					}
					finally
					{
						window.HTMLMediaElement.prototype.play = tmpPrototypePlay;
					}
					return fDone();
				});
				test('a self-heal of a paused player restores the time without playing', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpView, 120);
					simulateTimeUpdate(tmpView, 17);
					const tmpPrototypePlay = window.HTMLMediaElement.prototype.play;
					let tmpPlays = 0;
					window.HTMLMediaElement.prototype.play = function () { tmpPlays++; return Promise.resolve(); };
					try
					{
						tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
						tmpView.render();
						simulateMetadata(tmpView, 120);
						Expect(tmpView._videoElement.currentTime).to.equal(17);
						Expect(tmpPlays).to.equal(0);
					}
					finally
					{
						window.HTMLMediaElement.prototype.play = tmpPrototypePlay;
					}
					return fDone();
				});
				test('_loadVideo(url, { PreservePosition }) restores time on loadedmetadata; without it playback restarts', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/a.mp4');
					simulateMetadata(tmpView, 90);
					simulateTimeUpdate(tmpView, 30);
					tmpView._loadVideo('https://host/b.mp4', { PreservePosition: true });
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 90);
					Expect(tmpView._videoElement.currentTime).to.equal(30);

					simulateTimeUpdate(tmpView, 50);
					tmpView._loadVideo('https://host/c.mp4');
					Expect(tmpView.getState().CurrentTime).to.equal(0);
					return fDone();
				});
				test('an hls.js self-heal while playing re-attaches and starts loading at the saved position', (fDone) =>
				{
					FakeHls.reset();
					const tmpHarness = buildHlsView();
					const tmpView = tmpHarness.view;
					tmpHarness.hls.parseManifest();
					tmpView.play();
					tmpView._videoElement.onplay();
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 80);
					tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
					tmpView.render();
					Expect(tmpHarness.hls.destroyed).to.equal(true);
					const tmpSecond = FakeHls.last();
					Expect(tmpSecond).to.not.equal(tmpHarness.hls);
					Expect(tmpSecond.media).to.equal(tmpView._videoElement);
					tmpSecond.parseManifest();
					Expect(tmpSecond.calls.startLoad).to.deep.equal([ 80 ]);
					FakeHls.reset();
					return fDone();
				});
				test('a pause() while an hls.js reload is pending is kept even though the paused element fires no pause event', (fDone) =>
				{
					FakeHls.reset();
					const tmpHarness = buildHlsView();
					const tmpView = tmpHarness.view;
					tmpHarness.hls.parseManifest();
					tmpView.play();
					tmpView._videoElement.onplay();
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 80);
					tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
					tmpView.render();
					const tmpSecond = FakeHls.last();
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					// The rebuilt element is paused (nothing loaded yet), so pausing it fires nothing: only the call says so.
					tmpView.pause();
					tmpSecond.parseManifest();
					// A paused restore waits for a play before loading media.
					Expect(tmpSecond.calls.startLoad).to.deep.equal([]);
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(80);
					Expect(tmpPlays).to.equal(0);
					FakeHls.reset();
					return fDone();
				});
				test('a pause event the reload itself raises (nothing was playing yet) does not cancel the resume', (fDone) =>
				{
					FakeHls.reset();
					const tmpHarness = buildHlsView();
					const tmpView = tmpHarness.view;
					tmpHarness.hls.parseManifest();
					tmpView.play();
					tmpView._videoElement.onplay();
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 80);
					tmpHarness.pict.ContentAssignment.assignContent('#' + tmpHarness.hostId, '<!-- stub -->');
					tmpView.render();
					const tmpSecond = FakeHls.last();
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					tmpView._videoElement.onpause();
					tmpSecond.parseManifest();
					Expect(tmpSecond.calls.startLoad).to.deep.equal([ 80 ]);
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpPlays).to.equal(1);
					FakeHls.reset();
					return fDone();
				});
				test('a fallback step keeps a pause made while it reloads', (fDone) =>
				{
					FakeHls.reset();
					const tmpHarness = buildHlsView({}, { Stream: Object.assign({}, makeHlsSource().Stream, { ProgressiveURL: '/media/1a2b3c4d/download.mp4' }) });
					const tmpView = tmpHarness.view;
					tmpHarness.hls.parseManifest();
					tmpView.play();
					tmpView._videoElement.onplay();
					simulateMetadata(tmpView, 312);
					simulateTimeUpdate(tmpView, 90);
					let tmpPlays = 0;
					tmpView._videoElement.play = function () { tmpPlays++; return Promise.resolve(); };
					// hls.js gives up (no native HLS here): the progressive file reloads at 1:30, playing.
					tmpHarness.hls.fail({ type: FakeHls.ErrorTypes.OTHER_ERROR, details: FakeHls.ErrorDetails.INTERNAL_EXCEPTION, fatal: true });
					Expect(tmpView.getStrategy()).to.equal('progressive');
					Expect(tmpPlays).to.equal(1);
					tmpView._videoElement.onplay();
					tmpView.pause();
					tmpView._videoElement.onpause();
					tmpPlays = 0;
					resetCurrentTime(tmpView);
					simulateMetadata(tmpView, 312);
					Expect(tmpView._videoElement.currentTime).to.equal(90);
					Expect(tmpPlays).to.equal(0);
					FakeHls.reset();
					return fDone();
				});
			}
		);

		suite
		(
			'Buffering',
			() =>
			{
				test('waiting raises the spinner; playing and canplay lower it', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpView, 120);
					const tmpSpinner = document.getElementById(tmpHarness.viewHash + '-Spinner');
					Expect(tmpSpinner.style.display).to.equal('none');
					tmpView._videoElement.onwaiting();
					Expect(tmpView.getState().Waiting).to.equal(true);
					Expect(tmpSpinner.style.display).to.equal('block');
					tmpView._videoElement.onplaying();
					Expect(tmpView.getState().Waiting).to.equal(false);
					Expect(tmpView.getState().Playing).to.equal(true);
					Expect(tmpSpinner.style.display).to.equal('none');
					tmpView._videoElement.onwaiting();
					tmpView._videoElement.oncanplay();
					Expect(tmpView.getState().Waiting).to.equal(false);
					Expect(tmpSpinner.style.display).to.equal('none');
					return fDone();
				});
				test('seeking shows the spinner until seeked', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpView, 120);
					tmpView._videoElement.onseeking();
					Expect(tmpView.getState().Waiting).to.equal(true);
					tmpView._videoElement.onseeked();
					Expect(tmpView.getState().Waiting).to.equal(false);
					return fDone();
				});
				test('the spinner stays down while the initial Loading veil is up', (fDone) =>
				{
					const tmpHarness = buildView();
					tmpHarness.view.setVideo('https://host/clip.mp4');
					tmpHarness.view._videoElement.onwaiting();
					Expect(document.getElementById(tmpHarness.viewHash + '-Spinner').style.display).to.equal('none');
					return fDone();
				});
				test('progress sizes the buffered bar from the range around the playhead', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView.setVideo('https://host/clip.mp4');
					simulateMetadata(tmpView, 120);
					Object.defineProperty(tmpView._videoElement, 'buffered', { configurable: true, value: makeRanges([ [ 0, 10 ], [ 20, 45 ] ]) });
					simulateTimeUpdate(tmpView, 30);
					tmpView._videoElement.onprogress();
					Expect(tmpView.getState().Buffered).to.equal(45);
					Expect(document.getElementById(tmpHarness.viewHash + '-Buffered').style.width).to.equal('37.5%');
					simulateTimeUpdate(tmpView, 15);
					Expect(tmpView.getState().Buffered).to.equal(0);
					return fDone();
				});
				test('Preload:none does not veil the poster with Loading… (not even for a paused restore)', (fDone) =>
				{
					const tmpHarness = buildView({ Preload: 'none' });
					tmpHarness.view.setVideo('https://host/clip.mp4');
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('none');
					simulateMetadata(tmpHarness.view, 120);
					simulateTimeUpdate(tmpHarness.view, 20);
					tmpHarness.view._loadVideo('https://host/clip.mp4', { PreservePosition: true });
					Expect(tmpHarness.view._loadingElement.style.display).to.equal('none');
					return fDone();
				});
			}
		);

		suite
		(
			'Fullscreen ladder',
			() =>
			{
				teardown(() => { clearFullscreenElement(); });

				test('requestFullscreen() on the player root first; fullscreenchange keeps the state honest', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					let tmpRequests = 0;
					tmpView._rootElement.requestFullscreen = function () { tmpRequests++; return Promise.resolve(); };
					Expect(tmpView.enterFullscreen()).to.equal(true);
					Expect(tmpRequests).to.equal(1);
					Expect(tmpView.isFullscreen()).to.equal(true);
					Expect(tmpView._fullscreenMode).to.equal('api');
					Expect(tmpView._keydownHandler).to.equal(null);

					setFullscreenElement(tmpView._rootElement);
					document.dispatchEvent(new window.Event('fullscreenchange'));
					Expect(tmpView.isFullscreen()).to.equal(true);

					// The reader leaves with the browser's own Esc / UI.
					setFullscreenElement(null);
					document.dispatchEvent(new window.Event('fullscreenchange'));
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpView._rootElement.classList.contains('psv-fullscreen')).to.equal(false);
					Expect(tmpView._fullscreenChangeHandler).to.equal(null);
					return fDone();
				});
				test('exitFullscreen() leaves real fullscreen through document.exitFullscreen', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._rootElement.requestFullscreen = function () { return Promise.resolve(); };
					let tmpExits = 0;
					document.exitFullscreen = function () { tmpExits++; return Promise.resolve(); };
					tmpView.enterFullscreen();
					setFullscreenElement(tmpView._rootElement);
					Expect(tmpView.exitFullscreen()).to.equal(true);
					Expect(tmpExits).to.equal(1);
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpView.exitFullscreen()).to.equal(false);
					return fDone();
				});
				test('an exit while requestFullscreen() is still in flight leaves fullscreen as soon as the request lands', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					let fLand = null;
					tmpView._rootElement.requestFullscreen = function () { return new Promise((fResolve) => { fLand = fResolve; }); };
					let tmpExits = 0;
					document.exitFullscreen = function () { tmpExits++; return Promise.resolve(); };
					tmpView.enterFullscreen();
					// A quick second click: the request has not landed yet (no fullscreenElement), so nothing can be left.
					Expect(tmpView.toggleFullscreen()).to.equal(true);
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpExits).to.equal(0);
					// The request lands.
					setFullscreenElement(tmpView._rootElement);
					fLand();
					setTimeout(() =>
					{
						try
						{
							Expect(tmpExits).to.equal(1);
							Expect(tmpView.isFullscreen()).to.equal(false);
							Expect(tmpView._fullscreenChangeHandler).to.equal(null);
							// Its fullscreenchange (and the exit's) change nothing further.
							document.dispatchEvent(new window.Event('fullscreenchange'));
							setFullscreenElement(null);
							document.dispatchEvent(new window.Event('fullscreenchange'));
							Expect(tmpExits).to.equal(1);
							Expect(tmpView.isFullscreen()).to.equal(false);
							return fDone();
						}
						catch (pError)
						{
							return fDone(pError);
						}
					}, 0);
				});
				test('a prefixed request (no promise) that lands after an exit is undone on its fullscreenchange', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._rootElement.webkitRequestFullscreen = function () { return undefined; };
					let tmpExits = 0;
					document.exitFullscreen = function () { tmpExits++; return Promise.resolve(); };
					tmpView.enterFullscreen();
					tmpView.exitFullscreen();
					Expect(tmpExits).to.equal(0);
					// The listener stays while the request is in flight.
					Expect(tmpView._fullscreenChangeHandler).to.not.equal(null);
					setFullscreenElement(tmpView._rootElement);
					document.dispatchEvent(new window.Event('webkitfullscreenchange'));
					Expect(tmpExits).to.equal(1);
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpView._fullscreenChangeHandler).to.equal(null);
					document.dispatchEvent(new window.Event('webkitfullscreenchange'));
					Expect(tmpExits).to.equal(1);
					return fDone();
				});
				test('re-entering before the first request lands stays fullscreen', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					const tmpLanders = [];
					tmpView._rootElement.requestFullscreen = function () { return new Promise((fResolve) => { tmpLanders.push(fResolve); }); };
					let tmpExits = 0;
					document.exitFullscreen = function () { tmpExits++; return Promise.resolve(); };
					tmpView.enterFullscreen();
					tmpView.exitFullscreen();
					tmpView.enterFullscreen();
					setFullscreenElement(tmpView._rootElement);
					tmpLanders.forEach((fLand) => fLand());
					document.dispatchEvent(new window.Event('fullscreenchange'));
					setTimeout(() =>
					{
						try
						{
							Expect(tmpExits).to.equal(0);
							Expect(tmpView.isFullscreen()).to.equal(true);
							Expect(tmpView._fullscreenMode).to.equal('api');
							// The reader then leaves through the browser: tracked as usual.
							setFullscreenElement(null);
							document.dispatchEvent(new window.Event('fullscreenchange'));
							Expect(tmpView.isFullscreen()).to.equal(false);
							Expect(tmpView._fullscreenChangeHandler).to.equal(null);
							return fDone();
						}
						catch (pError)
						{
							return fDone(pError);
						}
					}, 0);
				});
				test('a fullscreenchange that arrives before our request lands (another element leaving) is not read as an exit', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._rootElement.requestFullscreen = function () { return new Promise(() => {}); };
					tmpView.enterFullscreen();
					setFullscreenElement(null);
					document.dispatchEvent(new window.Event('fullscreenchange'));
					Expect(tmpView.isFullscreen()).to.equal(true);
					Expect(tmpView._fullscreenChangeHandler).to.not.equal(null);
					// Ours lands, then the reader leaves through the browser.
					setFullscreenElement(tmpView._rootElement);
					document.dispatchEvent(new window.Event('fullscreenchange'));
					Expect(tmpView.isFullscreen()).to.equal(true);
					setFullscreenElement(null);
					document.dispatchEvent(new window.Event('fullscreenchange'));
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpView._fullscreenChangeHandler).to.equal(null);
					return fDone();
				});
				test('a request refused after an exit drops the listener and stays out of fullscreen', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					let fRefuse = null;
					tmpView._rootElement.requestFullscreen = function () { return new Promise((fResolve, fReject) => { fRefuse = fReject; }); };
					tmpView.enterFullscreen();
					tmpView.exitFullscreen();
					fRefuse(new Error('NotAllowedError'));
					setTimeout(() =>
					{
						try
						{
							Expect(tmpView.isFullscreen()).to.equal(false);
							Expect(tmpView._fullscreenMode).to.equal('');
							Expect(tmpView._keydownHandler).to.equal(null);
							Expect(tmpView._fullscreenChangeHandler).to.equal(null);
							Expect(tmpView._rootElement.classList.contains('psv-fullscreen')).to.equal(false);
							return fDone();
						}
						catch (pError)
						{
							return fDone(pError);
						}
					}, 0);
				});
				test('a refused requestFullscreen() falls back to the CSS maximize', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._rootElement.requestFullscreen = function () { return Promise.reject(new Error('NotAllowedError')); };
					tmpView.enterFullscreen();
					setTimeout(() =>
					{
						try
						{
							Expect(tmpView._fullscreenMode).to.equal('css');
							Expect(tmpView.isFullscreen()).to.equal(true);
							Expect(tmpView._rootElement.classList.contains('psv-fullscreen')).to.equal(true);
							document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
							Expect(tmpView.isFullscreen()).to.equal(false);
							return fDone();
						}
						catch (pError)
						{
							return fDone(pError);
						}
					}, 0);
				});
				test('iPhone: webkitEnterFullscreen() on the <video>; webkitendfullscreen clears the state', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					let tmpEnters = 0;
					tmpView._videoElement.webkitEnterFullscreen = function () { tmpEnters++; };
					Expect(tmpView.enterFullscreen()).to.equal(true);
					Expect(tmpEnters).to.equal(1);
					Expect(tmpView.isFullscreen()).to.equal(true);
					Expect(tmpView._fullscreenMode).to.equal('webkit');
					// The native player takes over: no CSS maximize underneath.
					Expect(tmpView._rootElement.classList.contains('psv-fullscreen')).to.equal(false);
					tmpView._videoElement.dispatchEvent(new window.Event('webkitendfullscreen'));
					Expect(tmpView.isFullscreen()).to.equal(false);
					Expect(tmpView._webkitEndFullscreenHandler).to.equal(null);
					return fDone();
				});
				test('a webkitEnterFullscreen() that throws (no metadata yet) falls back to the CSS maximize', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._videoElement.webkitEnterFullscreen = function () { throw new Error('InvalidStateError'); };
					Expect(tmpView.enterFullscreen()).to.equal(true);
					Expect(tmpView._fullscreenMode).to.equal('css');
					Expect(tmpView._rootElement.classList.contains('psv-fullscreen')).to.equal(true);
					tmpView.exitFullscreen();
					return fDone();
				});
				test('without either API the CSS maximize acts and enterFullscreen returns true', (fDone) =>
				{
					const tmpHarness = buildView();
					Expect(tmpHarness.view.enterFullscreen()).to.equal(true);
					Expect(tmpHarness.view._fullscreenMode).to.equal('css');
					Expect(tmpHarness.view.enterFullscreen()).to.equal(true);
					tmpHarness.view.exitFullscreen();
					return fDone();
				});
				test('destroy leaves real fullscreen and drops the fullscreenchange listener', (fDone) =>
				{
					const tmpHarness = buildView();
					const tmpView = tmpHarness.view;
					tmpView._rootElement.requestFullscreen = function () { return Promise.resolve(); };
					let tmpExits = 0;
					document.exitFullscreen = function () { tmpExits++; return Promise.resolve(); };
					tmpView.enterFullscreen();
					setFullscreenElement(tmpView._rootElement);
					tmpView.destroy();
					Expect(tmpExits).to.equal(1);
					Expect(tmpView._fullscreenChangeHandler).to.equal(null);
					Expect(tmpView.isFullscreen()).to.equal(false);
					return fDone();
				});
			}
		);

		suite
		(
			'Volume on iOS + packaging',
			() =>
			{
				test('the volume slider hides where volume writes do not stick (iOS)', (fDone) =>
				{
					const tmpPrototype = window.HTMLMediaElement.prototype;
					const tmpDescriptor = Object.getOwnPropertyDescriptor(tmpPrototype, 'volume');
					Object.defineProperty(tmpPrototype, 'volume', { configurable: true, get: function () { return 1; }, set: function () {} });
					try
					{
						const tmpHarness = buildView();
						Expect(tmpHarness.view._volumeElement.style.display).to.equal('none');
					}
					finally
					{
						Object.defineProperty(tmpPrototype, 'volume', tmpDescriptor);
					}
					const tmpNormal = buildView();
					Expect(tmpNormal.view._volumeElement.style.display).to.not.equal('none');
					return fDone();
				});
				test('pict-view stays the only runtime dependency and hls.js is never required', (fDone) =>
				{
					const tmpPackage = JSON.parse(libFS.readFileSync(libPath.join(__dirname, '..', 'package.json'), 'utf8'));
					Expect(Object.keys(tmpPackage.dependencies)).to.deep.equal([ 'pict-view' ]);
					[ 'Pict-Section-Video.js', 'Pict-Section-Video-Strategy.js', 'Pict-Section-Video-DefaultConfiguration.js' ].forEach((pFile) =>
					{
						const tmpSource = libFS.readFileSync(libPath.join(__dirname, '..', 'source', pFile), 'utf8');
						Expect(/require\(\s*['"]hls/.test(tmpSource)).to.equal(false);
					});
					return fDone();
				});
				test('the <video> fills the stage, so hls.js capLevelToPlayerSize measures the player and not the decoded frame', (fDone) =>
				{
					// jsdom has no layout; check the rule itself. A width/height:auto <video> is as big as the rung it is
					// decoding (or 300x150 before metadata), which pins hls.js's player-size cap at the starting rung on 1x
					// screens and leaves the frame unscaled in real fullscreen.
					const tmpStyle = document.createElement('style');
					tmpStyle.textContent = libPictSectionVideo.default_configuration.CSS;
					document.head.appendChild(tmpStyle);
					try
					{
						const tmpRule = Array.prototype.find.call(tmpStyle.sheet.cssRules, (pRule) => pRule.selectorText === '.psv-video');
						Expect(tmpRule).to.not.equal(undefined);
						Expect(tmpRule.style.getPropertyValue('width')).to.equal('100%');
						Expect(tmpRule.style.getPropertyValue('height')).to.equal('100%');
						Expect(tmpRule.style.getPropertyValue('object-fit')).to.equal('contain');
					}
					finally
					{
						tmpStyle.parentNode.removeChild(tmpStyle);
					}
					return fDone();
				});
				test('the default configuration carries the streaming keys', (fDone) =>
				{
					const tmpConfiguration = libPictSectionVideo.default_configuration;
					Expect(tmpConfiguration.HlsLibrary).to.equal(null);
					Expect(tmpConfiguration.HlsConfig).to.deep.equal({});
					Expect(tmpConfiguration.ShowQuality).to.equal(true);
					Expect(tmpConfiguration.ShowDataSaver).to.equal(true);
					Expect(tmpConfiguration.QualityStorageKey).to.equal('pict-section-video-quality');
					Expect(tmpConfiguration.SaverMaxHeight).to.equal(540);
					Expect(tmpConfiguration.Preload).to.equal('metadata');
					return fDone();
				});
			}
		);
	}
);
