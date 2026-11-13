#!/usr/bin/env node
/**
* VideoHLS-Make-Media -- `npm run make-media`
*
* Builds the example's media from nothing, so the demo never ships (or commits) a video file:
*
*   1. synthesize two source clips with ffmpeg's lavfi generators (testsrc2 picture + a sine tone), each carrying a
*      burned-in label, frame counter and timestamp so a rung switch or a seek is visible on screen:
*        - landscape: 1920x1080, 30 fps, 40 s
*        - portrait:  1080x1920, 30 fps, 20 s
*   2. encode each one into an adaptive-bitrate HLS package with the retold-media-ladder CLI
*      (media/packages/<PackageVersion>/{package.json, master.m3u8, v<i>/..., poster.jpg, download.mp4})
*   3. write media/catalog.json -- [{ Name, PackageVersion }] -- which the example server reads to know which
*      packages exist and what to call them (a package carries no source name by design).
*
* Everything lands in ./media/ (gitignored). Sources already on disk are reused; the ladder reuses a finished package
* whose PackageVersion is unchanged, so a re-run is cheap.
*
* Usage:
*   node VideoHLS-Make-Media.js [--preset <x264 preset>] [--force]
*     --preset   x264 preset for the ladder encode (default veryfast: these are synthetic test cards)
*     --force    re-synthesize the sources and rebuild the packages
*
* Environment:
*   RETOLD_MEDIA_LADDER_FFMPEG   the ffmpeg binary (default: ffmpeg on PATH; the ladder honours it too)
*   RETOLD_MEDIA_LADDER_BIN      the media-ladder CLI (default: the monorepo checkout's bin/media-ladder.js)
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libPath = require('node:path');
const libFS = require('node:fs');
const libChildProcess = require('node:child_process');

const MEDIA_DIRECTORY = libPath.join(__dirname, 'media');
const SOURCE_DIRECTORY = libPath.join(MEDIA_DIRECTORY, 'sources');
const PACKAGE_DIRECTORY = libPath.join(MEDIA_DIRECTORY, 'packages');
const CATALOG_FILE = libPath.join(MEDIA_DIRECTORY, 'catalog.json');

// The ladder lives beside this module in the monorepo: modules/utility/retold-media-ladder.
const LADDER_BIN = process.env.RETOLD_MEDIA_LADDER_BIN
	|| libPath.resolve(__dirname, '..', '..', '..', '..', 'utility', 'retold-media-ladder', 'bin', 'media-ladder.js');
const FFMPEG = process.env.RETOLD_MEDIA_LADDER_FFMPEG || 'ffmpeg';

const DEFAULT_PRESET = 'veryfast';

// Monospace fonts for the burned-in text, first one present wins. None found: drawtext falls back to fontconfig.
const FONT_CANDIDATES =
[
	'/System/Library/Fonts/Menlo.ttc',
	'/System/Library/Fonts/SFNSMono.ttf',
	'/System/Library/Fonts/Supplemental/Courier New.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
	'/usr/share/fonts/TTF/DejaVuSansMono.ttf',
	'/usr/share/fonts/dejavu/DejaVuSansMono.ttf'
];

const SOURCES =
[
	{
		Name: 'Landscape test card',
		File: 'landscape-1920x1080-30fps.mp4',
		Label: 'LANDSCAPE 1920x1080 30fps',
		Width: 1920,
		Height: 1080,
		FrameRate: 30,
		Seconds: 40,
		Tone: 440
	},
	{
		Name: 'Portrait test card',
		File: 'portrait-1080x1920-30fps.mp4',
		Label: 'PORTRAIT 1080x1920 30fps',
		Width: 1080,
		Height: 1920,
		FrameRate: 30,
		Seconds: 20,
		Tone: 660
	}
];

/**
 * Parse the command line.
 *
 * @param {Array<string>} pArguments - process.argv.slice(2)
 * @return {{ Preset: string, Force: boolean }}
 */
const parseArguments = (pArguments) =>
{
	let tmpOptions = { Preset: DEFAULT_PRESET, Force: false };
	for (let i = 0; i < pArguments.length; i++)
	{
		switch (pArguments[i])
		{
			case '--force':
				tmpOptions.Force = true;
				break;
			case '--preset':
				if (!pArguments[i + 1])
				{
					throw new Error('--preset needs a value (e.g. veryfast, medium).');
				}
				tmpOptions.Preset = pArguments[i + 1];
				i++;
				break;
			default:
				throw new Error(`Unknown argument [${pArguments[i]}]. Usage: node VideoHLS-Make-Media.js [--preset <p>] [--force]`);
		}
	}
	return tmpOptions;
};

/**
 * Quote a value for an ffmpeg filter option (single quotes; a literal quote cannot appear inside them).
 *
 * @param {string} pValue
 * @return {string}
 */
const quoteFilterValue = (pValue) =>
{
	return `'${String(pValue).replace(/'/g, '')}'`;
};

/**
 * The burned-in text chain: the source label at the top, a frame counter and a timestamp at the bottom. Sized from
 * the short side so the portrait clip's lines fit its 1080 px width.
 *
 * @param {Object} pSource - a SOURCES entry
 * @param {string|null} pFontFile - a font path, or null for fontconfig's default
 * @return {string}
 */
