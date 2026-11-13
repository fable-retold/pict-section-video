const libPictApplication = require('pict-application');
const libPictView = require('pict-view');

// The standalone video section (the class under test) and the fileview orchestrator, required straight from their
// sibling sources the way fileview_gallery does. hls.js is NOT required or bundled: the page loads
// hls.light.min.js with a <script> tag, and both players find it as window.Hls.
const libPictSectionVideo = require('../../source/Pict-Section-Video.js');
const libFileview = require('../../../pict-section-fileview/source/Pict-Section-Fileview.js');

// How often the per-player status lines re-read getState().
const STATUS_POLL_MS = 500;

// The fileview instance's identifier (one per page; it plays the landscape package).
const FILEVIEW_IDENTIFIER = 'HLSFileview';

/**
 * The page layout: an intro message and one cell per player, each with a mount div and a status line. Rendered once
 * before the package list arrives (the message) and once after (the cells); the players then mount into the cells,
 * so the layout never re-renders over them.
 */
class VideoHLSLayoutView extends libPictView
{
	onAfterRender(pRenderable, pAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pAddress, pRecord, pContent);
	}
}

const _LayoutConfiguration =
{
	ViewIdentifier: 'VideoHLS-Layout',
	DefaultRenderable: 'VideoHLS-Layout-Display',
	DefaultDestinationAddress: '#VideoHLS-Layout',
	AutoRender: false,
	CSS: /*css*/`
		.hls-message { font-size: 0.85rem; color: #8a4b2f; margin: 0 0 1rem 0; }
		.hls-message:empty { display: none; }
		.viewer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 1.25rem; align-items: start; }
		.viewer-cell { display: flex; flex-direction: column; min-width: 0; }
		.viewer-cell-label { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #264653; margin-bottom: 0.2rem; }
		.viewer-cell-note { font-size: 0.74rem; color: #8a7a63; margin: 0 0 0.5rem 0; line-height: 1.45; }
		/* pict-section-video's root is height:100%, so the host div sets the size. */
		.viewer-mount { height: 340px; border: 1px solid #D4A373; border-radius: 8px; overflow: hidden; background: #000; }
		.viewer-mount-portrait { height: 560px; }
		.viewer-mount-fileview { height: 400px; }
		.status-line { margin-top: 0.45rem; font: 0.74rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #264653; min-height: 1.5em; }
		.status-pill { display: inline-block; padding: 0 0.45em; border-radius: 4px; background: #264653; color: #FAEDCD; font-weight: 700; }
		.status-wait { color: #E76F51; font-weight: 700; }
	`,
	Templates:
	[
		{
			Hash: 'VideoHLS-Layout-Template',
			Template: /*html*/`
<p class="hls-message">{~D:AppData.VideoHLS.Message~}</p>
<div class="viewer-grid">{~TS:VideoHLS-Cell-Template:AppData.VideoHLS.Players~}</div>`
		},
		{
			Hash: 'VideoHLS-Cell-Template',
			Template: /*html*/`
<div class="viewer-cell">
	<div class="viewer-cell-label">{~D:Record.Label~}</div>
	<p class="viewer-cell-note">{~D:Record.Note~}</p>
	<div id="{~D:Record.Identifier~}-Mount" class="viewer-mount viewer-mount-{~D:Record.Shape~}"></div>
	<div id="{~D:Record.Identifier~}-Status" class="status-line"></div>
</div>`
		}
	],
	Renderables:
	[
		{
			RenderableHash: 'VideoHLS-Layout-Display',
			TemplateHash: 'VideoHLS-Layout-Template',
			DestinationAddress: '#VideoHLS-Layout',
			RenderMethod: 'replace'
		}
	]
};

/**
 * One status line per player, rendered into that cell's -Status div from AppData.VideoHLS.Status.<Identifier>.
 */
class VideoHLSStatusView extends libPictView
{
	/**
	 * Re-render one player's status line.
	 *
	 * @param {string} pIdentifier - the player's identifier (alphanumeric, so it is a plain AppData address segment)
	 */
	renderStatus(pIdentifier)
	{
		return this.render('VideoHLS-Status-Line', '#' + pIdentifier + '-Status', 'AppData.VideoHLS.Status.' + pIdentifier);
	}
}

