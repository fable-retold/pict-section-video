/**
 * Pict-Section-Video-Strategy — the pure playback-path resolver and quality-ladder helpers.
 *
 * Nothing in here touches the DOM, timers or storage: every function takes what it needs as arguments and returns
 * a value, so the whole decision table is unit-testable without a browser.
 *
 * The resolver picks one of four playback paths for a source:
 *
 *   'native-hls'  — an HLS source on a browser whose <video> plays HLS itself AND exposes ManagedMediaSource
 *                   (Safari: AirPlay, PiP, the lock screen and native fullscreen come free).
 *   'hls.js'      — an HLS source on a browser where the host-supplied hls.js reports support (Chrome, Firefox, Edge).
 *   'native-hls'  — an HLS source on a browser that plays HLS natively but has neither MMS nor hls.js
 *                   (iOS before 17.1).
 *   'progressive' — a plain file, or an HLS source that also carries a progressive (download.mp4) fallback.
 *   'unsupported' — an HLS source this browser cannot play by any path.
 *
 * The order follows the hls.js README advice: prefer hls.js over a `canPlayType` "maybe" (Chrome answers it but
 * "may fail to play certain assets"), and trust native HLS first only where `ManagedMediaSource` exists.
 */

const HLS_MIME = 'application/vnd.apple.mpegurl';

const STRATEGY_NATIVE_HLS = 'native-hls';
const STRATEGY_HLSJS = 'hls.js';
const STRATEGY_PROGRESSIVE = 'progressive';
const STRATEGY_UNSUPPORTED = 'unsupported';

// The hls.js configuration the player merges the host's HlsConfig over.
//   autoStartLoad:false      — the manifest loads on mount; level playlists + fragments only on the first play.
//   maxBufferLength 30/60    — the default byte-sized buffer reads minutes ahead at low rungs; keep it to ~30 s.
//   capLevelToPlayerSize     — a portrait phone never pulls the 1080p rung.
const HLS_DEFAULT_CONFIG = (
{
	autoStartLoad: false,
	maxBufferLength: 30,
	maxMaxBufferLength: 60,
	capLevelToPlayerSize: true
});

// HTTP statuses that mean "this link no longer grants access" (expired / revoked / bad capability).
const REVOKED_STATUSES = [ 401, 403, 404, 410 ];

// hls.js's EwmaBandWidthEstimator floors every throughput sample's duration at min(50 ms, bytes / 100000 ms): a
// transfer faster than that (an HTTP-cache hit, loopback) was not timed at all. See fragmentNetworkBandwidth.
const HLS_SAMPLE_FLOOR_MS = 50;
const HLS_SAMPLE_FLOOR_BYTES_PER_MS = 100000;
// How far a Resource Timing entry may sit outside hls.js's LoadStats window and still be that load's request.
const RESOURCE_TIMING_SLACK_MS = 2;

/** Is this source an HLS stream descriptor? */
function isHlsSource(pSource)
{
	return !!(pSource && pSource.Stream && (typeof pSource.Stream === 'object') && pSource.Stream.Type === 'hls');
}

/** Does the media element claim it can play this MIME? ('' and 'no' are false; 'maybe' / 'probably' are true.) */
function canPlayMIME(pVideoElement, pMIME)
{
	if (!pVideoElement || (typeof pVideoElement.canPlayType !== 'function')) { return false; }
	try
	{
		const tmpAnswer = pVideoElement.canPlayType(pMIME);
		return !!tmpAnswer && (tmpAnswer !== 'no');
	}
	catch (pError)
	{
		return false;
	}
}

/** Does the media element play HLS natively? */
function canPlayHls(pVideoElement)
{
	return canPlayMIME(pVideoElement, HLS_MIME);
}

/** Does the hls.js class (host-supplied) report MSE/MMS support here? */
function hlsLibrarySupported(pHls)
{
	if (!pHls || (typeof pHls.isSupported !== 'function')) { return false; }
	try { return !!pHls.isSupported(); }
	catch (pError) { return false; }
}

/** The URL to play for an HLS source: the manifest, else the descriptor URL. */
function manifestURL(pSource)
{
	if (!pSource) { return ''; }
	if (pSource.Stream && pSource.Stream.Manifest) { return pSource.Stream.Manifest; }
	return pSource.URL || '';
}

