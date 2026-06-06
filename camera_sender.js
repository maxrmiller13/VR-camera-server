const io = require("socket.io-client");
const dc = require("node-datachannel");

const socket = io("https://localhost:3000", {
    rejectUnauthorized: false,
    transports: ["websocket"]
});

const peers = {};

socket.on("connect", () => {
    console.log("CONNECTED", socket.id);
    socket.emit("cameraSender");
});

// Handle answers from viewers
socket.on("answer", (id, description) => {

    console.log("ANSWER FROM", id);

    const pc = peers[id];

    if (!pc) {
        console.log("No peer found for", id);
        return;
    }

    console.log("Setting remote description");

    try {
        pc.setRemoteDescription(
            description.sdp,
            description.type
        );
    } catch (err) {
        console.error("setRemoteDescription failed:", err);
    }
});

// Handle ICE candidates from viewers
socket.on("candidate", (id, candidate) => {

    console.log("CANDIDATE FROM", id);

    const pc = peers[id];

    if (!pc) {
        console.log("No peer found for", id);
        return;
    }

    try {
        pc.addRemoteCandidate(
            candidate.candidate,
            candidate.sdpMid
        );
    } catch (err) {
        console.error("addRemoteCandidate failed:", err);
    }
});

// Viewer connected
socket.on("viewer", id => {

    console.log("Viewer connected:", id);

    const pc = new dc.PeerConnection(
        "viewer-" + id,
        {
            iceServers: [
                "stun:stun.l.google.com:19302"
            ]
        }
    );

    peers[id] = pc;

    // Data channel test
    const channel = pc.createDataChannel("test");

    channel.onOpen(() => {

        console.log("DATA CHANNEL OPEN");

        setInterval(() => {
            channel.sendMessage(
                "hello from pi " + Date.now()
            );
        }, 1000);

    });

    channel.onClosed(() => {
        console.log("DATA CHANNEL CLOSED");
    });

    channel.onError(err => {
        console.error("DATA CHANNEL ERROR", err);
    });

    // SDP offer generation
    pc.onLocalDescription((sdp, type) => {

        console.log("Sending offer");

        socket.emit(
            "offer",
            id,
            {
                sdp,
                type
            }
        );
    });

    // ICE candidate generation
    pc.onLocalCandidate((candidate, mid) => {

        console.log("Sending candidate");

        socket.emit(
            "candidate",
            id,
            {
                candidate,
                sdpMid: mid
            }
        );
    });

    pc.onStateChange(state => {
        console.log("PC STATE:", state);
    });

    pc.onIceStateChange(state => {
        console.log("ICE STATE:", state);
    });

    console.log("Creating local description");

    pc.setLocalDescription();
});