const _StatusConfiguration =
{
	ViewIdentifier: 'VideoHLS-Status',
	DefaultRenderable: 'VideoHLS-Status-Line',
	AutoRender: false,
	Templates:
	[
		{
			Hash: 'VideoHLS-Status-Template',
			Template: /*html*/`<span class="status-pill">{~D:Record.Strategy~}</span> quality <b>{~D:Record.Quality~}</b> · playing <b>{~D:Record.Playing~}</b> · at {~D:Record.Time~} · buffered to <b>{~D:Record.Buffered~}</b> · {~D:Record.Levels~} rungs{~TS:VideoHLS-Status-Extra-Template:Record.Extras~}`
		},
		{
			Hash: 'VideoHLS-Status-Extra-Template',
			Template: /*html*/` · <span class="status-wait">{~D:Record.Text~}</span>`
		}
	],
	Renderables:
	[
		{
			RenderableHash: 'VideoHLS-Status-Line',
			TemplateHash: 'VideoHLS-Status-Template',
			DestinationAddress: '#VideoHLS-Status-Unused',
			RenderMethod: 'replace'
		}
	]
};

/**
 * A standalone pict-section-video configuration for one player. Every element id derives from the identifier, so
 * the players coexist on one page (each overrides the renderable/destination/target to its own mount div).
 *
 * @param {string} pIdentifier
 * @return {Object}
 */
function buildPlayerConfiguration(pIdentifier)
{
	const tmpMount = '#' + pIdentifier + '-Mount';
	return Object.assign({}, libPictSectionVideo.default_configuration,
	{
		ViewIdentifier: pIdentifier,
		RenderOnLoad: false,
		DefaultRenderable: pIdentifier + '-Wrap',
		DefaultDestinationAddress: tmpMount,
		TargetElementAddress: tmpMount,
		Templates: [ { Hash: pIdentifier + '-Container', Template: '<!-- hls player host -->' } ],
		Renderables: [ { RenderableHash: pIdentifier + '-Wrap', TemplateHash: pIdentifier + '-Container', DestinationAddress: tmpMount, RenderMethod: 'replace' } ],
		// A share page's settings: nothing loads until play, then the quality menu and data saver are on offer.
		Preload: 'none',
		ShowQuality: true,
		ShowDataSaver: true,
		HlsLibrary: ((typeof window !== 'undefined') && window.Hls) ? window.Hls : null
	});
}

/** Seconds as m:ss.s for the status line. */
function formatSeconds(pSeconds)
{
	const tmpSeconds = ((typeof pSeconds === 'number') && isFinite(pSeconds) && (pSeconds > 0)) ? pSeconds : 0;
	const tmpMinutes = Math.floor(tmpSeconds / 60);
	const tmpRemainder = tmpSeconds - (tmpMinutes * 60);
	return tmpMinutes + ':' + ((tmpRemainder < 10) ? '0' : '') + tmpRemainder.toFixed(1);
}

/** The status-line record for a player's getState() (display strings only; the template lays them out). */
function statusFromState(pState, pExtras)
{
	if (!pState)
	{
		return { Strategy: 'not mounted', Quality: '-', Playing: '-', Time: '-', Buffered: '-', Levels: 0, Extras: pExtras || [] };
	}
	const tmpExtras = (pExtras || []).slice();
	if (pState.Waiting) { tmpExtras.push({ Text: 'buffering' }); }
	if (pState.Error) { tmpExtras.push({ Text: 'error: ' + (pState.ErrorMessage || 'unknown') }); }
	return (
	{
		Strategy: pState.Strategy || 'idle',
		Quality: String(pState.Quality),
		Playing: pState.PlayingHeight ? (pState.PlayingHeight + 'p') : '-',
		Time: formatSeconds(pState.CurrentTime) + ' / ' + formatSeconds(pState.Duration),
		Buffered: formatSeconds(pState.Buffered),
		Levels: Array.isArray(pState.Levels) ? pState.Levels.length : 0,
		Extras: tmpExtras
	});
}