/** The URL to play progressively: Stream.ProgressiveURL, else the descriptor URL. */
function progressiveURL(pSource)
{
	if (!pSource) { return ''; }
	if (pSource.Stream && pSource.Stream.ProgressiveURL) { return pSource.Stream.ProgressiveURL; }
	return pSource.URL || '';
}

/**
 * Pick the playback path for a source.
 * @param {Object} pSource - { URL, Stream?: { Type, Manifest, Renditions, ProgressiveURL } }
 * @param {Object} pVideoElement - the <video> (for canPlayType)
 * @param {Function} pHls - the hls.js class, or null
 * @param {Object} pWindow - the window (for the ManagedMediaSource test), or null
 * @return {string} 'native-hls' | 'hls.js' | 'progressive' | 'unsupported'
 */
function resolveStrategy(pSource, pVideoElement, pHls, pWindow)
{
	const tmpIsHls = isHlsSource(pSource);
	const tmpNative = tmpIsHls && canPlayHls(pVideoElement);
	let tmpHasMMS = false;
	if (pWindow && ((typeof pWindow === 'object') || (typeof pWindow === 'function')))
	{
		try { tmpHasMMS = ('ManagedMediaSource' in pWindow); }
		catch (pError) { tmpHasMMS = false; }
	}

	if (tmpIsHls && tmpNative && tmpHasMMS) { return STRATEGY_NATIVE_HLS; }
	if (tmpIsHls && hlsLibrarySupported(pHls)) { return STRATEGY_HLSJS; }
	if (tmpIsHls && tmpNative) { return STRATEGY_NATIVE_HLS; }
	if ((tmpIsHls && pSource.Stream.ProgressiveURL) || !tmpIsHls) { return STRATEGY_PROGRESSIVE; }
	return STRATEGY_UNSUPPORTED;
}

// ---------------------------------------------------------------------------------------------------------------
// Quality ladder helpers
// ---------------------------------------------------------------------------------------------------------------

/** The short side of a frame (the rung's identity: '1080p' names the short side, portrait or landscape). */
function shortSide(pWidth, pHeight)
{
	const tmpWidth = Number(pWidth) || 0;
	const tmpHeight = Number(pHeight) || 0;
	if (tmpWidth > 0 && tmpHeight > 0) { return Math.min(tmpWidth, tmpHeight); }
	return tmpHeight || tmpWidth || 0;
}

/** A compact bandwidth label: 6234000 → '6 Mbps', 2200000 → '2.2 Mbps', 800000 → '800 kbps'. */
function formatBandwidth(pBitsPerSecond)
{
	const tmpBPS = Number(pBitsPerSecond);
	if (!isFinite(tmpBPS) || tmpBPS <= 0) { return ''; }
	const tmpKbps = Math.round(tmpBPS / 1000);
	if (tmpKbps < 1000) { return tmpKbps + ' kbps'; }
	if (tmpBPS >= 5000000) { return Math.round(tmpBPS / 1000000) + ' Mbps'; }
	return (Math.round(tmpBPS / 100000) / 10).toString() + ' Mbps';
}

/** The menu label for a rung: '1080p · 6 Mbps' (or '1080p' without a bandwidth). */
function levelLabel(pHeight, pBandwidth, pFallbackName)
{
	let tmpLabel = (pHeight > 0) ? (pHeight + 'p') : (pFallbackName || 'Level');
	const tmpBandwidth = formatBandwidth(pBandwidth);
	if (tmpBandwidth) { tmpLabel += ' · ' + tmpBandwidth; }
	return tmpLabel;
}

/** Sort quality levels highest first (short side, then bandwidth). */
function _sortHighestFirst(pLevels)
{
	return pLevels.sort(function (pA, pB)
	{
		if (pB.Height !== pA.Height) { return pB.Height - pA.Height; }
		return pB.Bandwidth - pA.Bandwidth;
	});
}

/**
 * Quality levels from an hls.js `levels` array: [{ Index, Height (short side), Width, PixelHeight, Bandwidth, Label }],
 * highest first. Index is the hls.js level index.
 */
