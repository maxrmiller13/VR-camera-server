const io = require("socket.io-client");

const socket = io("https://localhost:3000", {
    rejectUnauthorized: false,
    transports: ["websocket"]
});

socket.on("connect", () => {
    console.log("CONNECTED", socket.id);
    socket.emit("cameraSender");
});

socket.on("connect_error", err => {
    console.log("CONNECT ERROR");
    console.log(err.message);
});

socket.on("disconnect", reason => {
    console.log("DISCONNECTED", reason);
});