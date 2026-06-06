const io = require("socket.io-client");

const socket = io("http://localhost:3000");

socket.on("connect", () => {
    console.log("Connected:", socket.id);

    socket.emit("cameraSender");
});

socket.on("viewer", id => {
    console.log("Viewer connected:", id);
});