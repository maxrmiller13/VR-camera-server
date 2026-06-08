const io = require("socket.io-client");
const dc = require("node-datachannel");
const dgram = require("dgram");
const { spawn } = require("child_process");

const SIGNAL_URL = process.env.SIGNAL_URL || "https://localhost:3000";
const RTP_HOST = process.env.RTP_HOST || "127.0.0.1";
const RTP_PORT = Number(process.env.RTP_PORT || 5004);
const VIDEO_WIDTH = Number(process.env.VIDEO_WIDTH || 1280);
const VIDEO_HEIGHT = Number(process.env.VIDEO_HEIGHT || 720);
const VIDEO_FPS = Number(process.env.VIDEO_FPS || 30);
const VIDEO_BITRATE_KBPS = Number(process.env.VIDEO_BITRATE_KBPS || 1000);
const CAMERA_FORMAT = process.env.CAMERA_FORMAT || "NV12";
const ENCODER_INPUT_FORMAT = process.env.ENCODER_INPUT_FORMAT || "I420";
const RTP_PAYLOAD_TYPE = Number(process.env.RTP_PAYLOAD_TYPE || 96);
const GST_RESTART_DELAY_MS = 2000;
const STATS_INTERVAL_MS = 5000;

const peers = {};       // socketId -> PeerConnection
const videoTracks = {}; // socketId -> Track
let gstProcess = null;
let stopping = false;
let packetCount = 0;
let byteCount = 0;
let droppedPackets = 0;
let lastPacketCount = 0;
let lastByteCount = 0;

function log(level, scope, ...args) {
    const stamp = new Date().toISOString();
    const line = `[${stamp}] [${scope}]`;
    if (level === "error") {
        console.error(line, ...args);
    } else if (level === "warn") {
        console.warn(line, ...args);
    } else {
        console.log(line, ...args);
    }
}

function errorDetails(err) {
    return err && err.stack ? err.stack : err;
}

process.on("uncaughtException", err => {
    log("error", "Process", "Uncaught exception:", errorDetails(err));
});

