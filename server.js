// ─────────────────────────────────────────────────────────────────
// server.js
//
// One process, two jobs:
//   1. Serve the viewer page (viewer.html, viewer_connection.js, janus.js,
//      adapter.js, vr.js) over HTTPS from ./public.
//   2. Keep a GStreamer pipeline alive that captures the Pi camera, encodes
//      to H.264, and pushes RTP to the Janus mountpoint defined in
//      janus.plugin.streaming.jcfg.
//
// Janus itself still runs as its own separate process (`/opt/janus/bin/janus`)
// — it owns all WebRTC signaling/ICE/SRTP and is not something this script
// manages.
//
// Run:
//   JANUS_HOST=127.0.0.1 JANUS_RTP_PORT=5004 node server.js
// ─────────────────────────────────────────────────────────────────

const express = require("express");
const https = require("https");
const fs = require("fs");
const { spawn } = require("child_process");
const { Server } = require("socket.io");

// ───────────────────────── Web server ─────────────────────────

const httpsOptions = {
    key: fs.readFileSync("key.pem"),
    cert: fs.readFileSync("cert.pem")
};

const app = express();
app.use(express.static("public"));

const server = https.createServer(httpsOptions, app);

const io = new Server(server);

server.listen(3000, () => {
    console.log("[HTTP] Viewer page available at https://localhost:3000");
});

// ───────────────────────── Camera → Janus pipeline ─────────────────────────
//
// Requires (run once on the Pi):
//   sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
//     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
//     gstreamer1.0-plugins-ugly gstreamer1.0-libcamera

// Must match the `videoport` of the mountpoint in janus.plugin.streaming.jcfg.
// If Janus runs on a different machine than the camera, point JANUS_HOST at it.
const JANUS_HOST = process.env.JANUS_HOST || "127.0.0.1";
const JANUS_RTP_PORT = Number(process.env.JANUS_RTP_PORT) || 5004;

function buildPipeline() {
    return [
        "libcamerasrc",
        // libcamera's own docs note that to avoid negotiation failures you
        // must specify format and colorimetry together with width/height/
        // framerate in a single caps filter right after libcamerasrc —
        // resolution alone (even a resolution the sensor natively supports)
        // is not enough info for it to settle on a working configuration.
        "!", "video/x-raw,format=NV12,width=1280,height=720,framerate=30/1,colorimetry=bt709",
        "!", "videoconvert",
        "!", "x264enc",
              "tune=zerolatency",
              "bitrate=1500",
              "speed-preset=superfast",
              "key-int-max=30",
        "!", "video/x-h264,profile=constrained-baseline",
        "!", "h264parse", "config-interval=1",
        "!", "rtph264pay", "pt=96", "config-interval=1",
        "!", "udpsink", `host=${JANUS_HOST}`, `port=${JANUS_RTP_PORT}`
    ];
}

// If software x264enc is too slow on the Pi 5, swap buildPipeline()'s
// encoder block for the hardware encoder instead:
//
//   "!", "v4l2convert",
//   "!", "v4l2h264enc", "extra-controls=controls,repeat_sequence_header=1,h264_i_frame_period=30",
//   "!", "video/x-h264,level=(string)4",
//   "!", "h264parse", "config-interval=1",
//   "!", "rtph264pay", "pt=96", "config-interval=1",
//   "!", "udpsink", `host=${JANUS_HOST}`, `port=${JANUS_RTP_PORT}`

let restartPending = false;

function startGStreamer() {
    const pipeline = buildPipeline();
    console.log("[GST] Launching: gst-launch-1.0 " + pipeline.join(" "));

    const gst = spawn("gst-launch-1.0", pipeline);
    console.log(`[GST] Started (pid ${gst.pid}) → rtp://${JANUS_HOST}:${JANUS_RTP_PORT}`);

    gst.stdout.on("data", d => process.stdout.write("[GST] " + d));
    gst.stderr.on("data", d => process.stderr.write("[GST] " + d));

    gst.on("error", err => {
        console.error("[GST] Failed to launch gst-launch-1.0:", err.message);
        console.error("[GST] Is the gstreamer1.0-tools package installed?");
    });

    gst.on("close", code => {
        console.warn(`[GST] Exited with code ${code} — restarting in 2s`);
        if (!restartPending) {
            restartPending = true;
            setTimeout(() => {
                restartPending = false;
                gstProcess = startGStreamer();
            }, 2000);
        }
    });

    return gst;
}

let gstProcess = startGStreamer();

process.on("SIGINT", () => {
    console.log("\n[Server] Shutting down");
    if (gstProcess) gstProcess.kill();
    process.exit(0);
});

const { SerialPort } = require('serialport');

const port = new SerialPort({
    path: '/dev/ttyACM0',
    baudRate: 115200
});

io.on('connection', (socket) => {

    console.log('Client connected');

    socket.on("headTracking", (data) => {

    const msg = `${data.yaw.toFixed(1)},${data.pitch.toFixed(1)}\n`;

    console.log("SERIAL OUT:", msg.trim());

    port.write(msg, (err) => {
        if (err) console.error("Serial write error:", err);
    });
});

});