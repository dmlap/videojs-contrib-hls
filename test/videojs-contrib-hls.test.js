import document from 'global/document';
import videojs from 'video.js';
import sinon from 'sinon';
import QUnit from 'qunit';
import testDataManifests from './test-manifests.js';
/* eslint-disable no-unused-vars */
// we need this so that it can register hls with videojs
import Hls from '../src/videojs-contrib-hls';
/* eslint-enable no-unused-vars */

const bcSegment = new Uint8Array(1);
const Flash = videojs.getComponent('Flash');
let nextId = 0;

// patch over some methods of the provided tech so it can be tested
// synchronously with sinon's fake timers
const mockTech = function(tech) {
  if (tech.isMocked_) {
    // make this function idempotent because HTML and Flash based
    // playback have very different lifecycles. For HTML, the tech
    // is available on player creation. For Flash, the tech isn't
    // ready until the source has been loaded and one tick has
    // expired.
    return;
  }

  tech.isMocked_ = true;

  tech.hls = tech.hls;
  tech.src_ = null;
  tech.time_ = null;
  tech.paused_ = !tech.autoplay();
  tech.paused = function() {
    return tech.paused_;
  };

  if (!tech.currentTime_) {
    tech.currentTime_ = tech.currentTime;
  }
  tech.currentTime = function() {
    return tech.time_ === null ? tech.currentTime_() : tech.time_;
  };

  tech.setSrc = function(src) {
    tech.src_ = src;
  };
  tech.src = function(src) {
    if (src !== null) {
      return tech.setSrc(src);
    }
    return tech.src_ === null ? tech.src : tech.src_;
  };
  tech.currentSrc_ = tech.currentSrc;
  tech.currentSrc = function() {
    return tech.src_ === null ? tech.currentSrc_() : tech.src_;
  };

  tech.play_ = tech.play;
  tech.play = function() {
    tech.play_();
    tech.paused_ = false;
    tech.trigger('play');
  };
  tech.pause_ = tech.pause_;
  tech.pause = function() {
    tech.pause_();
    tech.paused_ = true;
    tech.trigger('pause');
  };

  tech.setCurrentTime = function(time) {
    tech.time_ = time;

    setTimeout(function() {
      tech.trigger('seeking');
      setTimeout(function() {
        tech.trigger('seeked');
      }, 1);
    }, 1);
  };
};

const createPlayer = function(options) {
  let video;
  let player;

  video = document.createElement('video');
  video.className = 'video-js';
  document.querySelector('#qunit-fixture').appendChild(video);
  player = videojs(video, options || {
    flash: {
      swf: ''
    }
  });

  player.buffered = function() {
    return videojs.createTimeRange(0, 0);
  };
  mockTech(player.tech_);

  return player;
};

const openMediaSource = function(player, clock) {
  mockTech(player.tech_);

  // ensure the Flash tech is ready
  player.tech_.triggerReady();
  clock.tick(1);

  // simulate the sourceopen event
  player.tech_.hls.mediaSource.readyState = 'open';
  player.tech_.hls.mediaSource.dispatchEvent({
    type: 'sourceopen',
    swfId: player.tech_.el().id
  });
};

const standardXHRResponse = function(request) {
  if (!request.url) {
    return;
  }

  let contentType = 'application/json';
  // contents off the global object
  let manifestName = (/(?:.*\/)?(.*)\.m3u8/).exec(request.url);

  if (manifestName) {
    manifestName = manifestName[1];
  } else {
    manifestName = request.url;
  }

  if (/\.m3u8?/.test(request.url)) {
    contentType = 'application/vnd.apple.mpegurl';
  } else if (/\.ts/.test(request.url)) {
    contentType = 'video/MP2T';
  }

  request.response = new Uint8Array(16).buffer;
  request.respond(200, { 'Content-Type': contentType },
                  testDataManifests[manifestName]);
};

// do a shallow copy of the properties of source onto the target object
const merge = function(target, source) {
  let name;

  for (name in source) {
    target[name] = source[name];
  }
};

// return an absolute version of a page-relative URL
const absoluteUrl = function(relativeUrl) {
  return window.location.protocol + '//' +
    window.location.host +
    (window.location.pathname
        .split('/')
        .slice(0, -1)
        .concat(relativeUrl)
        .join('/')
    );
};
// a no-op MediaSource implementation to allow synchronous testing
const MockMediaSource = videojs.extend(videojs.EventTarget, {
  constructor() {},
  duration: NaN,
  seekable: videojs.createTimeRange(),
  addSeekableRange_(start, end) {
    this.seekable = videojs.createTimeRange(start, end);
  },
  addSourceBuffer() {
    return new (videojs.extend(videojs.EventTarget, {
      constructor() {},
      abort() {},
      buffered: videojs.createTimeRange(),
      appendBuffer() {},
      remove() {}
    }))();
  },
  // endOfStream triggers an exception if flash isn't available
  endOfStream(error) {
    this.error_ = error;
  },
  open() {}
});
const URL = {
  createObjectURL() {
    return 'blob:mock-vjs-object-url';
  }
};

QUnit.module('HLS -', {
  beforeEach() {
    // Mock the environment's timers because certain things - particularly
    // player readiness - are asynchronous in video.js 5.
    this.clock = sinon.useFakeTimers();

    // setup a player
    this.player = createPlayer();

    this.old = {};

    // mock out Flash features for phantomjs
    this.old.Flash = videojs.mergeOptions({}, Flash);
    /* eslint-disable camelcase */
    Flash.embed = function(swf, flashVars) {
      let el = document.createElement('div');

      el.id = 'vjs_mock_flash_' + nextId++;
      el.className = 'vjs-tech vjs-mock-flash';
      el.duration = Infinity;
      el.vjs_load = function() {};
      el.vjs_getProperty = function(attr) {
        if (attr === 'buffered') {
          return [[0, 0]];
        }
        return el[attr];
      };
      el.vjs_setProperty = function(attr, value) {
        el[attr] = value;
      };
      el.vjs_src = function() {};
      el.vjs_play = function() {};
      el.vjs_discontinuity = function() {};

      if (flashVars.autoplay) {
        el.autoplay = true;
      }
      if (flashVars.preload) {
        el.preload = flashVars.preload;
      }

      el.currentTime = 0;

      return el;
    };
    /* eslint-enable camelcase */
    this.old.FlashSupported = Flash.isSupported;
    Flash.isSupported = function() {
      return true;
    };

    // fake XHRs
    this.old.XHR = videojs.xhr.XMLHttpRequest;
    this.sinonXHR = sinon.useFakeXMLHttpRequest();
    this.requests = [];
    this.sinonXHR.onCreate = (xhr) => {
      // force the XHR2 timeout polyfill
      xhr.timeout = null;
      this.requests.push(xhr);
    };
    videojs.xhr.XMLHttpRequest = this.sinonXHR;

    // Fake sourcebuffer
    this.old.SourceBuffer = window.videojs.SourceBuffer;
    window.videojs.SourceBuffer = function() {
      this.appendBuffer = function() {};
      this.abort = function() {};
    };

    // store functionality that some tests need to mock
    this.old.GlobalOptions = videojs.mergeOptions(videojs.options);

    // force the HLS tech to run
    this.old.NativeHlsSupport = videojs.Hls.supportsNativeHls;
    videojs.Hls.supportsNativeHls = function() {
      return false;
    };

    this.old.Decrypt = videojs.Hls.Decrypter;
    videojs.Hls.Decrypter = function() {};

    // Mock Media Sources
    this.old.MediaSource = videojs.MediaSource;
    videojs.MediaSource = MockMediaSource;
    this.old.URL = videojs.URL;
    videojs.URL = URL;
  },

  afterEach() {
    // The clock _must_ be restored before disposing the player; otherwise,
    // certain timeout listeners that happen inside video.js may throw errors.
    this.clock.restore();
    this.player.dispose();

    this.sinonXHR.restore();
    videojs.xhr.XMLHttpRequest = this.old.XHR;
    videojs.MediaSource = this.old.MediaSource;
    videojs.URL = this.old.URL;

    merge(videojs.options, this.old.GlobalOptions);
    Flash.isSupported = this.old.FlashSupported;
    merge(Flash, this.old.Flash);

    videojs.Hls.supportsNativeHls = this.old.NativeHlsSupport;
    videojs.Hls.Decrypter = this.old.Decrypt;
    videojs.SourceBuffer = this.old.SourceBuffer;
  }
});

QUnit.test('starts playing if autoplay is specified', function() {
  let plays = 0;

  this.player.autoplay(true);
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  // REMOVEME workaround https://github.com/videojs/video.js/issues/2326
  // this.player.tech_.triggerReady();
  // this.clock.tick(1);
  // make sure play() is called *after* the media source opens
  this.player.tech_.hls.play = function() {
    plays++;
  };
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);
  QUnit.strictEqual(1, plays, 'play was called');
});