function qualityLevelsFromHls(pHlsLevels)
{
	if (!Array.isArray(pHlsLevels)) { return []; }
	let tmpLevels = [];
	for (let i = 0; i < pHlsLevels.length; i++)
	{
		const tmpLevel = pHlsLevels[i];
		if (!tmpLevel) { continue; }
		const tmpWidth = Number(tmpLevel.width) || 0;
		const tmpPixelHeight = Number(tmpLevel.height) || 0;
		const tmpHeight = shortSide(tmpWidth, tmpPixelHeight);
		const tmpBandwidth = Number(tmpLevel.bitrate) || Number(tmpLevel.maxBitrate) || Number(tmpLevel.averageBitrate) || 0;
		tmpLevels.push(
		{
			Index: i,
			Height: tmpHeight,
			Width: tmpWidth,
			PixelHeight: tmpPixelHeight,
			Bandwidth: tmpBandwidth,
			Label: levelLabel(tmpHeight, tmpBandwidth, tmpLevel.name)
		});
	}
	return _sortHighestFirst(tmpLevels);
}

/**
 * Quality levels from a descriptor's Stream.Renditions (native HLS): same shape, highest first. Index is the
 * rendition's position in the Renditions array; Playlist rides along so the player can load that rung directly.
 */
function qualityLevelsFromRenditions(pRenditions)
{
	if (!Array.isArray(pRenditions)) { return []; }
	let tmpLevels = [];
	for (let i = 0; i < pRenditions.length; i++)
	{
		const tmpRendition = pRenditions[i];
		if (!tmpRendition || (typeof tmpRendition !== 'object')) { continue; }
		const tmpWidth = Number(tmpRendition.Width) || 0;
		const tmpPixelHeight = Number(tmpRendition.Height) || 0;
		const tmpHeight = Number(tmpRendition.ShortSide) || shortSide(tmpWidth, tmpPixelHeight);
		const tmpBandwidth = Number(tmpRendition.Bandwidth) || 0;
		tmpLevels.push(
		{
			Index: i,
			Height: tmpHeight,
			Width: tmpWidth,
			PixelHeight: tmpPixelHeight,
			Bandwidth: tmpBandwidth,
			Label: levelLabel(tmpHeight, tmpBandwidth, tmpRendition.Name),
			Playlist: tmpRendition.Playlist || ''
		});
	}
	return _sortHighestFirst(tmpLevels);
}

/** The level whose short side is closest at-or-below pMaxHeight (highest bandwidth wins a tie); else the lowest level. */
function _levelAtOrBelow(pLevels, pMaxHeight)
{
	if (!Array.isArray(pLevels) || !pLevels.length) { return null; }
	// pLevels is highest-first, so the first one at or below the ceiling is the best fit.
	for (let i = 0; i < pLevels.length; i++)
	{
		if (pLevels[i].Height <= pMaxHeight) { return pLevels[i]; }
	}
	return pLevels[pLevels.length - 1];
}

/** The level for an explicit short-side pick: an exact match, else the closest rung below it, else the lowest rung. */
function levelForHeight(pLevels, pHeight)
{
	return _levelAtOrBelow(pLevels, Number(pHeight) || 0);
}

/** The Data-saver level: the highest rung whose short side is <= pMaxHeight (else the lowest rung). */
function saverLevel(pLevels, pMaxHeight)
{
	const tmpMax = (Number(pMaxHeight) > 0) ? Number(pMaxHeight) : 540;
	return _levelAtOrBelow(pLevels, tmpMax);
}

/** Normalize a quality pick: 'auto' | 'saver' | a positive integer short side; null when invalid. */
function normalizeQuality(pQuality)
{
	if (pQuality === 'auto' || pQuality === 'saver') { return pQuality; }
	if (typeof pQuality === 'string' && /^\d+p?$/.test(pQuality.trim()))
	{
		pQuality = parseInt(pQuality, 10);
	}
	if (typeof pQuality === 'number' && isFinite(pQuality) && pQuality > 0)
	{
		return Math.round(pQuality);
	}
	return null;
}

/**
 * Build the hls.js config: the player defaults, then (when a bandwidth estimate was saved on an earlier visit)
 * { startLevel:-1, testBandwidth:false, abrEwmaDefaultEstimate:<saved> }, then the host's HlsConfig on top.
 * A first visit leaves startLevel unset, so hls.js starts on hls.firstLevel (the master's first variant, which the
 * ladder reorders to the ~540p rung).
 */
function buildHlsConfig(pHostConfig, pSavedEstimate)
{
	let tmpConfig = Object.assign({}, HLS_DEFAULT_CONFIG);
	const tmpEstimate = Number(pSavedEstimate);
	if (isFinite(tmpEstimate) && tmpEstimate > 0)
	{
		tmpConfig.startLevel = -1;
		tmpConfig.testBandwidth = false;
		tmpConfig.abrEwmaDefaultEstimate = tmpEstimate;
	}
	if (pHostConfig && (typeof pHostConfig === 'object'))
	{
		Object.assign(tmpConfig, pHostConfig);
	}
	return tmpConfig;
}