process.on("unhandledRejection", err => {
    log("error", "Process", "Unhandled rejection:", errorDetails(err));
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log("info", "Config", `signal=${SIGNAL_URL}`, `rtp=${RTP_HOST}:${RTP_PORT}`, `video=${VIDEO_WIDTH}x${VIDEO_HEIGHT}@${VIDEO_FPS}`, `cameraFormat=${CAMERA_FORMAT}`, `encoderInput=${ENCODER_INPUT_FORMAT}`, `bitrate=${VIDEO_BITRATE_KBPS}kbps`, `pt=${RTP_PAYLOAD_TYPE}`);

try {
    dc.initLogger("Warn", (level, message) => log("warn", "node-datachannel", `[${level}] ${message}`));
    log("info", "node-datachannel", `libdatachannel ${dc.getLibraryVersion()}`);
} catch (err) {
    log("warn", "node-datachannel", "Logger initialization failed:", errorDetails(err));
}

// ─────────────────────────────────────────────────────────────────
// 1. GStreamer — Pi camera → H264 → RTP → UDP localhost
//
//    Requires (run once):
//      sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
//        gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
//        gstreamer1.0-plugins-ugly gstreamer1.0-libcamera
// ─────────────────────────────────────────────────────────────────
function buildGStreamerPipeline() {
    return [
        "libcamerasrc",
        // Do not force width/height directly on libcamerasrc. Some Pi cameras
        // validate 1280x720 to a native sensor mode (for example 1536x864), and
        // keeping the requested size in the source caps can then fail with
        // reason not-negotiated (-4). Force a processed YUV format at the
        // camera boundary, then scale/convert downstream for the encoder.
        "!", `video/x-raw,format=${CAMERA_FORMAT},framerate=${VIDEO_FPS}/1`,
        "!", "queue", "leaky=downstream", "max-size-buffers=2",
        "!", "videoscale",
        "!", "videoconvert",
        "!", `video/x-raw,format=${ENCODER_INPUT_FORMAT},width=${VIDEO_WIDTH},height=${VIDEO_HEIGHT},framerate=${VIDEO_FPS}/1`,
        "!", "x264enc",
              "tune=zerolatency",
              `bitrate=${VIDEO_BITRATE_KBPS}`,
              "speed-preset=superfast",
              `key-int-max=${VIDEO_FPS}`,
              "byte-stream=true",
        "!", "h264parse", "config-interval=1",
        "!", "video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au",
        "!", "rtph264pay", "config-interval=1", `pt=${RTP_PAYLOAD_TYPE}`,
        "!", "udpsink", `host=${RTP_HOST}`, `port=${RTP_PORT}`, "sync=false", "async=false"
    ];
}

function startGStreamer() {
    if (stopping || gstProcess) return;

    const pipeline = buildGStreamerPipeline();
    log("info", "GST", "Starting:", `gst-launch-1.0 ${pipeline.join(" ")}`);

    gstProcess = spawn("gst-launch-1.0", pipeline, {
        stdio: ["ignore", "pipe", "pipe"]
    });

    gstProcess.on("spawn", () => log("info", "GST", `Started pid=${gstProcess.pid}`));
    gstProcess.stdout.on("data", d => process.stdout.write(`[${new Date().toISOString()}] [GST:stdout] ${d}`));
    gstProcess.stderr.on("data", d => process.stderr.write(`[${new Date().toISOString()}] [GST:stderr] ${d}`));

    gstProcess.on("error", err => {
        log("error", "GST", "Failed to start gst-launch-1.0. Is GStreamer installed?", errorDetails(err));
    });

    gstProcess.on("close", (code, signal) => {
        gstProcess = null;
        if (stopping) return;
        log("warn", "GST", `Exited code=${code} signal=${signal}; restarting in ${GST_RESTART_DELAY_MS}ms`);
        setTimeout(startGStreamer, GST_RESTART_DELAY_MS);
    });
}

// ─────────────────────────────────────────────────────────────────
// 2. UDP — receive RTP packets from GStreamer and fan-out to viewers
// ─────────────────────────────────────────────────────────────────
const udp = dgram.createSocket("udp4");

udp.on("error", err => log("error", "UDP", "Socket error:", errorDetails(err)));

udp.on("message", (rtpPacket) => {
    packetCount += 1;
    byteCount += rtpPacket.length;

    for (const [id, track] of Object.entries(videoTracks)) {
        try {
            if (track.isOpen()) {
                const sent = track.sendMessageBinary(rtpPacket);
                if (!sent) {
                    droppedPackets += 1;
                    log("warn", "Track", `Backpressure/drop sending RTP packet to viewer ${id}; buffered=${track.bufferedAmount()}`);
                }
            }
        } catch (err) {
            droppedPackets += 1;
            log("error", "Track", `Failed sending RTP packet to viewer ${id}:`, errorDetails(err));
        }
    }
});

udp.bind(RTP_PORT, RTP_HOST, () => {
    log("info", "UDP", `RTP listener ready on ${RTP_HOST}:${RTP_PORT}`);
    startGStreamer();
});

setInterval(() => {
    const packets = packetCount - lastPacketCount;
    const bytes = byteCount - lastByteCount;
    lastPacketCount = packetCount;
    lastByteCount = byteCount;

    log(
        "info",
        "Stats",
        `viewers=${Object.keys(peers).length}`,
        `openTracks=${Object.values(videoTracks).filter(track => track.isOpen()).length}`,
        `rtpPackets=${packetCount}`,
        `rtpBytes=${byteCount}`,
        `last${STATS_INTERVAL_MS / 1000}s=${packets}pkts/${bytes}B`,
        `drops=${droppedPackets}`
    );
}, STATS_INTERVAL_MS).unref();

// ─────────────────────────────────────────────────────────────────
// 3. Socket.IO — connect to the signaling server on this Pi
// ─────────────────────────────────────────────────────────────────
const socket = io(SIGNAL_URL, {
    rejectUnauthorized: false, // allow self-signed cert
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

socket.on("connect", () => {
    log("info", "Signal", `Connected id=${socket.id}`);
    socket.emit("cameraSender");
});

socket.on("connect_error", err => log("error", "Signal", "Connect error:", err.message));
socket.on("disconnect", reason => log("warn", "Signal", `Disconnected: ${reason}`));
socket.io.on("reconnect_attempt", attempt => log("info", "Signal", `Reconnect attempt ${attempt}`));
socket.io.on("reconnect", attempt => log("info", "Signal", `Reconnected after ${attempt} attempt(s)`));

// SDP answer arriving from a viewer
socket.on("answer", (id, description) => {
    const pc = peers[id];
    if (!pc) {
        log("warn", "Signal", `Answer for unknown viewer ${id}`);
        return;
    }
    if (!description || !description.sdp || !description.type) {
        log("warn", "Signal", `Malformed answer from viewer ${id}:`, description);
        return;
    }

    try {
        pc.setRemoteDescription(description.sdp, description.type);
        log("info", "Signal", `Remote description set for viewer ${id} type=${description.type}`);
    } catch (err) {
        log("error", "Signal", `setRemoteDescription failed for viewer ${id}:`, errorDetails(err));
    }
});

// ICE candidate arriving from a viewer
socket.on("candidate", (id, candidate) => {
    const pc = peers[id];
    if (!pc) {
        log("warn", "Signal", `Candidate for unknown viewer ${id}`);
        return;
    }
    if (!candidate || !candidate.candidate) {
        log("warn", "Signal", `Malformed candidate from viewer ${id}:`, candidate);
        return;
    }

    try {
        pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || "video");
        log("info", "ICE", `Added remote candidate for viewer ${id} mid=${candidate.sdpMid || "video"}`);
    } catch (err) {
        log("error", "ICE", `addRemoteCandidate failed for viewer ${id}:`, errorDetails(err));
    }
});

// A new viewer connected — create a peer connection with a video track
socket.on("viewer", (id) => {
    log("info", "WebRTC", `New viewer ${id}`);

    cleanup(id, false);

    let pc;
    try {
        pc = new dc.PeerConnection(`viewer-${id}`, {
            iceServers: ["stun:stun.l.google.com:19302"]
        });
        peers[id] = pc;

        // node-datachannel expects a Video media description, not browser-style
        // addTrack(kind, direction, codecs) arguments.
        const media = new dc.Video("video", "SendOnly");
        media.addH264Codec(RTP_PAYLOAD_TYPE);
        media.addSSRC(randomSsrc(), "camera", "camera-stream", "camera-video");
        media.setBitrate(VIDEO_BITRATE_KBPS * 1000);

        const track = pc.addTrack(media);
        videoTracks[id] = track;

        track.onOpen(() => log("info", "Track", `Open for viewer ${id}`));
        track.onClosed(() => {
            log("info", "Track", `Closed for viewer ${id}`);
            delete videoTracks[id];
        });
        track.onError(err => log("error", "Track", `Error for viewer ${id}:`, err));

        pc.onLocalDescription((sdp, type) => {
            log("info", "WebRTC", `Sending ${type} to viewer ${id}`);
            socket.emit("offer", id, { sdp, type });
        });

        pc.onLocalCandidate((candidate, mid) => {
            log("info", "ICE", `Local candidate for viewer ${id} mid=${mid}`);
            socket.emit("candidate", id, { candidate, sdpMid: mid });
        });

        pc.onStateChange(state => {
            log("info", "WebRTC", `Peer ${id} state=${state}`);
            if (state === "closed" || state === "failed" || state === "disconnected") {
                cleanup(id);
            }
        });

        pc.onIceStateChange(state => log("info", "ICE", `Peer ${id} state=${state}`));
        pc.onSignalingStateChange(state => log("info", "Signal", `Peer ${id} signaling=${state}`));
        pc.onGatheringStateChange(state => log("info", "ICE", `Peer ${id} gathering=${state}`));

        // Generate the SDP offer (video track is included automatically).
        pc.setLocalDescription("offer");
    } catch (err) {
        log("error", "WebRTC", `Failed creating peer for viewer ${id}:`, errorDetails(err));
        cleanup(id);
    }
});

socket.on("disconnectPeer", id => cleanup(id));

function randomSsrc() {
    // Keep within uint32 and avoid zero.
    return Math.floor(Math.random() * 0xffffffff) || 1;
}

function cleanup(id, logIfMissing = true) {
    const pc = peers[id];
    const track = videoTracks[id];

    if (!pc && !track) {
        if (logIfMissing) log("warn", "WebRTC", `Cleanup requested for unknown peer ${id}`);
        return;
    }

    if (track) {
        try { track.close(); } catch (err) { log("warn", "Track", `Track close failed for ${id}:`, errorDetails(err)); }
        delete videoTracks[id];
    }

    if (pc) {
        try { pc.close(); } catch (err) { log("warn", "WebRTC", `Peer close failed for ${id}:`, errorDetails(err)); }
        delete peers[id];
    }

    log("info", "WebRTC", `Cleaned up peer ${id}`);
}

function shutdown() {
    if (stopping) return;
    stopping = true;
    log("info", "Process", "Shutting down");

    for (const id of Object.keys(peers)) {
        cleanup(id, false);
    }

    if (gstProcess) {
        gstProcess.kill("SIGTERM");
        gstProcess = null;
    }

    udp.close(() => log("info", "UDP", "Socket closed"));
    socket.close();

    try {
        dc.cleanup();
    } catch (err) {
        log("warn", "node-datachannel", "Cleanup failed:", errorDetails(err));
    }

    setTimeout(() => process.exit(0), 200).unref();
}
