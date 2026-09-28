// TruFLAC module for BitChord (QuickJS sandbox).
// FLAC-first: tracks.monochrome.st is always tried first.
// Piped is ONLY used when the monochrome search fails or returns nothing.
//
// Exports required by BitChord's ModuleSource:
//   searchTracks(query, limit, context) -> { tracks: [...], total: n }
//   getTrackStreamUrl(trackId, preferredQuality, context) -> { streamUrl, track }

var MONO_BASE = "https://tracks.monochrome.st";
var PIPED_BASE = "https://api.piped.video";

function enc(s) {
  return encodeURIComponent(String(s === undefined || s === null ? "" : s));
}

function toSec(ms) {
  var s = Math.round((Number(ms) || 0) / 1000);
  return s > 0 ? s : 0;
}

// ---- primary: monochrome lossless search ----

async function searchMono(query, limit) {
  var res = await fetch(MONO_BASE + "/search?q=" + enc(query));
  if (!res.ok) throw new Error("mono search HTTP " + res.status);
  var data = await res.json();
  var rows = (data && data.tracks && data.tracks.length ? data.tracks : data.topResults) || [];
  var out = [];
  for (var i = 0; i < rows.length && out.length < limit; i++) {
    var t = rows[i] || {};
    var id = String(t.id || t.trackId || "");
    if (!id) continue;
    var artists = t.artistNames || t.artists || [];
    out.push({
      id: id,
      title: t.title || "Unknown title",
      artist: Array.isArray(artists) ? artists.join(", ") : String(artists || ""),
      album: t.album || "",
      albumCover: t.artwork || t.artworkURL || null,
      duration: toSec(t.duration),
      trackNumber: 0,
      audioQuality: "LOSSLESS",
      format: "flac",
      availableQualities: ["LOSSLESS"]
    });
  }
  return out;
}

// ---- fallback: piped search (only on primary failure) ----

function pipedVideoId(url) {
  var m = /[?&]v=([^&]+)/.exec(String(url || ""));
  return m ? m[1] : null;
}

async function searchPiped(query, limit) {
  var res = await fetch(PIPED_BASE + "/search?q=" + enc(query) + "&filter=music_songs");
  if (!res.ok) throw new Error("piped search HTTP " + res.status);
  var data = await res.json();
  var items = (data && data.items) || (Array.isArray(data) ? data : []);
  var out = [];
  for (var i = 0; i < items.length && out.length < limit; i++) {
    var it = items[i] || {};
    var vid = pipedVideoId(it.url) || it.videoId || it.id;
    if (!vid || String(vid).indexOf("/") >= 0) continue;
    out.push({
      id: "piped:" + vid,
      title: it.title || "Unknown title",
      artist: it.uploaderName || it.uploader || it.artist || "",
      album: "",
      albumCover: it.thumbnail || null,
      duration: Number(it.duration) > 0 ? Number(it.duration) : 0,
      trackNumber: 0,
      audioQuality: "HIGH",
      format: "",
      availableQualities: ["HIGH"]
    });
  }
  return out;
}

async function searchTracks(query, limit, context) {
  limit = Number(limit) > 0 ? Number(limit) : 25;
  try {
    var mono = await searchMono(query, limit);
    if (mono.length > 0) return { tracks: mono, total: mono.length };
    console.log("truflac: mono empty, falling back to piped");
  } catch (e) {
    console.log("truflac: mono search failed (" + (e && e.message) + "), falling back to piped");
  }
  try {
    var piped = await searchPiped(query, limit);
    return { tracks: piped, total: piped.length };
  } catch (e2) {
    console.log("truflac: piped fallback failed (" + (e2 && e2.message) + ")");
    return { tracks: [], total: 0 };
  }
}

// ---- streams ----

async function monoStream(trackId) {
  var url = MONO_BASE + "/track/" + enc(trackId);
  // Range probe: confirm the FLAC is actually there before handing the URL out.
  var probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
  if (probe.ok || probe.status === 206) {
    return {
      streamUrl: url,
      track: { id: trackId, audioQuality: "LOSSLESS", mimeType: "audio/flac" }
    };
  }
  console.log("truflac: mono stream probe HTTP " + probe.status + " for " + trackId);
  return { streamUrl: null };
}

async function pipedStream(videoId) {
  var res = await fetch(PIPED_BASE + "/streams/" + enc(videoId));
  if (!res.ok) return { streamUrl: null };
  var data = await res.json();
  var audios = (data && (data.audioStreams || data.audio_streams)) || [];
  var best = null;
  for (var i = 0; i < audios.length; i++) {
    var a = audios[i] || {};
    if (!a.url) continue;
    if (!best || (Number(a.bitrate) || 0) > (Number(best.bitrate) || 0)) best = a;
  }
  if (!best) return { streamUrl: null };
  return {
    streamUrl: best.url,
    track: {
      id: videoId,
      audioQuality: "HIGH",
      mimeType: best.mimeType || null,
      bitrate: Number(best.bitrate) || null
    }
  };
}

async function getTrackStreamUrl(trackId, preferredQuality, context) {
  trackId = String(trackId === undefined || trackId === null ? "" : trackId);
  if (trackId.indexOf("piped:") === 0) {
    return await pipedStream(trackId.slice("piped:".length));
  }
  try {
    return await monoStream(trackId);
  } catch (e) {
    console.log("truflac: mono stream failed (" + (e && e.message) + ")");
    return { streamUrl: null };
  }
}

module.exports = {
  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
