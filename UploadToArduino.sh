#!/bin/bash

SKETCH="/home/admin/VR-camera-server/ac"

arduino-cli compile --fqbn arduino:avr:uno "$SKETCH"

if [ $? -eq 0 ]; then
    arduino-cli upload -p /dev/ttyACM0 --fqbn arduino:avr:uno "$SKETCH"
fi

echo "Done."
read -p "Press Enter to close..."