/**
 * The throughput (bits/s) one buffered main fragment measured over the network, or 0 when it measured nothing a
 * later visit could start from. hls.js samples every buffered main fragment into its bandwidth estimate, including
 * ones the browser served from its HTTP cache (media is served `immutable`) or over loopback; its estimator floors a
 * sample's duration at min(50 ms, bytes / 100000), so such a fragment reads as ~800 Mbps. Persisting that would start
 * every later visit on the top rung whatever the real connection. So a fragment counts only when:
 *   - it has load stats, was not aborted and loaded bytes (hls.js's LoadStats: frag.stats, or part.stats when the
 *     part loaded something);
 *   - its transfer (first byte → last byte, the span hls.js's own loader reports throughput over) took longer than
 *     that floor;
 *   - and, when Resource Timing has an entry for that request, the entry does not show an HTTP-cache hit
 *     (transferSize 0 with a non-empty body; a cross-origin entry without Timing-Allow-Origin reports every size as 0
 *     and proves nothing either way).
 * @param {Object} pData - the hls.js FRAG_BUFFERED payload ({ frag, part, stats })
 * @param {Object} [pPerformance] - window.performance (getEntriesByName), or null to skip the Resource Timing check
 * @returns {number} bits per second, or 0
 */
function fragmentNetworkBandwidth(pData, pPerformance)
{
	if (!pData || (typeof pData !== 'object')) { return 0; }
	const tmpFrag = pData.frag || null;
	const tmpPart = pData.part || null;
	let tmpStats = null;
	let tmpURL = '';
	if (tmpPart && tmpPart.stats && Number(tmpPart.stats.loaded) > 0)
	{
		tmpStats = tmpPart.stats;
		tmpURL = tmpPart.url || '';
	}
	else
	{
		tmpStats = pData.stats || (tmpFrag && tmpFrag.stats) || null;
		tmpURL = (tmpFrag && tmpFrag.url) || '';
	}
	if (!tmpStats || tmpStats.aborted || !tmpStats.loading) { return 0; }

	const tmpBytes = Number(tmpStats.loaded);
	const tmpStart = Number(tmpStats.loading.start);
	const tmpEnd = Number(tmpStats.loading.end);
	const tmpFirst = (Number(tmpStats.loading.first) > 0) ? Number(tmpStats.loading.first) : tmpStart;
	if (!(tmpBytes > 0) || !isFinite(tmpEnd) || !isFinite(tmpFirst)) { return 0; }

	const tmpTransferMS = tmpEnd - tmpFirst;
	const tmpFloorMS = Math.min(HLS_SAMPLE_FLOOR_MS, tmpBytes / HLS_SAMPLE_FLOOR_BYTES_PER_MS);
	if (!(tmpTransferMS > tmpFloorMS)) { return 0; }

	if (tmpURL && servedFromHttpCache(pPerformance, tmpURL, tmpStart, tmpEnd)) { return 0; }

	return Math.round((tmpBytes * 8 * 1000) / tmpTransferMS);
}

/**
 * Does Resource Timing say the request for pURL that ran between pStart and pEnd (performance.now() times, the clock
 * hls.js stamps its LoadStats with) was answered from the HTTP cache? A byte-ranged rendition shares one URL across
 * every fragment, so only an entry inside this load's window counts. False when there is no such entry or the API is
 * missing or throws.
 */
function servedFromHttpCache(pPerformance, pURL, pStart, pEnd)
{
	if (!pPerformance || (typeof pPerformance.getEntriesByName !== 'function')) { return false; }
	let tmpEntries = null;
	try
	{
		tmpEntries = pPerformance.getEntriesByName(pURL, 'resource');
	}
	catch (pError)
	{
		return false;
	}
	if (!tmpEntries || (typeof tmpEntries.length !== 'number')) { return false; }
	for (let i = tmpEntries.length - 1; i > -1; i--)
	{
		const tmpEntry = tmpEntries[i];
		if (!tmpEntry) { continue; }
		const tmpEntryStart = Number(tmpEntry.startTime);
		const tmpEntryEnd = Number(tmpEntry.responseEnd);
		if (!(tmpEntryStart >= (pStart - RESOURCE_TIMING_SLACK_MS)) || !(tmpEntryEnd <= (pEnd + RESOURCE_TIMING_SLACK_MS))) { continue; }
		const tmpBody = Math.max(Number(tmpEntry.encodedBodySize) || 0, Number(tmpEntry.decodedBodySize) || 0);
		return (Number(tmpEntry.transferSize) === 0) && (tmpBody > 0);
	}
	return false;
}

