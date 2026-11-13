#!/usr/bin/env node
/**
* VideoHLS-Example-Server -- `npm start` (after the build) or `npm run serve`.
*
* The example's Node host. quackage's static example server reads whole files with no Range support and serves
* playlists as application/octet-stream, so an adaptive demo cannot run there (design §6 fix 10). This host is a
* minimal Orator (restify) app instead:
*
*   GET  /media/info         [{ Name, Base: '/media/<pv>', Package: <package.json> }] for every known package
*   GET  /media/:pv/*        the package's files through orator-file-service addPackageRoute (HEAD too): Range/206,
*                            playlist vs media caching, dot-segment refusal, traversal confinement, OnServed ranges
*   GET  /*                  the built example (./dist) as static files
*
* restify's gzipResponse is installed GLOBALLY on purpose, exactly as Exordium mounts compression: the static bundle
* and /media/info go out gzipped, while every package response must come back un-encoded with an exact
* Content-Length (orator-file-service's gzip bypass) or Range playback and keep-alive break.
*
* The packages are the ones `npm run make-media` listed in media/catalog.json (the "known package list"); a request
* for any other PackageVersion, a malformed one, a package's own package.json, or any file the package's Files list
* does not name (exact spelling) answers 404.
*
* Environment:
*   PORT   listen port (default 9440)
*   HOST   listen address (default 127.0.0.1; HOST=0.0.0.0 to try it from a phone on the LAN)
*
* fable, orator and orator-serviceserver-restify come from the umbrella retold/node_modules; orator-file-service is
* the LOCAL monorepo source (modules/orator/orator-file-service), so this example always exercises the checkout.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libPath = require('node:path');
const libFS = require('node:fs');

// retold/modules/pict/pict-section-video/example_applications/video_hls -> retold
const UMBRELLA_ROOT = libPath.resolve(__dirname, '..', '..', '..', '..', '..');

/**
 * Require a package from the umbrella node_modules (falling back to ordinary resolution from here).
 *
 * @param {string} pName - the package name
 * @return {any}
 */
const requireFromUmbrella = (pName) =>
{
	let tmpPath = null;
	try
	{
		tmpPath = require.resolve(pName, { paths: [ UMBRELLA_ROOT ] });
	}
	catch (pError)
	{
		tmpPath = require.resolve(pName);
	}
	return require(tmpPath);
};

const libFable = requireFromUmbrella('fable');
const libOrator = requireFromUmbrella('orator');
const libOratorServiceServerRestify = requireFromUmbrella('orator-serviceserver-restify');
// restify is orator-serviceserver-restify's dependency: resolve it from there so the gzip plugin is the same copy.
const libRestify = require(require.resolve('restify', { paths: [ libPath.dirname(require.resolve('orator-serviceserver-restify', { paths: [ UMBRELLA_ROOT ] })) ] }));

const libOratorFileService = require('../../../../orator/orator-file-service/source/Orator-File-Service.js');

const DEFAULT_PORT = 9440;
const DEFAULT_HOST = '127.0.0.1';
const DIST_DIRECTORY = libPath.join(__dirname, 'dist');
const MEDIA_DIRECTORY = libPath.join(__dirname, 'media');
const PACKAGE_DIRECTORY = libPath.join(MEDIA_DIRECTORY, 'packages');
const CATALOG_FILE = libPath.join(MEDIA_DIRECTORY, 'catalog.json');
const PACKAGE_VERSION_PATTERN = /^[0-9a-f]{8}$/;
const MEDIA_ROUTE_PREFIX = '/media/';

/**
 * Read one package's package.json, or null when it is missing, unreadable or not a Version 1 package.
 *
 * @param {string} pPackageVersion
 * @return {Object|null}
 */
const readPackage = (pPackageVersion) =>
{
	try
	{
		let tmpPackage = JSON.parse(libFS.readFileSync(libPath.join(PACKAGE_DIRECTORY, pPackageVersion, 'package.json'), 'utf8'));
		if (!tmpPackage || (tmpPackage.Version !== 1) || (tmpPackage.PackageVersion !== pPackageVersion))
		{
			return null;
		}
		return tmpPackage;
	}
	catch (pError)
	{
		return null;
	}
};

/**
 * A display name for a package the catalog does not name (the package itself carries none, by design).
 *
 * @param {Object} pPackage
 * @return {string}
 */
const describePackage = (pPackage) =>
{
	let tmpOrientation = (pPackage.Height > pPackage.Width) ? 'Portrait' : 'Landscape';
	return `${tmpOrientation} ${pPackage.Width}x${pPackage.Height}`;
};

/**
 * The known package list: media/catalog.json's entries (in its order) whose package is on disk. Without a catalog,
 * every finished <pv>/ directory under media/packages (an encoder's .partial work area never matches the pattern).
 *
 * @return {Array<{ Name: string, PackageVersion: string, Package: Object }>}
 */
