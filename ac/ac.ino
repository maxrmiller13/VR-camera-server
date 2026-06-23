#include <Servo.h>

Servo panServo;
Servo tiltServo;

String input = "";

void setup() {
    Serial.begin(115200);

    panServo.attach(9);
    tiltServo.attach(10);

    Serial.println("READY");
}

void loop() {

    while (Serial.available()) {
        char c = Serial.read();

        if (c == '\n') {
            parseLine(input);
            input = "";
        } else if (c != '\r') {
            input += c;
        }
    }
}

void parseLine(String line) {

    Serial.print("RAW: ");
    Serial.println(line);

    int commaIndex = line.indexOf(',');

    if (commaIndex == -1) {
        Serial.println("PARSE FAIL (no comma)");
        return;
    }

    String yawStr = line.substring(0, commaIndex);
    String pitchStr = line.substring(commaIndex + 1);

    float yaw = yawStr.toFloat();
    float pitch = pitchStr.toFloat();

    Serial.print("YAW: ");
    Serial.print(yaw);
    Serial.print(" PITCH: ");
    Serial.println(pitch);

    int pan = constrain(90 + yaw, 0, 180);
    int tilt = constrain(90 - pitch, 0, 180);

    Serial.print("PAN: ");
    Serial.print(pan);
    Serial.print(" TILT: ");
    Serial.println(tilt);

    panServo.write(pan);
    tiltServo.write(tilt);
}