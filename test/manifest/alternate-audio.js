{
  allowCache: true,
  discontinuityStarts: [],
  mediaGroups: {
    // TYPE
    AUDIO: {
      // GROUP-ID
      "audio": {
        // NAME
        "English": {
          language: 'eng',
          autoselect: true,
          default: true,
          uri: "eng/prog_index.m3u8"
        },
        // NAME
        "Français": {
          language: "fre",
          autoselect: true,
          default: false,
          uri: "fre/prog_index.m3u8"
        },
        // NAME
        "Espanol": {
          language: "sp",
          autoselect: true,
          default: false,
          uri: "sp/prog_index.m3u8"
        }
      }
    },
    VIDEO: {},
    "CLOSED-CAPTIONS": {},
    SUBTITLES: {}
  },
  playlists: [{
    attributes: {
      "PROGRAM-ID": 1,
      BANDWIDTH: 195023,
      CODECS: "avc1.42e00a,mp4a.40.2"
    },
    uri: "lo/media.m3u8"
  }, {
    attributes: {
      "PROGRAM-ID": 1,
      BANDWIDTH: 591680,
      CODECS: "avc1.42e01e,mp4a.40.2",
      AUDIO: 'audio'
    },
    uri: "hi/media1.m3u8"
  }]
}