QUnit.test('XHR requests first byte range on play', function() {
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  this.player.tech_.trigger('play');
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests[0]);
  QUnit.equal(this.requests[1].headers.Range, 'bytes=0-522827');
});

QUnit.test('Seeking requests correct byte range', function() {
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  this.player.tech_.trigger('play');
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests[0]);
  this.player.tech_.hls.sourceBuffer.trigger('updateend');
  this.clock.tick(1);
  this.player.currentTime(40);
  this.clock.tick(1);
  QUnit.equal(this.requests[2].headers.Range, 'bytes=2299992-2835603');
});

QUnit.test('if buffered, will request second segment byte range', function() {
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  this.player.tech_.trigger('play');
  openMediaSource(this.player, this.clock);
  this.player.tech_.buffered = function() {
    return videojs.createTimeRange(0, 20);
  };
  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  this.player.tech_.hls.sourceBuffer.trigger('updateend');
  this.player.tech_.hls.checkBuffer_();
  this.clock.tick(100);
  QUnit.equal(this.requests[2].headers.Range, 'bytes=1823412-2299991');
});

QUnit.test('autoplay seeks to the live point after playlist load', function() {
  let currentTime = 0;

  this.player.autoplay(true);
  this.player.on('seeking', () => {
    currentTime = this.player.currentTime();
  });
  this.player.src({
    src: 'liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.readyState = function() {
    return 1;
  };
  this.player.tech_.trigger('play');
  standardXHRResponse(this.requests.shift());
  this.clock.tick(1);

  QUnit.notEqual(currentTime, 0, 'seeked on autoplay');
});

QUnit.test('autoplay seeks to the live point after media source open', function() {
  let currentTime = 0;

  this.player.autoplay(true);
  this.player.on('seeking', () => {
    currentTime = this.player.currentTime();
  });
  this.player.src({
    src: 'liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  standardXHRResponse(this.requests.shift());
  openMediaSource(this.player, this.clock);
  this.player.tech_.readyState = function() {
    return 1;
  };
  this.player.tech_.trigger('play');
  this.clock.tick(1);

  QUnit.notEqual(currentTime, 0, 'seeked on autoplay');
});

QUnit.test('duration is set when the source opens after the playlist is loaded',
function() {
  this.player.src({
    src: 'media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  standardXHRResponse(this.requests.shift());
  openMediaSource(this.player, this.clock);

  QUnit.equal(this.player.tech_.hls.mediaSource.duration,
              40,
              'set the duration');
});

QUnit.test('calls `remove` based on seekable when loading a live segment', function() {
  let removes = [];
  let seekable = videojs.createTimeRanges([[60, 120]]);

  this.player.src({
    src: 'liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.seekable = function() {
    return seekable;
  };

  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.mediaSource.addSourceBuffer = function() {
    return new (videojs.extend(videojs.EventTarget, {
      constructor() {},
      abort() {},
      buffered: videojs.createTimeRange(),
      appendBuffer() {},
      remove(start, end) {
        removes.push([start, end]);
      }
    }))();
  };
  this.player.tech_.hls.segments.bandwidth = 20e10;
  this.player.tech_.triggerReady();
  standardXHRResponse(this.requests[0]);

  this.player.tech_.hls.playlists.trigger('loadedmetadata');
  this.player.tech_.trigger('canplay');
  this.player.tech_.paused = function() {
    return false;
  };
  this.player.tech_.readyState = function() {
    return 1;
  };
  this.player.tech_.trigger('play');

  this.clock.tick(1);
  standardXHRResponse(this.requests[1]);

  QUnit.strictEqual(this.requests[0].url,
                    'liveStart30sBefore.m3u8',
                    'master playlist requested');
  QUnit.equal(removes.length, 1, 'remove called');
  QUnit.deepEqual(removes[0],
                  [0, seekable.start(0)],
                  'remove called with the right range');
});

QUnit.test('calls `remove` based on currentTime when loading a live segment ' +
           'if seekable start is after currentTime', function() {
  let removes = [];
  let seekable = videojs.createTimeRanges([[0, 80]]);

  this.player.src({
    src: 'liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.seekable = function() {
    return seekable;
  };

  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.mediaSource.addSourceBuffer = function() {
    return new (videojs.extend(videojs.EventTarget, {
      constructor() {},
      abort() {},
      buffered: videojs.createTimeRange(),
      appendBuffer() {},
      remove(start, end) {
        removes.push([start, end]);
      }
    }))();
  };
  this.player.tech_.hls.segments.bandwidth = 20e10;
  this.player.tech_.triggerReady();
  standardXHRResponse(this.requests[0]);
  this.player.tech_.hls.playlists.trigger('loadedmetadata');
  this.player.tech_.trigger('canplay');

  this.player.tech_.paused = function() {
    return false;
  };

  this.player.tech_.readyState = function() {
    return 1;
  };

  this.player.tech_.trigger('play');
  this.clock.tick(1);
  // Change seekable so that it starts *after* the currentTime which was set
  // based on the previous seekable range (the end of 80)
  seekable = videojs.createTimeRanges([[100, 120]]);
  standardXHRResponse(this.requests[1]);

  QUnit.strictEqual(this.requests[0].url, 'liveStart30sBefore.m3u8', 'master playlist requested');
  QUnit.equal(removes.length, 1, 'remove called');
  QUnit.deepEqual(removes[0], [0, 80 - 60], 'remove called with the right range');
});

QUnit.test('calls `remove` on sourceBuffer to when loading a vod segment', function() {
  let removes = [];

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.mediaSource.addSourceBuffer = function() {
    return new (videojs.extend(videojs.EventTarget, {
      constructor() {},
      abort() {},
      buffered: videojs.createTimeRange(),
      appendBuffer() {},
      remove(start, end) {
        removes.push([start, end]);
      }
    }))();
  };
  this.player.tech_.hls.segments.bandwidth = 20e10;
  standardXHRResponse(this.requests[0]);
  this.player.currentTime(120);
  standardXHRResponse(this.requests[1]);
  standardXHRResponse(this.requests[2]);

  QUnit.strictEqual(this.requests[0].url,
                    'manifest/master.m3u8',
                    'master playlist requested');
  QUnit.strictEqual(absoluteUrl('manifest/media2.m3u8'),
                    this.requests[1].url,
                    'media playlist requested');
  QUnit.equal(removes.length, 1, 'remove called');
  QUnit.deepEqual(removes[0], [0, 120 - 60], 'remove called with the right range');
});

QUnit.test('codecs are passed to the source buffer', function() {
  let codecs = [];

  this.player.src({
    src: 'custom-codecs.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  let addSourceBuffer = this.player.tech_.hls.mediaSource.addSourceBuffer;

  this.player.tech_.hls.mediaSource.addSourceBuffer = function(codec) {
    codecs.push(codec);
    return addSourceBuffer.call(this, codec);
  };

  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:CODECS="video, audio"\n' +
                                'media.m3u8\n');
  standardXHRResponse(this.requests.shift());
  QUnit.equal(codecs.length, 1, 'created a source buffer');
  QUnit.equal(codecs[0], 'video/mp2t; codecs="video, audio"', 'specified the codecs');
});

QUnit.test('including HLS as a tech does not error', function() {
  let player = createPlayer({
    techOrder: ['hls', 'html5']
  });

  QUnit.ok(player, 'created the player');
});

// Warns: 'player.hls is deprecated. Use player.tech.hls instead.'
QUnit.test('creates a PlaylistLoader on init', function() {
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  QUnit.equal(this.requests[0].aborted, true, 'aborted previous src');
  standardXHRResponse(this.requests[1]);
  QUnit.ok(this.player.tech_.hls.playlists.master,
           'set the master playlist');
  QUnit.ok(this.player.tech_.hls.playlists.media(),
           'set the media playlist');
  QUnit.ok(this.player.tech_.hls.playlists.media().segments,
           'the segment entries are parsed');
  QUnit.strictEqual(this.player.tech_.hls.playlists.master.playlists[0],
                    this.player.tech_.hls.playlists.media(),
                    'the playlist is selected');
});

QUnit.test('creates a SegmentLoader on init', function() {
  player.src({
    src: 'manifest/playlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(player);
  equal(player.tech_.hls.segments.state, 'INIT', 'created a segment loader');
});

QUnit.test('re-initializes the playlist loader when switching sources', function() {
  // source is set
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  // loader gets media playlist
  standardXHRResponse(this.requests.shift());
  // request a segment
  standardXHRResponse(this.requests.shift());
  // change the source
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  // maybe not needed if https://github.com/videojs/video.js/issues/2326 gets fixed
  this.clock.tick(1);
  QUnit.ok(!this.player.tech_.hls.playlists.media(), 'no media playlist');
  QUnit.equal(this.player.tech_.hls.playlists.state,
              'HAVE_NOTHING',
              'reset the playlist loader state');
  QUnit.equal(this.requests.length, 1, 'requested the new src');

  // buffer check
  this.clock.tick(10 * 1000);
  QUnit.equal(this.requests.length, 1, 'did not request a stale segment');

  // sourceopen
  openMediaSource(this.player, this.clock);

  QUnit.equal(this.requests.length, 1, 'made one request');
  QUnit.ok(this.requests[0].url.indexOf('master.m3u8') >= 0,
           'requested only the new playlist');
});

QUnit.test('updates the segment loader on live playlist refreshes', function() {
  var updates = [], hls;
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  hls = player.tech_.hls;

  standardXHRResponse(this.requests.shift()); // master
  standardXHRResponse(this.requests.shift()); // media
  hls.segments.playlist = function(update) {
    updates.push(update);
  };

  hls.playlists.trigger('loadedplaylist');
  QUnit.equal(updates.length, 1, 'updated the segment list');
});

QUnit.test('sets the duration if one is available on the playlist', function() {
  let events = 0;
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.on('durationchange', function() {
    events++;
  });

  standardXHRResponse(this.requests[0]);
  QUnit.equal(this.player.tech_.hls.mediaSource.duration,
              40,
              'set the duration');
  QUnit.equal(events, 1, 'durationchange is fired');
});

QUnit.test('estimates individual segment durations if needed', function() {
  let changes = 0;

  this.player.src({
    src: 'http://example.com/manifest/missingExtinf.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.mediaSource.duration = NaN;
  this.player.tech_.on('durationchange', function() {
    changes++;
  });

  standardXHRResponse(this.requests[0]);
  QUnit.strictEqual(this.player.tech_.hls.mediaSource.duration,
                    this.player.tech_.hls.playlists.media().segments.length * 10,
                    'duration is updated');
  QUnit.strictEqual(changes, 1, 'one durationchange fired');
});

QUnit.test('translates seekable by the starting time for live playlists', function() {
  let seekable;

  this.player.src({
    src: 'media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-MEDIA-SEQUENCE:15\n' +
                                '#EXTINF:10,\n' +
                                '0.ts\n' +
                                '#EXTINF:10,\n' +
                                '1.ts\n' +
                                '#EXTINF:10,\n' +
                                '2.ts\n' +
                                '#EXTINF:10,\n' +
                                '3.ts\n');

  seekable = this.player.seekable();
  QUnit.equal(seekable.length, 1, 'one seekable range');
  QUnit.equal(seekable.start(0), 0, 'the earliest possible position is at zero');
  QUnit.equal(seekable.end(0), 10, 'end is relative to the start');
});

QUnit.test('starts downloading a segment on loadedmetadata', function() {
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.buffered = function() {
    return videojs.createTimeRange(0, 0);
  };
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  QUnit.strictEqual(this.requests[1].url,
                    absoluteUrl('manifest/media-00001.ts'),
                    'the first segment is requested');
});

QUnit.test('triggers an error when a master playlist request errors', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.pop().respond(500);

  QUnit.equal(this.player.tech_.hls.mediaSource.error_,
              'network',
              'a network error is triggered');
});

QUnit.test('finds the correct buffered region based on currentTime', function() {
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.buffered = function() {
    return videojs.createTimeRanges([[0, 5], [6, 12]]);
  };
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  this.player.currentTime(3);
  this.clock.tick(1);
  QUnit.equal(this.player.tech_.hls.findBufferedRange_().end(0),
              5,
              'inside the first buffered region');
  this.player.currentTime(6);
  this.clock.tick(1);
  QUnit.equal(this.player.tech_.hls.findBufferedRange_().end(0),
              12,
              'inside the second buffered region');
});

QUnit.test('re-initializes the handler for each source', function() {
  let firstPlaylists;
  let secondPlaylists;
  let firstMSE;
  let secondMSE;
  let aborts = 0;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  firstPlaylists = this.player.tech_.hls.playlists;
  firstMSE = this.player.tech_.hls.mediaSource;
  standardXHRResponse(this.requests.shift());
  standardXHRResponse(this.requests.shift());
  this.player.tech_.hls.sourceBuffer.abort = function() {
    aborts++;
  };

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  secondPlaylists = this.player.tech_.hls.playlists;
  secondMSE = this.player.tech_.hls.mediaSource;

  QUnit.equal(1, aborts, 'aborted the old source buffer');
  QUnit.ok(this.requests[0].aborted, 'aborted the old segment request');
  QUnit.notStrictEqual(firstPlaylists,
                       secondPlaylists,
                       'the playlist object is not reused');
  QUnit.notStrictEqual(firstMSE, secondMSE, 'the media source object is not reused');
});

QUnit.test('downloads media playlists after loading the master', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 20e10;
  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  standardXHRResponse(this.requests[2]);

  QUnit.strictEqual(this.requests[0].url,
                    'manifest/master.m3u8',
                    'master playlist requested');
  QUnit.strictEqual(this.requests[1].url,
                    absoluteUrl('manifest/media2.m3u8'),
                    'media playlist requested');
  QUnit.strictEqual(this.requests[2].url,
                    absoluteUrl('manifest/media2-00001.ts'),
                    'first segment requested');
});

QUnit.test('upshifts if the initial bandwidth hint is high', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 10e20;
  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  standardXHRResponse(this.requests[2]);

  QUnit.strictEqual(this.requests[0].url,
                    'manifest/master.m3u8',
                    'master playlist requested');
  QUnit.strictEqual(this.requests[1].url,
                    absoluteUrl('manifest/media2.m3u8'),
                    'media playlist requested');
  QUnit.strictEqual(this.requests[2].url,
                    absoluteUrl('manifest/media2-00001.ts'),
                    'first segment requested');
});

QUnit.test('downshifts if the initial bandwidth hint is low', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 100;
  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);
  standardXHRResponse(this.requests[2]);

  QUnit.strictEqual(this.requests[0].url,
                    'manifest/master.m3u8',
                    'master playlist requested');
  QUnit.strictEqual(this.requests[1].url,
                    absoluteUrl('manifest/media1.m3u8'),
                    'media playlist requested');
  QUnit.strictEqual(this.requests[2].url,
                    absoluteUrl('manifest/media1-00001.ts'),
                    'first segment requested');
});

QUnit.test('buffer checks are noops until a media playlist is ready', function() {
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.checkBuffer_();

  QUnit.strictEqual(1, this.requests.length, 'one request was made');
  QUnit.strictEqual(this.requests[0].url,
                    'manifest/media.m3u8',
                    'media playlist requested');
});

QUnit.test('buffer checks are noops when only the master is ready', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  // master
  standardXHRResponse(this.requests.shift());
  // media
  standardXHRResponse(this.requests.shift());
  // ignore any outstanding segmentthis.requests
  this.requests.length = 0;

  // load in a new playlist which will cause playlists.media() to be
  // undefined while it is being fetched
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  // respond with the master playlist but don't send the media playlist yet
  // force media1 to be requested
  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  standardXHRResponse(this.requests.shift());
  // trigger fillBuffer()
  this.player.tech_.hls.checkBuffer_();

  QUnit.strictEqual(1, this.requests.length, 'one request was made');
  QUnit.strictEqual(this.requests[0].url,
                    absoluteUrl('manifest/media1.m3u8'),
                    'media playlist requested');
});

QUnit.test('fires a progress event after downloading a segment', function() {
  let progressCount = 0;

  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests.shift());
  this.player.on('progress', function() {
    progressCount++;
  });
  standardXHRResponse(this.requests.shift());
  QUnit.equal(progressCount, 1, 'fired a progress event');
});

QUnit.test('selects a playlist below the current bandwidth', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests[0]);

  // the default playlist has a really high bitrate
  this.player.tech_.hls.playlists.master.playlists[0].attributes.BANDWIDTH = 9e10;
  // playlist 1 has a very low bitrate
  this.player.tech_.hls.playlists.master.playlists[1].attributes.BANDWIDTH = 1;
  // but the detected client bandwidth is really low
  this.player.tech_.hls.segments.bandwidth = 10;

  playlist = this.player.tech_.hls.selectPlaylist();
  QUnit.strictEqual(playlist,
                    this.player.tech_.hls.playlists.master.playlists[1],
                    'the low bitrate stream is selected');
});

QUnit.test('allows initial bandwidth to be provided', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.segments.bandwidth = 500;

  this.requests[0].bandwidth = 1;
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-PLAYLIST-TYPE:VOD\n' +
                                '#EXT-X-TARGETDURATION:10\n');
  QUnit.equal(this.player.tech_.hls.segments.bandwidth,
              500,
              'prefers user-specified intial bandwidth');
});

QUnit.test('raises the minimum bitrate for a stream proportionially', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);

  // the default playlist's bandwidth + 10% is QUnit.equal to the current bandwidth
  this.player.tech_.hls.playlists.master.playlists[0].attributes.BANDWIDTH = 10;
  this.player.tech_.hls.segments.bandwidth = 11;

  // 9.9 * 1.1 < 11
  this.player.tech_.hls.playlists.master.playlists[1].attributes.BANDWIDTH = 9.9;
  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.strictEqual(playlist,
                    this.player.tech_.hls.playlists.master.playlists[1],
                    'a lower bitrate stream is selected');
});

