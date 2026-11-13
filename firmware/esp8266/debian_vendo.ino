#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>

// Change the WiFi credentials and fleet provisioning key once, then use the
// same binary for every ESP at this site. The controller is discovered from
// the DHCP gateway automatically. Set SERVER_BASE_OVERRIDE only for unusual
// routed deployments.
const char *WIFI_SSID = "VendoOS-WiFi";
const char *WIFI_PASSWORD = "";
const char *SERVER_BASE_OVERRIDE = "";
const char *PROVISION_KEY = "CHANGE-ME-FROM-VENDO-ENV";

const uint8_t COIN_PIN = D4;       // GPIO2, active-low isolated pulse
const uint8_t ENABLE_PIN = D8;     // GPIO15, active-high driver; must stay low at boot
const uint32_t HEARTBEAT_MS = 15000;
const uint32_t HEARTBEAT_FAIL_CLOSED_MS = 30000;
const uint32_t DEBOUNCE_US = 35000;
const uint16_t VALUE_PER_PULSE_CENTAVOS = 100;

volatile uint16_t pendingPulses = 0;
volatile uint32_t lastInterruptUs = 0;
String hardwareId;
String deviceToken;
String serverBase;
uint32_t lastHeartbeatAttempt = 0;
uint32_t lastHeartbeatSuccess = 0;
uint32_t pulseSequence = 0;
String bootId;
String currentPulseId;
bool slotEnabled = false;

IRAM_ATTR void onCoinPulse() {
  const uint32_t now = micros();
  if (now - lastInterruptUs >= DEBOUNCE_US) {
    if (pendingPulses < 1000) pendingPulses++;
    lastInterruptUs = now;
  }
}

void setSlot(bool enabled) {
  slotEnabled = enabled;
  digitalWrite(ENABLE_PIN, enabled ? HIGH : LOW);
}

String postJson(const String &route, const String &body, bool authenticated, int &status) {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, serverBase + route)) { status = -1; return ""; }
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  if (authenticated) {
    http.addHeader("X-Vendo-Device", hardwareId);
    http.addHeader("Authorization", "Bearer " + deviceToken);
  }
  status = http.POST(body);
  String response = status > 0 ? http.getString() : "";
  http.end();
  return response;
}

void saveToken() {
  File file = LittleFS.open("/token.txt", "w");
  if (file) { file.print(deviceToken); file.close(); }
}

void loadToken() {
  if (!LittleFS.exists("/token.txt")) return;
  File file = LittleFS.open("/token.txt", "r");
  if (file) { deviceToken = file.readString(); deviceToken.trim(); file.close(); }
}

bool provision() {
  JsonDocument request;
  request["hardware_id"] = hardwareId;
  request["name"] = String("Vendo ") + hardwareId.substring(hardwareId.length() - 6);
  request["coin_pin"] = 2;
  request["enable_pin"] = 15;
  String body; serializeJson(request, body);

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, serverBase + "/api/device/provision")) return false;
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Provision-Key", PROVISION_KEY);
  int status = http.POST(body);
  String response = status > 0 ? http.getString() : "";
  http.end();
  if (status != 200) return false;
  JsonDocument result;
  if (deserializeJson(result, response)) return false;
  deviceToken = result["token"].as<String>();
  if (deviceToken.length() < 20) return false;
  saveToken();
  return true;
}

bool heartbeat() {
  JsonDocument request;
  request["firmware_version"] = "0.1.0-esp8266";
  String body; serializeJson(request, body);
  int status;
  String response = postJson("/api/device/heartbeat", body, true, status);
  if (status == 401) { deviceToken = ""; LittleFS.remove("/token.txt"); return false; }
  if (status != 200) return false;
  JsonDocument result;
  if (deserializeJson(result, response)) return false;
  setSlot(result["coin_slot_enabled"] | false);
  JsonArray commands = result["commands"].as<JsonArray>();
  for (JsonObject command : commands) {
    const String action = command["command"].as<String>();
    const uint32_t commandId = command["id"] | 0;
    JsonDocument ack;
    ack["firmware_version"] = "0.1.0-esp8266";
    ack["ack_command_ids"].to<JsonArray>().add(commandId);
    String ackBody; serializeJson(ack, ackBody);
    int ackStatus; postJson("/api/device/heartbeat", ackBody, true, ackStatus);
    if (action == "restart") { delay(100); ESP.restart(); }
  }
  lastHeartbeatSuccess = millis();
  return true;
}

bool sendPulse() {
  if (currentPulseId.length() == 0) currentPulseId = bootId + "-" + String(pulseSequence++);
  JsonDocument request;
  request["pulse_id"] = currentPulseId;
  request["value_centavos"] = VALUE_PER_PULSE_CENTAVOS;
  String body; serializeJson(request, body);
  int status;
  postJson("/api/device/pulse", body, true, status);
  if (status == 409) setSlot(false);
  return status == 200;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  setSlot(false);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    if (strlen(SERVER_BASE_OVERRIDE)) serverBase = SERVER_BASE_OVERRIDE;
    else serverBase = String("http://") + WiFi.gatewayIP().toString() + ":3080";
  }
}

void setup() {
  pinMode(ENABLE_PIN, OUTPUT);
  setSlot(false);
  pinMode(COIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);
  Serial.begin(115200);
  LittleFS.begin();
  hardwareId = String("ESP8266-") + String(ESP.getChipId(), HEX);
  hardwareId.toUpperCase();
  bootId = String(ESP.getChipId(), HEX) + "-" + String(ESP.random(), HEX);
  Serial.println();
  Serial.println(String("Vendo ID: ") + hardwareId);
  loadToken();
  connectWiFi();
  Serial.println(String("Controller: ") + serverBase);
  if (WiFi.status() == WL_CONNECTED && deviceToken.length() < 20) provision();
  heartbeat();
}

void loop() {
  connectWiFi();
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED && deviceToken.length() < 20) provision();
  if (WiFi.status() == WL_CONNECTED && now - lastHeartbeatAttempt >= HEARTBEAT_MS) {
    lastHeartbeatAttempt = now;
    heartbeat();
  }
  if (now - lastHeartbeatSuccess > HEARTBEAT_FAIL_CLOSED_MS) setSlot(false);

  noInterrupts();
  bool hasPulse = pendingPulses > 0;
  interrupts();
  if (hasPulse) {
    if (slotEnabled && WiFi.status() == WL_CONNECTED && sendPulse()) {
      noInterrupts();
      if (pendingPulses > 0) pendingPulses--;
      interrupts();
      currentPulseId = "";
    } else if (!slotEnabled) {
      noInterrupts(); pendingPulses = 0; interrupts();
    } else delay(250);
  }
  delay(5);
}
