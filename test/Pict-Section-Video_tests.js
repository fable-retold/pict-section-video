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
	}
);