const buildTextFilter = (pSource, pFontFile) =>
{
	let tmpShortSide = Math.min(pSource.Width, pSource.Height);
	let tmpBig = Math.round(tmpShortSide / 12);
	let tmpSmall = Math.round(tmpShortSide / 20);
	let tmpFont = pFontFile ? `fontfile=${quoteFilterValue(pFontFile)}:` : '';
	let tmpBox = 'box=1:boxcolor=black@0.6';
	return [
		`drawtext=${tmpFont}text=${quoteFilterValue(pSource.Label)}:fontsize=${tmpSmall}:fontcolor=white:${tmpBox}:boxborderw=${Math.round(tmpSmall / 4)}:x=(w-text_w)/2:y=${tmpSmall}`,
		`drawtext=${tmpFont}text='frame %{n}':fontsize=${tmpBig}:fontcolor=yellow:${tmpBox}:boxborderw=${Math.round(tmpBig / 6)}:x=(w-text_w)/2:y=h-${tmpBig * 3}`,
		`drawtext=${tmpFont}text='%{pts\\:hms}':fontsize=${tmpBig}:fontcolor=yellow:${tmpBox}:boxborderw=${Math.round(tmpBig / 6)}:x=(w-text_w)/2:y=h-${Math.round(tmpBig * 1.6)}`
	].join(',');
};

/**
 * The ffmpeg arguments that synthesize one source clip. Metadata is dropped and the output is bit-exact, so a
 * re-synthesized clip hashes the same and the ladder's PackageVersion stays stable.
 *
 * @param {Object} pSource - a SOURCES entry
 * @param {string|false} pTextFilter - the drawtext chain, or false for the bare test pattern
 * @param {string} pOutputPath
 * @return {Array<string>}
 */
const buildSynthesisArguments = (pSource, pTextFilter, pOutputPath) =>
{
	let tmpArguments =
	[
		'-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', `testsrc2=size=${pSource.Width}x${pSource.Height}:rate=${pSource.FrameRate}:duration=${pSource.Seconds}`,
		'-f', 'lavfi', '-i', `sine=frequency=${pSource.Tone}:sample_rate=48000:duration=${pSource.Seconds}`
	];
	if (pTextFilter)
	{
		tmpArguments.push('-vf', pTextFilter);
	}
	tmpArguments.push(
		'-map', '0:v:0', '-map', '1:a:0',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', String(pSource.FrameRate * 2),
		'-c:a', 'aac', '-b:a', '160k', '-ac', '2',
		'-shortest',
		'-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
		'-movflags', '+faststart',
		pOutputPath);
	return tmpArguments;
};

/**
 * Run a child process to completion.
 *
 * @param {string} pCommand
 * @param {Array<string>} pArguments
 * @param {Object} pOptions - { CaptureStdout: boolean }
 * @param {function} fCallback - fCallback(pError, pStdout)
 */
const run = (pCommand, pArguments, pOptions, fCallback) =>
{
	let tmpStdout = '';
	let tmpStderr = '';
	let tmpCapture = !!(pOptions && pOptions.CaptureStdout);
	let tmpChild = libChildProcess.spawn(pCommand, pArguments, { stdio: [ 'ignore', 'pipe', tmpCapture ? 'inherit' : 'pipe' ] });
	tmpChild.stdout.on('data', (pChunk) => { tmpStdout += pChunk.toString(); });
	if (tmpChild.stderr)
	{
		tmpChild.stderr.on('data', (pChunk) => { tmpStderr += pChunk.toString(); });
	}
	tmpChild.on('error', (pError) =>
	{
		return fCallback(new Error(`Could not start [${pCommand}]: ${pError.message}`));
	});
	tmpChild.on('close', (pCode) =>
	{
		if (pCode !== 0)
		{
			return fCallback(new Error(`[${libPath.basename(pCommand)}] exited ${pCode}${tmpStderr ? ': ' + tmpStderr.trim().split('\n').slice(-4).join(' | ') : ''}`));
		}
		return fCallback(null, tmpStdout);
	});
};

/**
 * Synthesize one source clip (unless it is already on disk). Tries the labelled version first and, when this
 * ffmpeg's drawtext cannot render (no libfreetype / no font), falls back to the bare test pattern.
 *
 * @param {Object} pSource - a SOURCES entry
 * @param {boolean} pForce - re-synthesize even when the file exists
 * @param {function} fCallback - fCallback(pError, pSourcePath)
 */