/**
 * The bandwidth estimate worth persisting: hls.js's own (smoothed) estimate, but never above the fastest fragment
 * this session actually pulled over the network (fragmentNetworkBandwidth) — hls.js folds cache hits into its average,
 * and they can hold it far above the real connection for a while. 0 (persist nothing) when either is missing.
 * @param {number} pHlsEstimate - hls.bandwidthEstimate (bits/s)
 * @param {number} pNetworkPeak - the highest fragmentNetworkBandwidth seen this session (bits/s)
 * @returns {number} bits per second (rounded), or 0
 */
function persistableEstimate(pHlsEstimate, pNetworkPeak)
{
	const tmpEstimate = Number(pHlsEstimate);
	const tmpPeak = Number(pNetworkPeak);
	if (!isFinite(tmpEstimate) || !(tmpEstimate > 0) || !isFinite(tmpPeak) || !(tmpPeak > 0)) { return 0; }
	return Math.round(Math.min(tmpEstimate, tmpPeak));
}

/** Does this HTTP status mean the link has expired or been revoked? */
function isRevokedStatus(pStatus)
{
	return REVOKED_STATUSES.indexOf(Number(pStatus)) > -1;
}

/** The HTTP status carried by an hls.js error payload (response.code, else networkDetails.status), or 0. */
function hlsErrorStatus(pData)
{
	if (!pData || (typeof pData !== 'object')) { return 0; }
	if (pData.response && Number(pData.response.code)) { return Number(pData.response.code); }
	if (pData.networkDetails && Number(pData.networkDetails.status)) { return Number(pData.networkDetails.status); }
	return 0;
}

/** The end (seconds) of the buffered range containing pTime; 0 when none does. */
function bufferedEndAt(pBuffered, pTime)
{
	if (!pBuffered || (typeof pBuffered.length !== 'number')) { return 0; }
	const tmpTime = Number(pTime) || 0;
	for (let i = 0; i < pBuffered.length; i++)
	{
		let tmpStart = 0;
		let tmpEnd = 0;
		try
		{
			tmpStart = pBuffered.start(i);
			tmpEnd = pBuffered.end(i);
		}
		catch (pError)
		{
			continue;
		}
		// A small tolerance: currentTime can sit a hair before the first buffered sample after a seek.
		if (tmpTime >= (tmpStart - 0.25) && tmpTime <= tmpEnd)
		{
			return tmpEnd;
		}
	}
	return 0;
}

module.exports = (
{
	HLS_MIME: HLS_MIME,
	HLS_DEFAULT_CONFIG: HLS_DEFAULT_CONFIG,
	REVOKED_STATUSES: REVOKED_STATUSES,
	STRATEGY_NATIVE_HLS: STRATEGY_NATIVE_HLS,
	STRATEGY_HLSJS: STRATEGY_HLSJS,
	STRATEGY_PROGRESSIVE: STRATEGY_PROGRESSIVE,
	STRATEGY_UNSUPPORTED: STRATEGY_UNSUPPORTED,

	resolveStrategy: resolveStrategy,
	progressiveURL: progressiveURL,
	manifestURL: manifestURL,
	isHlsSource: isHlsSource,
	canPlayMIME: canPlayMIME,
	canPlayHls: canPlayHls,
	hlsLibrarySupported: hlsLibrarySupported,

	shortSide: shortSide,
	formatBandwidth: formatBandwidth,
	levelLabel: levelLabel,
	qualityLevelsFromHls: qualityLevelsFromHls,
	qualityLevelsFromRenditions: qualityLevelsFromRenditions,
	levelForHeight: levelForHeight,
	saverLevel: saverLevel,
	normalizeQuality: normalizeQuality,
	buildHlsConfig: buildHlsConfig,
	fragmentNetworkBandwidth: fragmentNetworkBandwidth,
	persistableEstimate: persistableEstimate,
	isRevokedStatus: isRevokedStatus,
	hlsErrorStatus: hlsErrorStatus,
	bufferedEndAt: bufferedEndAt
});