const loadKnownPackages = () =>
{
	let tmpEntries = [];
	let tmpCatalog = null;
	try
	{
		tmpCatalog = JSON.parse(libFS.readFileSync(CATALOG_FILE, 'utf8'));
	}
	catch (pError)
	{
		tmpCatalog = null;
	}

	if (Array.isArray(tmpCatalog))
	{
		tmpEntries = tmpCatalog
			.filter((pEntry) => pEntry && PACKAGE_VERSION_PATTERN.test(pEntry.PackageVersion || ''))
			.map((pEntry) => ({ Name: pEntry.Name, PackageVersion: pEntry.PackageVersion }));
	}
	else
	{
		let tmpDirectories = [];
		try
		{
			tmpDirectories = libFS.readdirSync(PACKAGE_DIRECTORY).filter((pName) => PACKAGE_VERSION_PATTERN.test(pName)).sort();
		}
		catch (pError)
		{
			tmpDirectories = [];
		}
		tmpEntries = tmpDirectories.map((pName) => ({ Name: '', PackageVersion: pName }));
	}

	let tmpKnown = [];
	let tmpSeen = {};
	for (let i = 0; i < tmpEntries.length; i++)
	{
		let tmpEntry = tmpEntries[i];
		if (tmpSeen[tmpEntry.PackageVersion])
		{
			continue;
		}
		let tmpPackage = readPackage(tmpEntry.PackageVersion);
		if (!tmpPackage)
		{
			continue;
		}
		tmpSeen[tmpEntry.PackageVersion] = true;
		let tmpFiles = Object.create(null);
		(Array.isArray(tmpPackage.Files) ? tmpPackage.Files : []).forEach((pFile) =>
		{
			if (pFile && (typeof pFile.Path === 'string') && (pFile.Path !== 'package.json'))
			{
				tmpFiles[pFile.Path] = true;
			}
		});
		tmpKnown.push({ Name: tmpEntry.Name || describePackage(tmpPackage), PackageVersion: tmpEntry.PackageVersion, Package: tmpPackage, Files: tmpFiles });
	}
	return tmpKnown;
};

/**
 * Build (but do not start) the example server.
 *
 * @param {Object} [pOptions] - { Port, Host, LogLevel }
 * @param {function} fCallback - fCallback(pError, { Fable, Orator, FileService, listen(fDone), close(fDone) })
 */