QUnit.test('uses the lowest bitrate if no other is suitable', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);

  // the lowest bitrate playlist is much greater than 1b/s
  this.player.tech_.hls.segments.bandwidth = 1;
  playlist = this.player.tech_.hls.selectPlaylist();

  // playlist 1 has the lowest advertised bitrate
  QUnit.strictEqual(playlist,
                    this.player.tech_.hls.playlists.master.playlists[1],
                    'the lowest bitrate stream is selected');
});

QUnit.test('selects the correct rendition by player dimensions', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });

  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests[0]);

  this.player.width(640);
  this.player.height(360);
  this.player.tech_.hls.segments.bandwidth = 3000000;

  this.clock.tick(1);
  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.deepEqual(playlist.attributes.RESOLUTION,
                  {width: 960, height: 540},
                  'should return the correct resolution by playerdimensions');
  QUnit.equal(playlist.attributes.BANDWIDTH,
              1928000,
              'should have the expected bandwidth in case of multiple');

  this.player.width(1920);
  this.player.height(1080);
  this.player.tech_.hls.segments.bandwidth = 3000000;

  this.clock.tick(1);
  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.deepEqual(playlist.attributes.RESOLUTION,
                  {width: 960, height: 540},
                  'should return the correct resolution by playerdimensions');
  QUnit.equal(playlist.attributes.BANDWIDTH,
              1928000,
              'should have the expected bandwidth in case of multiple');

  this.player.width(396);
  this.player.height(224);
  this.clock.tick(1);
  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.deepEqual(playlist.attributes.RESOLUTION,
                  {width: 396, height: 224},
                  'should return the correct resolution by ' +
                  'this.playerdimensions, if exact match');
  QUnit.equal(playlist.attributes.BANDWIDTH,
              440000,
              'should have the expected bandwidth in case of multiple, if exact match');

  this.player.width(395);
  this.player.height(222);
  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.deepEqual(playlist.attributes.RESOLUTION,
                  {width: 396, height: 224},
                  'should return the next larger resolution by player dimensions, ' +
                  'if no exact match exists');
  QUnit.equal(playlist.attributes.BANDWIDTH,
              440000,
              'should have the expected bandwidth in case of multiple, if exact match');
});

