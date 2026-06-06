const io = require("socket.io-client");
const dc = require("node-datachannel");

dc.initLogger("Info");

const socket = io("https://localhost:3000", {
    rejectUnauthorized: false,
    transports: ["websocket"]
});

const peers = {};

socket.on("connect", () => {
    console.log("CONNECTED", socket.id);
    socket.emit("cameraSender");
});

socket.on("viewer", id => {

    console.log("Viewer connected:", id);

    const pc = new dc.PeerConnection("viewer-" + id, {
        iceServers: ["stun:stun.l.google.com:19302"]
    });

    peers[id] = pc;

    const channel = pc.createDataChannel("test");

    channel.onOpen(() => {
        console.log("DATA CHANNEL OPEN");

        setInterval(() => {
            channel.sendMessage(
                "hello from pi " + Date.now()
            );
        }, 1000);
    });

    pc.onLocalDescription((sdp, type) => {
        console.log("Sending offer");
        socket.emit("offer", id, { sdp, type });
    });

    pc.onLocalCandidate((candidate, mid) => {
        socket.emit("candidate", id, {
            candidate,
            sdpMid: mid
        });
    });

    socket.on("answer", (answerId, description) => {

        if (answerId !== id) return;

        console.log("Received answer");

        pc.setRemoteDescription(
            description.sdp,
            description.type
        );
    });

    socket.on("candidate", (candidateId, candidate) => {

        if (candidateId !== id) return;

        pc.addRemoteCandidate(
            candidate.candidate,
            candidate.sdpMid
        );
    });

    pc.setLocalDescription();
});