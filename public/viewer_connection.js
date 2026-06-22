// ─────────────────────────────────────────────────────────────────
// viewer_connection.js
//
// Talks directly to Janus's "streaming" plugin to watch the mountpoint
// defined in janus.plugin.streaming.jcfg (id: 1, the Pi camera feed).
// Janus handles all SDP/ICE/SRTP negotiation — this file just drives the
// Janus JS client through: attach plugin → send "watch" → get JSEP offer
// → createAnswer → send "start".
//
// Requires janus.js + adapter.js to be loaded on the page before this file.
// ─────────────────────────────────────────────────────────────────

const MOUNTPOINT_ID = 1; // must match `id` in janus.plugin.streaming.jcfg

// Janus's own HTTPS REST endpoint. By default Janus's HTTP transport
// listens on 8089 for HTTPS (see janus.transport.http.jcfg). Janus is
// assumed to be reachable at the same host that served this page.
const JANUS_SERVER = `https://${window.location.hostname}:8089/janus`;

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
video.muted = true;

function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
    console.log("[Viewer]", text);
}

let janus = null;
let streamingHandle = null;
const opaqueId = "viewer-" + Janus.randomString(12);

Janus.init({
    debug: "default",
    callback: () => {
        setStatus("connecting to Janus…");

        janus = new Janus({
            server: JANUS_SERVER,
            success: attachStreamingPlugin,
            error: (err) => setStatus("Janus connection error: " + err),
            destroyed: () => setStatus("Janus session destroyed")
        });
    }
});

function attachStreamingPlugin() {
    janus.attach({
        plugin: "janus.plugin.streaming",
        opaqueId: opaqueId,

        success: (pluginHandle) => {
            streamingHandle = pluginHandle;
            setStatus("attached — requesting stream…");
            streamingHandle.send({ message: { request: "watch", id: MOUNTPOINT_ID } });
        },

        error: (err) => setStatus("Plugin attach error: " + err),

        // Messages from the streaming plugin: status updates and, most
        // importantly, the JSEP offer that kicks off WebRTC negotiation.
        onmessage: (msg, jsep) => {
            const result = msg["result"];
            if (result && result["status"]) {
                setStatus("stream status: " + result["status"]);
            }
            if (msg["error"]) {
                setStatus("Streaming plugin error: " + msg["error"]);
                return;
            }

            if (jsep) {
                streamingHandle.createAnswer({
                    jsep: jsep,
                    // We only receive video — no media of our own to send.
                    tracks: [{ type: "video", recv: true }],
                    success: (answerJsep) => {
                        streamingHandle.send({
                            message: { request: "start" },
                            jsep: answerJsep
                        });
                    },
                    error: (err) => setStatus("createAnswer error: " + err)
                });
            }
        },

        // Fired once per incoming media track once negotiation completes.
        onremotetrack: (track, mid, added) => {
            if (!added) return;
            if (track.kind === "video") {
                setStatus("video track received");
                const stream = new MediaStream([track]);
                video.srcObject = stream;

                // Some browsers won't auto-start playback just because
                // srcObject was assigned after page load, even when muted.
                video.play().catch(err => setStatus("play() blocked: " + err.message));

                video.onloadedmetadata = () => {
                    setStatus(`metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
                };

                // If dimensions never come through, frames aren't decoding —
                // check Janus's log / chrome://webrtc-internals next.
                setTimeout(() => {
                    if (video.videoWidth === 0) {
                        setStatus("WARNING: no video frames decoded after 5s — check Janus mountpoint / RTP feed");
                    }
                }, 5000);
            }
        },

        oncleanup: () => {
            setStatus("stream stopped");
            video.srcObject = null;
        },

        ondataopen: () => console.log("[Viewer] Data channel open"),
        ondata: (data) => console.log("[Viewer] Pi says:", data)
    });
}