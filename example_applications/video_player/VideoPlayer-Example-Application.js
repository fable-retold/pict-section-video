const libPictApplication = require('pict-application');

// The standalone video section — used here directly (no pict-section-fileview), with its own control bar. This is
// the same class fileview mounts as its video lens; on its own it is a complete player.
const libPictSectionVideo = require('../../source/Pict-Section-Video.js');

// Each player: a distinct ViewIdentifier + the div it builds into + the video it opens. The default configuration
// points every element id at #VideoPlayer-Container-Div, so each instance overrides the renderable/destination/
// target to its own div — that is what lets two players coexist on one page (ids derive from the instance).
function buildPlayerConfig(pIdentifier, pDestination, pVideoURL, pTitle, pPosterURL)
{
	return Object.assign({}, libPictSectionVideo.default_configuration,
	{
		"ViewIdentifier": pIdentifier,
		"RenderOnLoad": false,
		"DefaultRenderable": pIdentifier + '-Wrap',
		"DefaultDestinationAddress": pDestination,
		"TargetElementAddress": pDestination,
		"Templates": [ { "Hash": pIdentifier + '-Container', "Template": '<!-- video player host -->' } ],
		"Renderables": [ { "RenderableHash": pIdentifier + '-Wrap', "TemplateHash": pIdentifier + '-Container', "DestinationAddress": pDestination, "RenderMethod": 'replace' } ],
		"VideoURL": pVideoURL,
		"PosterURL": pPosterURL || false,
		"Title": pTitle,
		"DownloadName": pVideoURL.split('/').pop()
	});
}

const _Players =
[
	{ Identifier: 'VidPoster', Destination: '#Vid-Poster', URL: './sample.mp4', Title: 'Sample clip (with poster)', Poster: './poster.jpg' },
	{ Identifier: 'VidBare',   Destination: '#Vid-Bare',   URL: './sample.mp4', Title: 'Sample clip (no poster)',   Poster: false }
];

class VideoPlayerExampleApplication extends libPictApplication
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		for (let i = 0; i < _Players.length; i++)
		{
			const tmpPlayer = _Players[i];
			this.pict.addView(tmpPlayer.Identifier,
				buildPlayerConfig(tmpPlayer.Identifier, tmpPlayer.Destination, tmpPlayer.URL, tmpPlayer.Title, tmpPlayer.Poster),
				libPictSectionVideo);
		}
	}

	onAfterInitialize()
	{
		super.onAfterInitialize();

		for (let i = 0; i < _Players.length; i++)
		{
			const tmpView = this.pict.views[_Players[i].Identifier];
			if (tmpView) { tmpView.render(); }
		}
	}
}

module.exports = VideoPlayerExampleApplication;

module.exports.default_configuration =
{
	"Name": "Video Player Example",
	"Hash": "VideoPlayerExample",
	"pict_configuration":
	{
		"Product": "VideoPlayer-Example"
	}
};