QUnit.test('selects the highest bitrate playlist when the this.playerdimensions are ' +
     'larger than any of the variants', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  // master
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=2x1\n' +
                                'media.m3u8\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1\n' +
                                'media1.m3u8\n');
  // media
  standardXHRResponse(this.requests.shift());
  this.player.tech_.hls.segments.bandwidth = 1e10;

  this.player.width(1024);
  this.player.height(768);

  playlist = this.player.tech_.hls.selectPlaylist();

  QUnit.equal(playlist.attributes.BANDWIDTH,
              1000,
              'selected the highest bandwidth variant');
});

QUnit.test('filters playlists that are currently excluded', function() {
  let playlist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1e10;
  // master
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1000\n' +
                                'media.m3u8\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1\n' +
                                'media1.m3u8\n');
  // media
  standardXHRResponse(this.requests.shift());

  // exclude the current playlist
  this.player.tech_.hls.playlists.master.playlists[0].excludeUntil = +new Date() + 1000;
  playlist = this.player.tech_.hls.selectPlaylist();
  QUnit.equal(playlist,
              this.player.tech_.hls.playlists.master.playlists[1],
              'respected exclusions');

  // timeout the exclusion
  this.clock.tick(1000);
  playlist = this.player.tech_.hls.selectPlaylist();
  QUnit.equal(playlist,
              this.player.tech_.hls.playlists.master.playlists[0],
              'expired the exclusion');
});

QUnit.test('blacklists switching from video+audio playlists to audio only', function() {
  let audioPlaylist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1e10;
  // master
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"\n' +
                                'media.m3u8\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1x1\n' +
                                'media1.m3u8\n');

  // media1
  standardXHRResponse(this.requests.shift());
  QUnit.equal(this.player.tech_.hls.playlists.media(),
              this.player.tech_.hls.playlists.master.playlists[1],
              'selected video+audio');
  audioPlaylist = this.player.tech_.hls.playlists.master.playlists[0];
  QUnit.equal(audioPlaylist.excludeUntil, Infinity, 'excluded incompatible playlist');
});

QUnit.test('blacklists switching from audio-only playlists to video+audio', function() {
  let videoAudioPlaylist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"\n' +
                                'media.m3u8\n' +
                                '#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1x1\n' +
                                'media1.m3u8\n');

  // media1
  standardXHRResponse(this.requests.shift());
  QUnit.equal(this.player.tech_.hls.playlists.media(),
              this.player.tech_.hls.playlists.master.playlists[0],
              'selected audio only');
  videoAudioPlaylist = this.player.tech_.hls.playlists.master.playlists[1];
  QUnit.equal(videoAudioPlaylist.excludeUntil,
              Infinity,
              'excluded incompatible playlist');
});

QUnit.test('blacklists switching from video-only playlists to video+audio', function() {
  let videoAudioPlaylist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d400d"\n' +
             'media.m3u8\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="avc1.4d400d,mp4a.40.2"\n' +
             'media1.m3u8\n');

  // media
  standardXHRResponse(this.requests.shift());
  QUnit.equal(this.player.tech_.hls.playlists.media(),
              this.player.tech_.hls.playlists.master.playlists[0],
              'selected video only');
  videoAudioPlaylist = this.player.tech_.hls.playlists.master.playlists[1];
  QUnit.equal(videoAudioPlaylist.excludeUntil,
              Infinity,
              'excluded incompatible playlist');
});

QUnit.test('After an initial media playlist 404s, ' +
'we fire loadedmetadata once we successfully load a playlist',
function() {
  let count = 0;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.segments.bandwidth = 20000;
  this.player.on('loadedmetadata', function() {
    count += 1;
  });
  // master
  standardXHRResponse(this.requests.shift());
  QUnit.equal(count,
    0,
    'loadedMedia not triggered before requesting playlist');
  // media
  this.requests.shift().respond(404);
  QUnit.equal(count,
              0,
              'loadedMedia not triggered after playlist 404');
  // media
  standardXHRResponse(this.requests.shift());
  QUnit.equal(count,
              1,
              'loadedMedia triggered after successful recovery from 404');
});

QUnit.test('does not blacklist compatible H.264 codec strings', function() {
  let master;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d400d,mp4a.40.5"\n' +
             'media.m3u8\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="avc1.4d400f,mp4a.40.5"\n' +
             'media1.m3u8\n');

  // media
  standardXHRResponse(this.requests.shift());
  master = this.player.tech_.hls.playlists.master;
  QUnit.strictEqual(typeof master.playlists[0].excludeUntil,
                    'undefined',
                    'did not blacklist');
  QUnit.strictEqual(typeof master.playlists[1].excludeUntil,
                    'undefined',
                    'did not blacklist');
});

QUnit.test('does not blacklist compatible AAC codec strings', function() {
  let master;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d400d,mp4a.40.2"\n' +
             'media.m3u8\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="avc1.4d400d,mp4a.40.3"\n' +
             'media1.m3u8\n');

  // media
  standardXHRResponse(this.requests.shift());
  master = this.player.tech_.hls.playlists.master;
  QUnit.strictEqual(typeof master.playlists[0].excludeUntil,
                      'undefined',
                    'did not blacklist');
  QUnit.strictEqual(typeof master.playlists[1].excludeUntil,
                    'undefined',
                    'did not blacklist');
});