const synthesizeSource = (pSource, pForce, fCallback) =>
{
	let tmpOutputPath = libPath.join(SOURCE_DIRECTORY, pSource.File);
	if (!pForce && libFS.existsSync(tmpOutputPath))
	{
		console.log(`[make-media] source exists: ${libPath.relative(__dirname, tmpOutputPath)}`);
		return fCallback(null, tmpOutputPath);
	}

	let tmpWorkingPath = tmpOutputPath + '.partial.mp4';
	let tmpFontFile = FONT_CANDIDATES.find((pCandidate) => libFS.existsSync(pCandidate)) || null;
	console.log(`[make-media] synthesizing ${pSource.Label}, ${pSource.Seconds} s -> ${libPath.relative(__dirname, tmpOutputPath)}`);

	let fFinish = (pError) =>
	{
		if (pError)
		{
			try { libFS.unlinkSync(tmpWorkingPath); }
			catch (pIgnore) { /* nothing to clean */ }
			return fCallback(pError);
		}
		libFS.renameSync(tmpWorkingPath, tmpOutputPath);
		return fCallback(null, tmpOutputPath);
	};

	run(FFMPEG, buildSynthesisArguments(pSource, buildTextFilter(pSource, tmpFontFile), tmpWorkingPath), {},
		(pError) =>
		{
			if (!pError)
			{
				return fFinish();
			}
			console.warn(`[make-media] burned-in text failed (${pError.message}); using the bare test pattern.`);
			return run(FFMPEG, buildSynthesisArguments(pSource, false, tmpWorkingPath), {}, fFinish);
		});
};

/**
 * Encode one source into an HLS package with the media-ladder CLI (progress streams to stderr).
 *
 * @param {string} pSourcePath
 * @param {Object} pOptions - { Preset, Force }
 * @param {function} fCallback - fCallback(pError, pPackageDocument)
 */
const encodeSource = (pSourcePath, pOptions, fCallback) =>
{
	let tmpArguments = [ LADDER_BIN, 'encode', pSourcePath, '--out', PACKAGE_DIRECTORY, '--preset', pOptions.Preset, '--json' ];
	if (pOptions.Force)
	{
		tmpArguments.push('--force');
	}
	console.log(`[make-media] encoding ${libPath.basename(pSourcePath)} with media-ladder (preset ${pOptions.Preset})`);
	run(process.execPath, tmpArguments, { CaptureStdout: true },
		(pError, pStdout) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpPackage = null;
			try
			{
				tmpPackage = JSON.parse(pStdout);
			}
			catch (pParseError)
			{
				return fCallback(new Error(`media-ladder did not print a package document: ${pParseError.message}`));
			}
			if (!tmpPackage || !/^[0-9a-f]{8}$/.test(tmpPackage.PackageVersion || ''))
			{
				return fCallback(new Error('media-ladder printed a package document without a valid PackageVersion.'));
			}
			return fCallback(null, tmpPackage);
		});
};

/**
 * Synthesize and encode every source in order, then write the catalog.
 *
 * @param {Object} pOptions - { Preset, Force }
 * @param {function} fCallback - fCallback(pError, pCatalog)
 */
const makeMedia = (pOptions, fCallback) =>
{
	if (!libFS.existsSync(LADDER_BIN))
	{
		return fCallback(new Error(`media-ladder CLI not found at [${LADDER_BIN}]; set RETOLD_MEDIA_LADDER_BIN.`));
	}
	libFS.mkdirSync(SOURCE_DIRECTORY, { recursive: true });
	libFS.mkdirSync(PACKAGE_DIRECTORY, { recursive: true });

	let tmpCatalog = [];
	let fNext = (pIndex) =>
	{
		if (pIndex >= SOURCES.length)
		{
			libFS.writeFileSync(CATALOG_FILE, JSON.stringify(tmpCatalog, null, '\t') + '\n');
			return fCallback(null, tmpCatalog);
		}
		let tmpSource = SOURCES[pIndex];
		synthesizeSource(tmpSource, pOptions.Force,
			(pSynthesisError, pSourcePath) =>
			{
				if (pSynthesisError)
				{
					return fCallback(pSynthesisError);
				}
				encodeSource(pSourcePath, pOptions,
					(pEncodeError, pPackage) =>
					{
						if (pEncodeError)
						{
							return fCallback(pEncodeError);
						}
						let tmpRungs = (pPackage.Renditions || []).map((pRung) => `${pRung.Name} ${pRung.Width}x${pRung.Height}`);
						console.log(`[make-media] ${tmpSource.Name}: package ${pPackage.PackageVersion} (${tmpRungs.join(', ')})`);
						tmpCatalog.push({ Name: tmpSource.Name, PackageVersion: pPackage.PackageVersion });
						return fNext(pIndex + 1);
					});
			});
	};
	return fNext(0);
};

if (require.main === module)
{
	let tmpOptions = null;
	try
	{
		tmpOptions = parseArguments(process.argv.slice(2));
	}
	catch (pError)
	{
		console.error(`[make-media] ${pError.message}`);
		process.exit(2);
	}
	makeMedia(tmpOptions,
		(pError, pCatalog) =>
		{
			if (pError)
			{
				console.error(`[make-media] FAILED: ${pError.message}`);
				process.exitCode = 1;
				return;
			}
			console.log(`[make-media] wrote ${libPath.relative(__dirname, CATALOG_FILE)} (${pCatalog.length} packages). Now: npm start (http://127.0.0.1:9440/)`);
		});
}

module.exports = { makeMedia, buildSynthesisArguments, buildTextFilter, SOURCES, MEDIA_DIRECTORY, PACKAGE_DIRECTORY, CATALOG_FILE };