const createServer = (pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	let tmpPort = tmpOptions.Port || DEFAULT_PORT;
	let tmpHost = tmpOptions.Host || DEFAULT_HOST;

	let tmpFable = new libFable(
		{
			Product: 'VideoHLS-Example',
			ProductVersion: '1.0.0',
			APIServerPort: tmpPort,
			LogStreams: [ { loggertype: 'console', streamtype: 'console', level: tmpOptions.LogLevel || 'info' } ]
		});
	tmpFable.serviceManager.addServiceType('OratorServiceServer', libOratorServiceServerRestify);
	tmpFable.serviceManager.instantiateServiceProvider('OratorServiceServer');
	tmpFable.serviceManager.addServiceType('Orator', libOrator);
	let tmpOrator = tmpFable.serviceManager.instantiateServiceProvider('Orator');

	// The known packages, refreshed on every /media/info so `npm run make-media` can run while the server is up.
	let tmpKnown = loadKnownPackages();
	let tmpKnownByVersion = {};
	let fRefreshKnown = () =>
	{
		tmpKnown = loadKnownPackages();
		tmpKnownByVersion = {};
		tmpKnown.forEach((pEntry) => { tmpKnownByVersion[pEntry.PackageVersion] = pEntry; });
		return tmpKnown;
	};
	fRefreshKnown();

	tmpOrator.initialize(
		(pInitializeError) =>
		{
			if (pInitializeError)
			{
				return fCallback(pInitializeError);
			}
			let tmpServiceServer = tmpOrator.serviceServer;

			// Global compression, as Exordium's _mountCompression installs it. orator-file-service must bypass it.
			tmpServiceServer.server.use(libRestify.plugins.gzipResponse());

			// GET /media/info -- the package list the client builds its players from.
			tmpServiceServer.get('/media/info',
				(pRequest, pResponse, fNext) =>
				{
					let tmpBody = fRefreshKnown().map((pEntry) =>
						({
							Name: pEntry.Name,
							Base: MEDIA_ROUTE_PREFIX + pEntry.PackageVersion,
							Package: pEntry.Package
						}));
					pResponse.setHeader('Cache-Control', 'no-store');
					pResponse.send(tmpBody);
					return fNext();
				});

			// GET|HEAD /media/:pv/* -- the package bytes.
			let tmpFileService = new libOratorFileService(tmpFable, {}, 'OratorFileService');
			let tmpRegistered = tmpFileService.addPackageRoute(
				{
					Route: MEDIA_ROUTE_PREFIX + ':pv/*',
					Resolver: (pRequest, fResolve) =>
					{
						let tmpPackageVersion = (pRequest.params || {}).pv;
						if ((typeof tmpPackageVersion !== 'string') || !PACKAGE_VERSION_PATTERN.test(tmpPackageVersion))
						{
							return fResolve(null, { Allowed: false, Status: 404 });
						}
						let tmpEntry = tmpKnownByVersion[tmpPackageVersion];
						if (!tmpEntry)
						{
							return fResolve(null, { Allowed: false, Status: 404 });
						}
						// Only the files the package lists are served, spelled exactly as listed. Its Files list leaves out
						// package.json (the document goes out through /media/info, never as a package file), and an exact
						// match also refuses a case variant (PACKAGE.JSON) a case-insensitive filesystem would resolve.
						let tmpSubPath = (pRequest.params || {})['*'];
						if ((tmpSubPath === 'package.json') || !tmpEntry.Files[tmpSubPath])
						{
							return fResolve(null, { Allowed: false, Status: 404 });
						}
						return fResolve(null, { Allowed: true, PackageDirectory: libPath.join(PACKAGE_DIRECTORY, tmpPackageVersion) });
					},
					OnServed: (pRequest, pResolution, pServed) =>
					{
						tmpFable.log.info(`[served] ${pRequest.params.pv}/${pServed.SubPath} ${pServed.Status} bytes ${pServed.Start}-${pServed.End}/${pServed.Size} (${pServed.Bytes} B)`);
					}
				});
			if (!tmpRegistered)
			{
				return fCallback(new Error('orator-file-service refused the package route.'));
			}

			// GET /* -- the built example. Registered last; restify matches the more specific /media routes first.
			tmpOrator.addStaticRoute(DIST_DIRECTORY + '/', 'index.html', '/*', '/');

			return fCallback(null,
				{
					Fable: tmpFable,
					Orator: tmpOrator,
					FileService: tmpFileService,
					Port: tmpPort,
					Host: tmpHost,
					listen: (fDone) =>
					{
						// Listen directly so a host can be given (Orator's startService only takes a port).
						tmpServiceServer.server.listen(tmpPort, tmpHost,
							(pListenError) =>
							{
								if (!pListenError)
								{
									tmpServiceServer.Active = true;
									tmpServiceServer.Port = tmpPort;
								}
								return fDone(pListenError);
							});
					},
					close: (fDone) =>
					{
						tmpServiceServer.server.close(() => fDone());
					}
				});
		});
};

if (require.main === module)
{
	let tmpPort = DEFAULT_PORT;
	if (process.env.PORT)
	{
		tmpPort = Number(process.env.PORT);
		if (!Number.isInteger(tmpPort) || (tmpPort < 1) || (tmpPort > 65535))
		{
			console.error(`PORT must be an integer port number (got [${process.env.PORT}]).`);
			process.exit(2);
		}
	}
	let tmpHost = process.env.HOST || DEFAULT_HOST;

	if (!libFS.existsSync(libPath.join(DIST_DIRECTORY, 'index.html')))
	{
		console.warn('dist/index.html is missing: run `npm run build` (npm start does it for you).');
	}

	createServer({ Port: tmpPort, Host: tmpHost },
		(pError, pServer) =>
		{
			if (pError)
			{
				console.error(`VideoHLS example server failed to start: ${pError.message}`);
				process.exit(1);
			}
			pServer.listen(
				(pListenError) =>
				{
					if (pListenError)
					{
						console.error(`VideoHLS example server could not listen on ${tmpHost}:${tmpPort}: ${pListenError.message}`);
						process.exit(1);
					}
					let tmpKnown = loadKnownPackages();
					console.log(`\nVideo HLS example: http://${(tmpHost === '0.0.0.0') ? '127.0.0.1' : tmpHost}:${tmpPort}/`);
					if (tmpKnown.length < 1)
					{
						console.log('  No media packages yet -- run `npm run make-media` (the page picks them up on reload).');
					}
					tmpKnown.forEach((pEntry) =>
					{
						console.log(`  ${pEntry.Name}: ${MEDIA_ROUTE_PREFIX}${pEntry.PackageVersion}/master.m3u8 (${pEntry.Package.Renditions.map((pRung) => pRung.Name).join(', ')})`);
					});
					console.log('');
				});

			let fShutdown = () =>
			{
				pServer.close(() => process.exit(0));
				setTimeout(() => process.exit(0), 2000).unref();
			};
			process.on('SIGINT', fShutdown);
			process.on('SIGTERM', fShutdown);
		});
}

module.exports = { createServer, loadKnownPackages, PACKAGE_VERSION_PATTERN };