QUnit.test('blacklists switching between playlists with incompatible audio codecs',
function() {
  let alternatePlaylist;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1;
  // master
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d400d,mp4a.40.5"\n' +
             'media.m3u8\n' +
             '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="avc1.4d400d,mp4a.40.2"\n' +
             'media1.m3u8\n');

  // media
  standardXHRResponse(this.requests.shift());
  QUnit.equal(this.player.tech_.hls.playlists.media(),
              this.player.tech_.hls.playlists.master.playlists[0],
              'selected HE-AAC stream');
  alternatePlaylist = this.player.tech_.hls.playlists.master.playlists[1];
  QUnit.equal(alternatePlaylist.excludeUntil, Infinity, 'excluded incompatible playlist');
});

QUnit.test('cancels outstanding XHRs when seeking', function() {
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests[0]);
  player.tech_.hls.media = {
    segments: [{
      uri: '0.ts',
      duration: 10
    }, {
      uri: '1.ts',
      duration: 10
    }]
  };

  // attempt to seek while the download is in progress
  this.player.currentTime(7);
  this.clock.tick(1);

  QUnit.ok(this.requests[1].aborted, 'XHR aborted');
  QUnit.strictEqual(this.requests.length, 3, 'opened new XHR');
});

QUnit.test('does not abort segment loading for in-buffer seeking', function() {
  let mediaIndex;

  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  standardXHRResponse(this.requests.shift());
  this.player.tech_.buffered = function() {
    return videojs.createTimeRange(0, 20);
  };
  mediaIndex = player.tech_.hls.mediaIndex;

  this.player.tech_.setCurrentTime(11);
  this.clock.tick(1);
  QUnit.equal(this.requests.length, 1, 'did not abort the outstanding request');
});

