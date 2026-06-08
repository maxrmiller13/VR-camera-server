const io = require("socket.io-client");
const dc = require("node-datachannel");
const dgram = require("dgram");
const { spawn } = require("child_process");

const SIGNAL_URL = "https://localhost:3000";
const RTP_PORT = 5004;

const peers = {};       // socketId -> PeerConnection
const videoTracks = {}; // socketId -> Track

// ─────────────────────────────────────────────────────────────────
// 1. GStreamer — Pi camera → H264 → RTP → UDP localhost
//
//    Requires (run once):
//      sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
//        gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
//        gstreamer1.0-plugins-ugly gstreamer1.0-libcamera
//
//    If x264enc is missing, swap the encoder block for the Pi 5 hardware
//    encoder instead:
//      "!", "v4l2convert",
//      "!", "v4l2h264enc", "extra-controls=controls,repeat_sequence_header=1",
//      "!", "video/x-h264,level=(string)4",
//      "!", "h264parse",
// ─────────────────────────────────────────────────────────────────
function startGStreamer() {
    const pipeline = [
        "libcamerasrc",
        "!", "video/x-raw,width=1280,height=720,framerate=30/1",
        "!", "videoconvert",
        "!", "x264enc",
              "tune=zerolatency",
              "bitrate=1000",
              "speed-preset=superfast",
              "key-int-max=30",
        "!", "video/x-h264,profile=constrained-baseline",
        "!", "rtph264pay", "config-interval=1", "pt=96",
        "!", "udpsink", "host=127.0.0.1", `port=${RTP_PORT}`
    ];

    const gst = spawn("gst-launch-1.0", pipeline);
    console.log(`[GST] Started (pid ${gst.pid})`);

    gst.stdout.on("data", d => process.stdout.write("[GST] " + d));
    gst.stderr.on("data", d => process.stderr.write("[GST] " + d));

    gst.on("close", code => {
        console.warn(`[GST] Exited with code ${code} — restarting in 2 s`);
        setTimeout(startGStreamer, 2000);
    });
}

// ─────────────────────────────────────────────────────────────────
// 2. UDP — receive RTP packets from GStreamer and fan-out to viewers
// ─────────────────────────────────────────────────────────────────
const udp = dgram.createSocket("udp4");

udp.on("error", err => console.error("[UDP] Error:", err));

udp.on("message", (rtpPacket) => {
    for (const [id, track] of Object.entries(videoTracks)) {
        try {
            if (track.isOpen()) {
                track.sendMessage(rtpPacket);
            }
        } catch (_) {
            // Peer may have just disconnected; ignore
        }
    }
});

udp.bind(RTP_PORT, "127.0.0.1", () => {
    console.log(`[UDP] RTP listener ready on port ${RTP_PORT}`);
    startGStreamer();
});

// ─────────────────────────────────────────────────────────────────
// 3. Socket.IO — connect to the signaling server on this Pi
// ─────────────────────────────────────────────────────────────────
const socket = io(SIGNAL_URL, {
    rejectUnauthorized: false, // allow self-signed cert
    transports: ["websocket"]
});

socket.on("connect", () => {
    console.log("[Signal] Connected:", socket.id);
    socket.emit("cameraSender");
});

socket.on("disconnect", () => console.warn("[Signal] Disconnected"));

// SDP answer arriving from a viewer
socket.on("answer", (id, description) => {
    const pc = peers[id];
    if (!pc) return;
    try {
        pc.setRemoteDescription(description.sdp, description.type);
        console.log("[Signal] Remote description set for", id);
    } catch (err) {
        console.error("[Signal] setRemoteDescription error:", err);
    }
});

// ICE candidate arriving from a viewer
socket.on("candidate", (id, candidate) => {
    const pc = peers[id];
    if (!pc) return;
    try {
        pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid);
    } catch (err) {
        console.error("[Signal] addRemoteCandidate error:", err);
    }
});

// A new viewer connected — create a peer connection with a video track
socket.on("viewer", (id) => {
    console.log("[WebRTC] New viewer:", id);

    const pc = new dc.PeerConnection("viewer-" + id, {
        iceServers: ["stun:stun.l.google.com:19302"]
    });
    peers[id] = pc;

    // Send-only H264 video track (payload type 96 must match rtph264pay pt=96)
    const track = pc.addTrack("video", "SendOnly", [
        {
            payloadType: 96,
            codecName: "H264",
            clockRate: 90000,
            // Constrained Baseline Profile Level 3.1 — widely supported
            sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
        }
    ]);
    videoTracks[id] = track;

    track.onOpen(() => console.log(`[Track] Open for viewer ${id}`));
    track.onClosed(() => {
        console.log(`[Track] Closed for viewer ${id}`);
        delete videoTracks[id];
    });
    track.onError(err => console.error(`[Track] Error for ${id}:`, err));

    pc.onLocalDescription((sdp, type) => {
        console.log("[WebRTC] Sending offer to", id);
        socket.emit("offer", id, { sdp, type });
    });

    pc.onLocalCandidate((candidate, mid) => {
        socket.emit("candidate", id, { candidate, sdpMid: mid });
    });

    pc.onStateChange(state => {
        console.log(`[WebRTC] Peer ${id} →`, state);
        if (state === "closed" || state === "failed" || state === "disconnected") {
            cleanup(id);
        }
    });

    pc.onIceStateChange(state => console.log(`[ICE] Peer ${id} →`, state));

    // Generate the SDP offer (video track is included automatically)
    pc.setLocalDescription();
});

socket.on("disconnectPeer", cleanup);

function cleanup(id) {
    if (peers[id]) {
        try { peers[id].close(); } catch (_) {}
        delete peers[id];
    }
    delete videoTracks[id];
    console.log("[WebRTC] Cleaned up peer", id);
}