class VideoHLSExampleApplication extends libPictApplication
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.pict.addView('VideoHLS-Layout', _LayoutConfiguration, VideoHLSLayoutView);
		this.pict.addView('VideoHLS-Status', _StatusConfiguration, VideoHLSStatusView);

		this._statusTimer = null;
	}

	onAfterInitializeAsync(fCallback)
	{
		this.pict.AppData.VideoHLS =
		{
			Message: 'Loading the package list from /media/info ...',
			Packages: [],
			Players: [],
			Status: {}
		};
		this.pict.views['VideoHLS-Layout'].render();

		this.loadPackages();
		return super.onAfterInitializeAsync(fCallback);
	}

	/**
	 * Fetch the package list the example server publishes, then build the players.
	 */
	loadPackages()
	{
		if ((typeof window === 'undefined') || (typeof window.fetch !== 'function'))
		{
			return this.showMessage('This browser has no fetch(); the example cannot load its package list.');
		}
		window.fetch('/media/info', { cache: 'no-store' })
			.then((pResponse) =>
			{
				if (!pResponse.ok)
				{
					throw new Error('GET /media/info answered ' + pResponse.status
						+ ' -- this example needs its own server: run `npm start` in example_applications/video_hls.');
				}
				return pResponse.json();
			})
			.then((pPackages) =>
			{
				if (!Array.isArray(pPackages) || (pPackages.length < 1))
				{
					return this.showMessage('No media packages yet. Run `npm run make-media` in example_applications/video_hls, then reload.');
				}
				return this.buildPlayers(pPackages);
			})
			.catch((pError) =>
			{
				this.showMessage(pError.message);
			});
	}

	/** Show a message in place of the players. */
	showMessage(pMessage)
	{
		this.pict.AppData.VideoHLS.Message = pMessage;
		this.pict.AppData.VideoHLS.Players = [];
		this.pict.views['VideoHLS-Layout'].render();
	}

	/**
	 * Lay out one cell per package plus the fileview cell, then mount each player into its cell.
	 *
	 * @param {Array<{ Name: string, Base: string, Package: Object }>} pPackages - the /media/info body
	 */
	buildPlayers(pPackages)
	{
		const tmpState = this.pict.AppData.VideoHLS;
		const tmpHasHls = !!((typeof window !== 'undefined') && window.Hls);
		tmpState.Packages = pPackages;
		tmpState.Message = tmpHasHls ? '' : 'window.Hls is missing (hls.light.min.js did not load): browsers without native HLS fall back to the progressive file or an error.';

		const tmpPlayers = [];
		for (let i = 0; i < pPackages.length; i++)
		{
			const tmpPackage = pPackages[i].Package;
			const tmpRungs = (tmpPackage.Renditions || []).map((pRung) => pRung.Name).join(' / ');
			tmpPlayers.push(
			{
				Identifier: 'HLSPlayer' + i,
				Kind: 'standalone',
				PackageIndex: i,
				Label: pPackages[i].Name,
				Note: tmpPackage.Width + 'x' + tmpPackage.Height + ' · ' + (tmpPackage.DurationMS / 1000) + ' s · ' + tmpRungs
					+ ' · standalone pict-section-video, Preload none, downloads off · ' + pPackages[i].Base,
				Shape: (tmpPackage.Height > tmpPackage.Width) ? 'portrait' : 'landscape'
			});
		}

		// The fileview cell plays the first landscape package (else the first package) with downloads on, so the
		// toolbar's download link (download.mp4) and its fullscreen delegation to the video child can be exercised.
		let tmpFileviewIndex = pPackages.findIndex((pEntry) => pEntry.Package.Width >= pEntry.Package.Height);
		if (tmpFileviewIndex < 0) { tmpFileviewIndex = 0; }
		tmpPlayers.push(
		{
			Identifier: FILEVIEW_IDENTIFIER,
			Kind: 'fileview',
			PackageIndex: tmpFileviewIndex,
			Label: pPackages[tmpFileviewIndex].Name + ' in pict-section-fileview',
			Note: 'descriptorFromMediaPackage(..., { AllowDownload: true }) → fileview VideoRenderer → pict-section-video. '
				+ 'The toolbar fullscreen button takes the viewer root really fullscreen (toolbar included); on an iPhone, which has no '
				+ 'element fullscreen, it hands off to the video child\'s native player. The toolbar download is download.mp4.',
			Shape: 'fileview'
		});
		tmpState.Players = tmpPlayers;
		tmpPlayers.forEach((pPlayer) => { tmpState.Status[pPlayer.Identifier] = statusFromState(null); });

		// Paint the cells (the mount + status divs) before anything mounts into them.
		this.pict.views['VideoHLS-Layout'].render();

		for (let i = 0; i < tmpPlayers.length; i++)
		{
			const tmpPlayer = tmpPlayers[i];
			const tmpEntry = pPackages[tmpPlayer.PackageIndex];
			if (tmpPlayer.Kind === 'fileview')
			{
				this.mountFileview(tmpPlayer, tmpEntry);
			}
			else
			{
				this.mountStandalone(tmpPlayer, tmpEntry);
			}
		}

		this.startStatusPolling();
	}

	/**
	 * A standalone pict-section-video fed through setSource with the Stream built by the fileview's
	 * descriptorFromMediaPackage (downloads off: the descriptor's DownloadURL is null, so no download anywhere).
	 */
	mountStandalone(pPlayer, pEntry)
	{
		const tmpDescriptor = libFileview.descriptorFromMediaPackage(pEntry.Package, pEntry.Base, { Title: pEntry.Name });
		this.pict.addView(pPlayer.Identifier, buildPlayerConfiguration(pPlayer.Identifier), libPictSectionVideo);
		const tmpView = this.pict.views[pPlayer.Identifier];
		if (!tmpView.initializeTimestamp) { tmpView.initialize(); }
		// Set the source first: the first render builds the player and loads it (the manifest only; Preload 'none'
		// and hls.js autoStartLoad:false hold every fragment until play).
		tmpView.setSource(
		{
			URL: tmpDescriptor.URL,
			Stream: tmpDescriptor.Meta.Stream,
			PosterURL: tmpDescriptor.Meta.poster,
			Title: tmpDescriptor.Name,
			Name: tmpDescriptor.Name,
			DownloadURL: tmpDescriptor.DownloadURL,
			Duration: tmpDescriptor.Meta.duration
		});
		tmpView.render();
	}

	/**
	 * One pict-section-fileview instance showing a package (downloads on), with pict-section-video as its video lens
	 * and the page's hls.js handed over explicitly.
	 */
	mountFileview(pPlayer, pEntry)
	{
		const tmpDescriptor = libFileview.descriptorFromMediaPackage(pEntry.Package, pEntry.Base, { Title: pEntry.Name, AllowDownload: true });
		libFileview.createFileview(this.pict,
		{
			Identifier: pPlayer.Identifier,
			DestinationAddress: '#' + pPlayer.Identifier + '-Mount',
			VideoSectionClass: libPictSectionVideo,
			HlsLibrary: ((typeof window !== 'undefined') && window.Hls) ? window.Hls : null,
			File: tmpDescriptor
		});
		const tmpView = this.pict.views[pPlayer.Identifier];
		if (tmpView)
		{
			if (!tmpView.initializeTimestamp && (typeof tmpView.initialize === 'function')) { tmpView.initialize(); }
			tmpView.render();
		}
	}

	/** Poll every player's getState() into AppData and re-render its status line. */
	startStatusPolling()
	{
		if (this._statusTimer || (typeof window === 'undefined')) { return; }
		this._statusTimer = window.setInterval(() => { this.refreshStatus(); }, STATUS_POLL_MS);
		this.refreshStatus();
	}

	refreshStatus()
	{
		const tmpState = this.pict.AppData.VideoHLS;
		const tmpStatusView = this.pict.views['VideoHLS-Status'];
		for (let i = 0; i < tmpState.Players.length; i++)
		{
			const tmpPlayer = tmpState.Players[i];
			let tmpVideo = null;
			const tmpExtras = [];
			if (tmpPlayer.Kind === 'fileview')
			{
				const tmpFileview = this.pict.views[tmpPlayer.Identifier];
				tmpVideo = (tmpFileview && (typeof tmpFileview.getMountedChild === 'function')) ? tmpFileview.getMountedChild() : null;
				const tmpProvider = this.pict.providers[tmpPlayer.Identifier];
				if (tmpProvider && (typeof tmpProvider.isFullscreen === 'function') && tmpProvider.isFullscreen())
				{
					tmpExtras.push({ Text: 'fileview fullscreen' });
				}
			}
			else
			{
				tmpVideo = this.pict.views[tmpPlayer.Identifier];
			}
			const tmpVideoState = (tmpVideo && (typeof tmpVideo.getState === 'function')) ? tmpVideo.getState() : null;
			tmpState.Status[tmpPlayer.Identifier] = statusFromState(tmpVideoState, tmpExtras);
			tmpStatusView.renderStatus(tmpPlayer.Identifier);
		}
	}
}

module.exports = VideoHLSExampleApplication;

module.exports.default_configuration =
{
	"Name": "Video HLS Example",
	"Hash": "VideoHLSExample",
	"pict_configuration":
	{
		"Product": "VideoHLS-Example"
	}
};