QUnit.test('playlist 404 should end stream with a network error', function() {
  this.player.src({
    src: 'manifest/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.pop().respond(404);

  QUnit.equal(this.player.tech_.hls.mediaSource.error_, 'network', 'set a network error');
});

QUnit.test('segment 404 should trigger blacklisting of media', function() {
  let media;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 20000;
  // master
  standardXHRResponse(this.requests[0]);
  // media
  standardXHRResponse(this.requests[1]);

  media = this.player.tech_.hls.playlists.media_;

  // segment
  this.requests[2].respond(400);
  QUnit.ok(media.excludeUntil > 0, 'original media blacklisted for some time');
});

QUnit.test('playlist 404 should blacklist media', function() {
  let media;
  let url;

  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.segments.bandwidth = 1e10;
  // master
  this.requests[0].respond(200, null,
                           '#EXTM3U\n' +
                           '#EXT-X-STREAM-INF:BANDWIDTH=1000\n' +
                           'media.m3u8\n' +
                           '#EXT-X-STREAM-INF:BANDWIDTH=1\n' +
                           'media1.m3u8\n');

  QUnit.equal(typeof this.player.tech_.hls.playlists.media_,
              'undefined',
              'no media is initially set');

  // media
  this.requests[1].respond(400);

  url = this.requests[1].url.slice(this.requests[1].url.lastIndexOf('/') + 1);
  media = this.player.tech_.hls.playlists.master.playlists[url];

  QUnit.ok(media.excludeUntil > 0, 'original media blacklisted for some time');
});

QUnit.test('seeking in an empty playlist is a non-erroring noop', function() {
  let requestsLength;

  this.player.src({
    src: 'manifest/empty-live.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.requests.shift().respond(200, null, '#EXTM3U\n');

  requestsLength = this.requests.length;
  this.player.tech_.setCurrentTime(183);
  this.clock.tick(1);

  QUnit.equal(this.requests.length, requestsLength, 'made no additional this.requests');
});

QUnit.test('sets seekable and duration for live playlists', function() {
  this.player.src({
    src: 'http://example.com/manifest/missingEndlist.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);

  QUnit.equal(this.player.tech_.hls.mediaSource.seekable.length,
              1,
              'set one seekable range');
  QUnit.equal(this.player.tech_.hls.mediaSource.seekable.start(0),
              this.player.tech_.hls.seekable().start(0),
              'set seekable start');
  QUnit.equal(this.player.tech_.hls.mediaSource.seekable.end(0),
              this.player.tech_.hls.seekable().end(0),
              'set seekable end');

  QUnit.strictEqual(this.player.tech_.hls.mediaSource.duration,
                    Infinity,
                    'duration on the mediaSource is infinity');
});

QUnit.test('live playlist starts three target durations before live', function() {
  /* eslint-disable no-unused-vars */
  let mediaPlaylist;
  /* eslint-enable no-unused-vars */

  this.player.src({
    src: 'live.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-MEDIA-SEQUENCE:101\n' +
                                '#EXTINF:10,\n' +
                                '0.ts\n' +
                                '#EXTINF:10,\n' +
                                '1.ts\n' +
                                '#EXTINF:10,\n' +
                                '2.ts\n' +
                                '#EXTINF:10,\n' +
                                '3.ts\n' +
                                '#EXTINF:10,\n' +
                                '4.ts\n');

  QUnit.equal(this.requests.length, 0, 'no outstanding segment request');

  this.player.tech_.paused = function() {
    return false;
  };
  this.player.tech_.readyState = function() {
    return 1;
  };
  this.player.tech_.trigger('play');
  this.clock.tick(1);
  mediaPlaylist = this.player.tech_.hls.playlists.media();
  QUnit.equal(this.player.currentTime(),
              this.player.tech_.hls.seekable().end(0),
              'seeked to the seekable end');

  QUnit.equal(this.requests.length, 1, 'begins buffering');
});

QUnit.test('live playlist starts with correct currentTime value', function() {
  this.player.src({
    src: 'http://example.com/manifest/liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests[0]);

  this.player.tech_.hls.playlists.trigger('loadedmetadata');

  this.player.tech_.paused = function() {
    return false;
  };
  this.player.tech_.readyState = function() {
    return 1;
  };
  this.player.tech_.trigger('play');
  this.clock.tick(1);

  QUnit.strictEqual(this.player.currentTime(),
                    videojs.Hls.Playlist.seekable(this.player.tech_.hls.playlists.media())
                      .end(0),
                    'currentTime is updated at playback');
});

QUnit.test('adjusts the seekable start based on the amount of expired live content',
function() {
  this.player.src({
    src: 'http://example.com/manifest/liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests.shift());

  // add timeline info to the playlist
  this.player.tech_.hls.playlists.media().segments[1].end = 29.5;
  // expired_ should be ignored if there is timeline information on
  // the playlist
  this.player.tech_.hls.playlists.expired_ = 172;

  QUnit.equal(this.player.seekable().start(0),
              29.5 - 29,
              'offset the seekable start');
});

QUnit.test('estimates seekable ranges for live streams ' +
'that have been paused for a long time',
function() {
  this.player.src({
    src: 'http://example.com/manifest/liveStart30sBefore.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  standardXHRResponse(this.requests.shift());
  this.player.tech_.hls.playlists.expired_ = 172;

  QUnit.equal(this.player.seekable().start(0),
              this.player.tech_.hls.playlists.expired_,
              'offset the seekable start');
});

QUnit.test('resets the time to a seekable position when resuming a live stream ' +
     'after a long break', function() {
  let seekTarget;

  this.player.src({
    src: 'live0.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-MEDIA-SEQUENCE:16\n' +
                                '#EXTINF:10,\n' +
                                '16.ts\n');
  // mock out the this.playerto simulate a live stream that has been
  // playing for awhile
  this.player.tech_.hls.seekable = function() {
    return videojs.createTimeRange(160, 170);
  };
  this.player.tech_.setCurrentTime = function(time) {
    if (typeof time !== 'undefined') {
      seekTarget = time;
    }
  };
  this.player.tech_.played = function() {
    return videojs.createTimeRange(120, 170);
  };
  this.player.tech_.trigger('playing');

  this.player.tech_.trigger('play');
  QUnit.equal(seekTarget,
              this.player.seekable().start(0),
              'seeked to the start of seekable');
  this.player.tech_.trigger('seeked');
});

QUnit.test('reloads out-of-date live playlists when switching variants', function() {
  let oldManifest = testDataManifests['variant-update'];

  this.player.src({
    src: 'http://example.com/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.master = {
    playlists: [{
      mediaSequence: 15,
      segments: [1, 1, 1]
    }, {
      uri: 'http://example.com/variant-update.m3u8',
      mediaSequence: 0,
      segments: [1, 1]
    }]
  };
  // playing segment 15 on playlist zero
  this.player.tech_.hls.media = this.player.tech_.hls.master.playlists[0];
  this.player.mediaIndex = 1;

  testDataManifests['variant-update'] = '#EXTM3U\n' +
    '#EXT-X-MEDIA-SEQUENCE:16\n' +
    '#EXTINF:10,\n' +
    '16.ts\n' +
    '#EXTINF:10,\n' +
    '17.ts\n';

  // switch playlists
  this.player.tech_.hls.selectPlaylist = function() {
    return this.player.tech_.hls.master.playlists[1];
  };
  // timeupdate downloads segment 16 then switches playlists
  this.player.trigger('timeupdate');

  QUnit.strictEqual(this.player.mediaIndex, 1, 'mediaIndex points at the next segment');
  testDataManifests['variant-update'] = oldManifest;
});

QUnit.test('if withCredentials global option is used, ' +
           'withCredentials is set on the XHR object',
function() {
  let hlsOptions = videojs.options.hls;

  this.player.dispose();
  videojs.options.hls = {
    withCredentials: true
  };
  this.player = createPlayer();
  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  QUnit.ok(this.requests[0].withCredentials,
           'with credentials should be set to true if that option is passed in');
  videojs.options.hls = hlsOptions;
});

QUnit.test('if withCredentials src option is used, ' +
           'withCredentials is set on the XHR object',
function() {
  this.player.dispose();
  this.player = createPlayer();
  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl',
    withCredentials: true
  });
  openMediaSource(this.player, this.clock);
  QUnit.ok(this.requests[0].withCredentials,
           'with credentials should be set to true if that option is passed in');
});

QUnit.test('src level credentials supersede the global options', function() {
  this.player.dispose();
  this.player = createPlayer();
  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl',
    withCredentials: true
  });
  openMediaSource(this.player, this.clock);
  QUnit.ok(this.requests[0].withCredentials,
           'with credentials should be set to true if that option is passed in');

});

QUnit.test('does not break if the playlist has no segments', function() {
  this.player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  try {
    openMediaSource(this.player, this.clock);
    this.requests[0].respond(200, null,
                             '#EXTM3U\n' +
                             '#EXT-X-PLAYLIST-TYPE:VOD\n' +
                             '#EXT-X-TARGETDURATION:10\n');
  } catch (e) {
    QUnit.ok(false, 'an error was thrown');
    throw e;
  }
  QUnit.ok(true, 'no error was thrown');
  QUnit.strictEqual(this.requests.length,
                    1,
                    'no this.requestsfor non-existent segments were queued');
});

QUnit.test('aborts segment processing on seek', function() {
  let currentTime = 0;

  this.player.src({
    src: 'discontinuity.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.currentTime = function() {
    return currentTime;
  };
  this.player.tech_.buffered = function() {
    return videojs.createTimeRange();
  };
  // media
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.php"\n' +
                                '#EXTINF:10,0\n' +
                                '1.ts\n' +
                                '#EXT-X-DISCONTINUITY\n' +
                                '#EXTINF:10,0\n' +
                                '2.ts\n' +
                                '#EXT-X-ENDLIST\n');
  // 1.ts
  standardXHRResponse(this.requests.shift());
  // key.php
  standardXHRResponse(this.requests.shift());
  QUnit.ok(this.player.tech_.hls.pendingSegment_, 'decrypting the segment');

  // seek back to the beginning
  this.player.currentTime(0);
  this.clock.tick(1);
  QUnit.ok(!this.player.tech_.hls.pendingSegment_, 'aborted processing');
});

QUnit.test('can seek before the source buffer opens', function() {
  this.player.src({
    src: 'media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.tech_.triggerReady();
  this.clock.tick(1);
  standardXHRResponse(this.requests.shift());
  this.player.triggerReady();

  this.player.currentTime(1);
  QUnit.equal(this.player.currentTime(), 1, 'seeked');
});

QUnit.test('resets the switching algorithm if a request times out', function() {
  this.player.src({
    src: 'master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.segments.bandwidth = 1e20;

  // master
  standardXHRResponse(this.requests.shift());
  // media.m3u8
  standardXHRResponse(this.requests.shift());
  // simulate a segment timeout
  this.requests[0].timedout = true;
  this.requests.shift().abort();

  standardXHRResponse(this.requests.shift());

  QUnit.strictEqual(this.player.tech_.hls.playlists.media(),
                    this.player.tech_.hls.playlists.master.playlists[1],
                    'reset to the lowest bitrate playlist');
});

QUnit.test('disposes the playlist loader', function() {
  let disposes = 0;
  let player;
  let loaderDispose;

  player = createPlayer();
  player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(player, this.clock);
  loaderDispose = player.tech_.hls.playlists.dispose;
  player.tech_.hls.playlists.dispose = function() {
    disposes++;
    loaderDispose.call(player.tech_.hls.playlists);
  };

  player.dispose();
  QUnit.strictEqual(disposes, 1, 'disposed playlist loader');
});

QUnit.test('remove event handlers on dispose', function() {
  let player;
  let unscoped = 0;

  player = createPlayer();
  player.on = function(owner) {
    if (typeof owner !== 'object') {
      unscoped++;
    }
  };
  player.off = function(owner) {
    if (typeof owner !== 'object') {
      unscoped--;
    }
  };
  player.src({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(player, this.clock);

  standardXHRResponse(this.requests[0]);
  standardXHRResponse(this.requests[1]);

  player.dispose();

  QUnit.ok(unscoped <= 0, 'no unscoped handlers');
});

QUnit.test('the source handler supports HLS mime types', function() {
  ['html5', 'flash'].forEach(function(techName) {
    QUnit.ok(videojs.HlsSourceHandler(techName).canHandleSource({
      type: 'aPplicatiOn/x-MPegUrl'
    }), 'supports x-mpegurl');
    QUnit.ok(videojs.HlsSourceHandler(techName).canHandleSource({
      type: 'aPplicatiOn/VnD.aPPle.MpEgUrL'
    }), 'supports vnd.apple.mpegurl');
    QUnit.ok(videojs.HlsSourceHandler(techName)
             .canPlayType('aPplicatiOn/VnD.aPPle.MpEgUrL'),
            'supports vnd.apple.mpegurl');
    QUnit.ok(videojs.HlsSourceHandler(techName).canPlayType('aPplicatiOn/x-MPegUrl'),
             'supports x-mpegurl');

    QUnit.ok(!(videojs.HlsSourceHandler(techName).canHandleSource({
      type: 'video/mp4'
    }) instanceof videojs.HlsHandler), 'does not support mp4');
    QUnit.ok(!(videojs.HlsSourceHandler(techName).canHandleSource({
      type: 'video/x-flv'
    }) instanceof videojs.HlsHandler), 'does not support flv');
    QUnit.ok(!(videojs.HlsSourceHandler(techName).canPlayType('video/mp4')),
             'does not support mp4');
    QUnit.ok(!(videojs.HlsSourceHandler(techName).canPlayType('video/x-flv')),
             'does not support flv');
  });
});

QUnit.test('fires loadstart manually if Flash is used', function() {
  let tech = new (videojs.extend(videojs.EventTarget, {
    buffered() {
      return videojs.createTimeRange();
    },
    currentTime() {
      return 0;
    },
    el() {
      return {};
    },
    preload() {
      return 'auto';
    },
    src() {},
    setTimeout: window.setTimeout
  }))();
  let loadstarts = 0;

  tech.on('loadstart', function() {
    loadstarts++;
  });
  videojs.HlsSourceHandler('flash').handleSource({
    src: 'movie.m3u8',
    type: 'application/x-mpegURL'
  }, tech);

  QUnit.equal(loadstarts, 0, 'loadstart is not synchronous');
  this.clock.tick(1);
  QUnit.equal(loadstarts, 1, 'fired loadstart');
});

QUnit.test('has no effect if native HLS is available', function() {
  let player;

  videojs.Hls.supportsNativeHls = function() {
    return true;
  };
  player = createPlayer();
  player.src({
    src: 'http://example.com/manifest/master.m3u8',
    type: 'application/x-mpegURL'
  });

  QUnit.ok(!player.tech_.hls, 'did not load hls tech');
  player.dispose();
});

QUnit.test('is not supported on browsers without typed arrays', function() {
  let oldArray = window.Uint8Array;

  window.Uint8Array = null;
  QUnit.ok(!videojs.Hls.isSupported(), 'HLS is not supported');

  // cleanup
  window.Uint8Array = oldArray;
});

QUnit.test('re-emits mediachange events', function() {
  let mediaChanges = 0;

  this.player.on('mediachange', function() {
    mediaChanges++;
  });

  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.player.tech_.hls.playlists.trigger('mediachange');
  QUnit.strictEqual(mediaChanges, 1, 'fired mediachange');
});

QUnit.test('can be disposed before finishing initialization', function() {
  let readyHandlers = [];

  this.player.ready = function(callback) {
    readyHandlers.push(callback);
  };
  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  this.player.src({
    src: 'http://example.com/media.mp4',
    type: 'video/mp4'
  });
  QUnit.ok(readyHandlers.length > 0, 'registered a ready handler');
  try {
    while (readyHandlers.length) {
      readyHandlers.shift().call(this.player);
      openMediaSource(this.player, this.clock);
    }
    QUnit.ok(true, 'did not throw an exception');
  } catch (e) {
    QUnit.ok(false, 'threw an exception');
  }
});

QUnit.test('calling play() at the end of a video replays', function() {
  let seekTime = -1;

  this.player.src({
    src: 'http://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.setCurrentTime = function(time) {
    if (typeof time !== 'undefined') {
      seekTime = time;
    }
    return 0;
  };
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXTINF:10,\n' +
                                '0.ts\n' +
                                '#EXT-X-ENDLIST\n');
  standardXHRResponse(this.requests.shift());
  this.player.tech_.ended = function() {
    return true;
  };

  this.player.tech_.trigger('play');
  QUnit.equal(seekTime, 0, 'seeked to the beginning');
});

QUnit.test('blacklists playlist if key this.requestsfail more than once', function() {
  let bytes = [];
  let media;

  this.player.src({
    src: 'https://example.com/encrypted-media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=53"\n' +
             '#EXTINF:15.0,\n' +
             'http://media.example.com/fileSequence53-A.ts\n');
  this.player.tech_.hls.sourceBuffer.appendBuffer = function(chunk) {
    bytes.push(chunk);
  };
  media = this.player.tech_.hls.playlists.media_;
  // segment 1
  standardXHRResponse(this.requests.pop());
  // fail key
  this.requests.shift().respond(400);
  // fail key, again
  this.requests.shift().respond(400);
  this.clock.tick(10 * 1000);
  QUnit.ok(media.excludeUntil > 0,
           'playlist blacklisted');
});

QUnit.test('keys are requested when an encrypted segment is loaded', function() {
  this.player.src({
    src: 'https://example.com/encrypted.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');
  // playlist
  standardXHRResponse(this.requests.shift());

  QUnit.strictEqual(this.requests.length, 2, 'a key XHR is created');
  QUnit.strictEqual(this.requests[0].url,
                    this.player.tech_.hls.playlists.media().segments[0].key.uri,
                    'key XHR is created with correct uri');
  QUnit.strictEqual(this.requests[1].url,
                    this.player.tech_.hls.playlists.media().segments[0].uri,
                    'segment XHR is created with correct uri');
});

QUnit.test('keys are resolved relative to the master playlist', function() {
  this.player.src({
    src: 'video/master-encrypted.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=17\n' +
                                'playlist/playlist.m3u8\n' +
                                '#EXT-X-ENDLIST\n');
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-TARGETDURATION:15\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.php"\n' +
                                '#EXTINF:2.833,\n' +
                                'http://media.example.com/fileSequence1.ts\n' +
                                '#EXT-X-ENDLIST\n');
  QUnit.equal(this.requests.length, 2, 'requested the key');
  QUnit.equal(this.requests[0].url,
              absoluteUrl('video/playlist/keys/key.php'),
              'resolves multiple relative paths');
});

QUnit.test('keys are resolved relative to their containing playlist', function() {
  this.player.src({
    src: 'video/media-encrypted.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-TARGETDURATION:15\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.php"\n' +
                                '#EXTINF:2.833,\n' +
                                'http://media.example.com/fileSequence1.ts\n' +
                                '#EXT-X-ENDLIST\n');
  QUnit.equal(this.requests.length, 2, 'requested a key');
  QUnit.equal(this.requests[0].url,
              absoluteUrl('video/keys/key.php'),
              'resolves multiple relative paths');
});

QUnit.test('a new key XHR is created when a the segment is requested', function() {
  this.player.src({
    src: 'https://example.com/encrypted-media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-TARGETDURATION:15\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.php"\n' +
                                '#EXTINF:2.833,\n' +
                                'http://media.example.com/fileSequence1.ts\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key2.php"\n' +
                                '#EXTINF:2.833,\n' +
                                'http://media.example.com/fileSequence2.ts\n' +
                                '#EXT-X-ENDLIST\n');
  // key 1
  standardXHRResponse(this.requests.shift());
  // segment 1
  standardXHRResponse(this.requests.shift());
  // "finish" decrypting segment 1
  this.player.tech_.hls.pendingSegment_.bytes = new Uint8Array(16);
  this.player.tech_.hls.checkBuffer_();
  this.player.tech_.buffered = function() {
    return videojs.createTimeRange(0, 2.833);
  };
  this.player.tech_.hls.sourceBuffer.trigger('updateend');

  QUnit.strictEqual(this.requests.length, 2, 'a key XHR is created');
  QUnit.strictEqual(this.requests[0].url,
                    'https://example.com/' +
                    this.player.tech_.hls.playlists.media().segments[1].key.uri,
                    'a key XHR is created with the correct uri');
});

QUnit.test('seeking should abort an outstanding key request and create a new one',
function() {
  this.player.src({
    src: 'https://example.com/encrypted.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);

  this.requests.shift().respond(200, null,
                                '#EXTM3U\n' +
                                '#EXT-X-TARGETDURATION:15\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.php"\n' +
                                '#EXTINF:9,\n' +
                                'http://media.example.com/fileSequence1.ts\n' +
                                '#EXT-X-KEY:METHOD=AES-128,URI="keys/key2.php"\n' +
                                '#EXTINF:9,\n' +
                                'http://media.example.com/fileSequence2.ts\n' +
                                '#EXT-X-ENDLIST\n');
  // segment 1
  standardXHRResponse(this.requests.pop());

  this.player.currentTime(11);
  this.clock.tick(1);
  QUnit.ok(this.requests[0].aborted, 'the key XHR should be aborted');
  // aborted key 1
  this.requests.shift();

  QUnit.equal(this.requests.length, 2, 'requested the new key');
  QUnit.equal(this.requests[0].url,
              'https://example.com/' +
              this.player.tech_.hls.playlists.media().segments[1].key.uri,
              'urls should match');
});

QUnit.test('switching playlists with an outstanding key request aborts request and loads segment', function() {
  var media = '#EXTM3U\n' +
      '#EXT-X-MEDIA-SEQUENCE:5\n' +
      '#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"\n' +
      '#EXTINF:2.833,\n' +
      'http://media.example.com/fileSequence52-A.ts\n' +
      '#EXTINF:15.0,\n' +
      'http://media.example.com/fileSequence52-B.ts\n' +
      '#EXT-X-ENDLIST\n',
      keyXhr;
  this.player.src({
    src: 'https://example.com/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');
  // master playlist
  standardXHRResponse(this.requests.shift());
  // media playlist
  this.requests.shift().respond(200, null, media);
  // first segment of the original media playlist
  standardXHRResponse(this.requests.pop());
  QUnit.equal(this.requests.length, 1, 'key request only one outstanding');
  keyXhr = requests.shift();
  QUnit.ok(!keyXhr.aborted, 'key request outstanding');

  this.player.tech_.hls.playlists.trigger('mediachange');

  QUnit.ok(keyXhr.aborted, 'key request aborted');
  QUnit.equal(this.requests.length, 2, 'loaded key and segment');
  QUnit.equal(this.requests[0].url,
              'https://priv.example.com/key.php?r=52',
              'requested the key');
  QUnit.equal(this.requests[1].url,
              'http://media.example.com/fileSequence52-A.ts',
              'requested the segment');
});

QUnit.test('retries key this.requestsonce upon failure', function() {
  this.player.src({
    src: 'https://example.com/encrypted.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');

  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=53"\n' +
             '#EXTINF:15.0,\n' +
             'http://media.example.com/fileSequence53-A.ts\n');
    // segment
  standardXHRResponse(this.requests.pop());
  this.requests[0].respond(404);
  QUnit.equal(this.requests.length, 2, 'create a new XHR for the same key');
  QUnit.equal(this.requests[1].url, this.requests[0].url, 'should be the same key');

  this.requests[1].respond(404);
  QUnit.equal(this.requests.length, 2, 'gives up after one retry');
});

QUnit.test('does not download segments if preload option set to none', function() {
  this.player.preload('none');
  this.player.src({
    src: 'master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  // master
  standardXHRResponse(this.requests.shift());
  // media
  standardXHRResponse(this.requests.shift());
  clock.tick(10 * 1000);

  this.requests = this.requests.filter(function(request) {
    return !(/m3u8$/).test(request.uri);
  });
  QUnit.equal(this.requests.length, 0, 'did not download any segments');
});

// workaround https://bugzilla.mozilla.org/show_bug.cgi?id=548397
QUnit.test('selectPlaylist does not fail if getComputedStyle returns null', function() {
  var oldGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = function() {
    return null;
  };

  this.player.src({
    src: 'master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.hls.selectPlaylist();
  QUnit.ok(true, 'should not throw');
  window.getComputedStyle = oldGetComputedStyle;
});

QUnit.test('the key is supplied to the decrypter in the correct format', function() {
  let keys = [];

  this.player.src({
    src: 'https://example.com/encrypted-media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');
  this.requests.pop()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-MEDIA-SEQUENCE:5\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXTINF:15.0,\n' +
             'http://media.example.com/fileSequence52-B.ts\n');

  requests = requests.filter(function(request) {
    return !/m3u8$/.test(request.uri);
  });
  equal(requests.length, 0, 'did not download any segments');

  // segment
  standardXHRResponse(this.requests.pop());
  this.requests[0].response = new Uint32Array([0, 1, 2, 3]).buffer;
  this.requests[0].respond(200, null, '');
  // key
  this.requests.shift();
  QUnit.equal(keys.length, 1, 'only one Decrypter was constructed');
  QUnit.deepEqual(keys[0],
                  new Uint32Array([0, 0x01000000, 0x02000000, 0x03000000]),
                  'passed the specified segment key');
});

QUnit.test('supplies the media sequence of current segment' +
           ' as the IV by default, if no IV is specified', function() {
  let ivs = [];
  this.player.src({
    src: 'https://example.com/encrypted-media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');

  this.requests.pop()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-MEDIA-SEQUENCE:5\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="htts://priv.example.com/key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXTINF:15.0,\n' +
             'http://media.example.com/fileSequence52-B.ts\n');
  videojs.Hls.Decrypter = function(encrypted, key, iv) {
    ivs.push(iv);
  };
  this.requests[0].response = new Uint32Array([0, 0, 0, 0]).buffer;
  this.requests[0].respond(200, null, '');
  this.requests.shift();
  standardXHRResponse(this.requests.pop());
  QUnit.equal(ivs.length, 1, 'only one Decrypter was constructed');
  QUnit.deepEqual(ivs[0],
                  new Uint32Array([0, 0, 0, 5]),
                  'the IV for the segment is the media sequence');
});

QUnit.test('resolves relative key URLs against the playlist', function() {
  this.player.src({
    src: 'https://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-MEDIA-SEQUENCE:5\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXT-X-ENDLIST\n');
  QUnit.equal(this.requests[0].url,
              'https://example.com/key.php?r=52',
              'resolves the key URL');
});

QUnit.test('treats invalid keys as a key request failure and blacklists playlist', function() {
  let bytes = [];
  let media;

  this.player.src({
    src: 'https://example.com/media.m3u8',
    type: 'application/vnd.apple.mpegurl'
  });
  openMediaSource(this.player, this.clock);
  this.player.tech_.trigger('play');
  this.requests.shift()
    .respond(200, null,
             '#EXTM3U\n' +
             '#EXT-X-MEDIA-SEQUENCE:5\n' +
             '#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"\n' +
             '#EXTINF:2.833,\n' +
             'http://media.example.com/fileSequence52-A.ts\n' +
             '#EXT-X-KEY:METHOD=NONE\n' +
             '#EXTINF:15.0,\n' +
             'http://media.example.com/fileSequence52-B.ts\n');
  this.player.tech_.hls.sourceBuffer.appendBuffer = function(chunk) {
    bytes.push(chunk);
  };
  media = this.player.tech_.hls.playlists.media_;
  // segment request
  standardXHRResponse(this.requests.pop());
  // keys should be 16 bytes long
  this.requests[0].response = new Uint8Array(1).buffer;
  this.requests.shift().respond(200, null, '');
  QUnit.equal(this.requests[0].url,
              'https://priv.example.com/key.php?r=52',
              'retries the key');
  // the retried response is invalid, too
  this.requests[0].response = new Uint8Array(1);
  this.requests.shift().respond(200, null, '');
  this.clock.tick(10 * 1000);
  // two failed attempts is an error - blacklist this playlist
  QUnit.ok(media.excludeUntil > 0,
           'blacklisted playlist');
});

  var mse, env, requests, tech;

module('HLS Integration', {
  beforeEach: function() {
    env = videojs.useFakeEnvironment();
    requests = env.requests;
    mse = videojs.useFakeMediaSource()
    tech = new (videojs.getTech('Html5'))({});
  },
  afterEach: function() {
    env.restore();
    mse.restore();
  }
});

QUnit.test('updates the segment loader on media changes', function() {
  var updates = [], hls;
  hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');

  hls.bandwidth = 1;
  standardXHRResponse(requests.shift()); // master
  standardXHRResponse(requests.shift()); // media
  hls.segments.playlist = function(update) {
    updates.push(update);
  };

  // downloading the new segment will update bandwidth and cause a
  // playlist change
  standardXHRResponse(requests.shift()); // segment 0
  hls.mediaSource.sourceBuffers[0].trigger('updateend');
  standardXHRResponse(requests.shift()); // media
  QUnit.equal(updates.length, 1, 'updated the segment list');
});

QUnit.test('aborts all in-flight work when disposed', function() {
  var hls;
  hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');
  standardXHRResponse(requests.shift()); // master
  standardXHRResponse(requests.shift()); // media

  hls.dispose();
  ok(requests[0].aborted, 'aborted the old segment request');
  equal(hls.mediaSource.readyState, 'closed', 'closed the media source');
});

QUnit.test('selects a playlist after segment downloads', function() {
  var calls = 0, hls;
  hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');
  hls.selectPlaylist = function() {
    calls++;
    return hls.playlists.master.playlists[0];
  };

  standardXHRResponse(requests[0]); // master
  standardXHRResponse(requests[1]); // media

  standardXHRResponse(requests[2]); // segment
  hls.mediaSource.sourceBuffers[0].trigger('updateend');
  QUnit.strictEqual(calls, 2, 'selects after the initial segment');

  standardXHRResponse(requests[3]); // segment
  hls.mediaSource.sourceBuffers[0].trigger('updateend');
  QUnit.strictEqual(calls, 3, 'selects after additional segments');
});

QUnit.test('updates the duration after switching playlists', function() {
  var selectedPlaylist = false, hls;
  hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');

  hls.bandwidth = 1e20;
  standardXHRResponse(requests[0]); // master
  standardXHRResponse(requests[1]); // media3

  hls.selectPlaylist = function() {
    selectedPlaylist = true;

    // this duration should be overwritten by the playlist change
    hls.mediaSource = {
      duration: 0,
      readyState: 'open'
    };

    return hls.playlists.master.playlists[1];
  };

  standardXHRResponse(requests[2]); // segment 0
  hls.mediaSource.sourceBuffers[0].trigger('updateend');
  standardXHRResponse(requests[3]); // media1
  QUnit.ok(selectedPlaylist, 'selected playlist');
  QUnit.ok(hls.mediaSource.duration !== 0, 'updates the duration');
});

QUnit.test('downloads additional playlists if required', function() {
  var called = false, originalPlaylist, hls;
  hls = hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');

  hls.bandwidth = 1;
  standardXHRResponse(requests[0]); // master
  standardXHRResponse(requests[1]); // media
  originalPlaylist = hls.playlists.media();

  // the playlist selection is revisited after a new segment is downloaded
  requests[2].bandwidth = 3000000;
  standardXHRResponse(requests[2]); // segment
  hls.mediaSource.sourceBuffers[0].trigger('updateend');

  standardXHRResponse(requests[3]); // new media

  QUnit.ok((/manifest\/media\d+.m3u8$/).test(requests[3].url), 'made a playlist request');
  QUnit.notEqual(originalPlaylist.resolvedUri,
                 hls.playlists.media().resolvedUri,
                 'a new playlists was selected');
  QUnit.ok(hls.playlists.media().segments, 'segments are now available');
});

QUnit.test('waits to download new segments until the media playlist is stable', function() {
  var hls, sourceBuffer;
  hls = videojs.HlsSourceHandler('html5').handleSource({
    src: 'manifest/master.m3u8',
    type: 'application/vnd.apple.mpegurl'
  }, tech);
  hls.mediaSource.trigger('sourceopen');
  sourceBuffer = hls.mediaSource.sourceBuffers[0];

  hls.bandwidth = 1; // make sure we stay on the lowest variant
  standardXHRResponse(requests.shift()); // master
  standardXHRResponse(requests.shift()); // media1

  // force a playlist switch
  hls.playlists.media('media3.m3u8');

  standardXHRResponse(requests.shift()); // segment 0
  sourceBuffer.trigger('updateend');

  QUnit.equal(requests.length, 1, 'only the playlist request outstanding');
  clock.tick(10 * 1000);
  QUnit.equal(requests.length, 1, 'delays segment fetching');

  standardXHRResponse(requests.shift()); // media3
  clock.tick(10 * 1000);
  QUnit.equal(requests.length, 1, 'resumes segment fetching');
});
