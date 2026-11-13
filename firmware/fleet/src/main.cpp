#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <SHA256.h>
#if defined(VENDO_USE_W5500)
#include <Ethernet.h>
#include <Updater.h>
#elif defined(ESP8266)
#include <WiFiManager.h>
#include <Updater.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#define BOARD_NAME "ESP8266"
const uint8_t DEFAULT_COIN_PIN = D4;
const uint8_t DEFAULT_ENABLE_PIN = D8;
#else
#include <WiFiManager.h>
#include <Update.h>
#include <HTTPClient.h>
#include <WiFi.h>
#define BOARD_NAME "ESP32"
const uint8_t DEFAULT_COIN_PIN = 27;
const uint8_t DEFAULT_ENABLE_PIN = 26;
#endif

#if defined(VENDO_USE_W5500)
#define BOARD_NAME "ESP8266-W5500"
const uint8_t DEFAULT_COIN_PIN = D4;
const uint8_t DEFAULT_ENABLE_PIN = D8;
const uint8_t W5500_CS_PIN = D1;
const uint8_t W5500_RESET_PIN = D2;
#endif

#ifndef VENDO_PROVISION_KEY
#define VENDO_PROVISION_KEY "CHANGE-ME-FROM-VENDO-ENV"
#endif
#ifndef VENDO_FIRMWARE_VERSION
#define VENDO_FIRMWARE_VERSION "0.2.14"
#endif
#ifndef VENDO_DEFAULT_WIFI_SSID
#define VENDO_DEFAULT_WIFI_SSID "COMFAST_7E1D_2G"
#endif

// Coin-session state is delivered by heartbeat. Keep this short so pressing
// Insert Coin energizes the physical relay without a noticeable delay.
const uint32_t DEFAULT_HEARTBEAT_IDLE_MS = 3000;
const uint32_t DEFAULT_HEARTBEAT_ACTIVE_MS = 1500;
const uint32_t DEFAULT_HEARTBEAT_JITTER_MS = 2000;
const uint16_t HEARTBEAT_HTTP_TIMEOUT_MS = 1500;
const uint16_t PULSE_HTTP_TIMEOUT_MS = 2000;
const uint32_t FAIL_CLOSED_MS = 30000;
const uint32_t DEBOUNCE_US = 12000;
const uint16_t VALUE_PER_PULSE_CENTAVOS = 100;

volatile uint16_t pendingPulses = 0;
volatile uint32_t lastInterruptUs = 0;
String hardwareId, deviceToken, serverBase, bootId, currentPulseId;
uint32_t lastHeartbeatAttempt = 0, lastHeartbeatSuccess = 0, pulseSequence = 0;
uint32_t heartbeatIdleMs = DEFAULT_HEARTBEAT_IDLE_MS, heartbeatActiveMs = DEFAULT_HEARTBEAT_ACTIVE_MS, heartbeatJitterMs = DEFAULT_HEARTBEAT_JITTER_MS, heartbeatDelayMs = 0;
uint32_t nextFirmwareAttempt = 0;
uint16_t currentPulseCount = 0;
uint8_t coinPin = DEFAULT_COIN_PIN, enablePin = DEFAULT_ENABLE_PIN;
bool slotEnabled = false, forcedDisabled = false;

String bytesToHex(const uint8_t *value, size_t length) {
  static const char digits[] = "0123456789abcdef";
  String result; result.reserve(length * 2);
  for (size_t i = 0; i < length; i++) { result += digits[value[i] >> 4]; result += digits[value[i] & 0x0f]; }
  return result;
}

bool constantEquals(const String &left, const String &right) {
  if (left.length() != right.length()) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < left.length(); i++) difference |= uint8_t(left[i] ^ right[i]);
  return difference == 0;
}

bool validOtaManifest(const String &digest, const String &signature) {
  if (digest.length() != 64 || signature.length() != 64) return false;
  SHA256 hmac; uint8_t result[32];
  hmac.resetHMAC(VENDO_PROVISION_KEY, strlen(VENDO_PROVISION_KEY));
  hmac.update(digest.c_str(), digest.length());
  hmac.finalizeHMAC(VENDO_PROVISION_KEY, strlen(VENDO_PROVISION_KEY), result, sizeof(result));
  String expected = bytesToHex(result, sizeof(result)); expected.toLowerCase();
  String supplied = signature; supplied.toLowerCase();
  return constantEquals(expected, supplied);
}

void cancelFirmwareUpdate() {
#if defined(ESP32)
  Update.abort();
#else
  Update.end(false);
#endif
}

bool writeVerifiedFirmware(Stream &stream, int length, const String &expectedDigest) {
  if (length <= 0 || expectedDigest.length() != 64) return false;
  if (!Update.begin(static_cast<size_t>(length))) return false;
  SHA256 digest; digest.reset();
  uint8_t buffer[512]; size_t written = 0; uint32_t lastData = millis();
  while (written < static_cast<size_t>(length)) {
    const size_t wanted = min(sizeof(buffer), static_cast<size_t>(length) - written);
    const size_t received = stream.readBytes(buffer, wanted);
    if (received) {
      digest.update(buffer, received);
      if (Update.write(buffer, received) != received) { cancelFirmwareUpdate(); return false; }
      written += received; lastData = millis();
    } else if (millis() - lastData > 15000) { cancelFirmwareUpdate(); return false; }
    delay(1);
  }
  uint8_t result[32]; digest.finalize(result, sizeof(result));
  String actual = bytesToHex(result, sizeof(result)); actual.toLowerCase();
  String expected = expectedDigest; expected.toLowerCase();
  if (!constantEquals(actual, expected)) { Serial.println("OTA: SHA-256 mismatch"); cancelFirmwareUpdate(); return false; }
  return Update.end(true);
}

#if defined(VENDO_USE_W5500)
bool parseHttpUrl(const String &url, String &host, uint16_t &port, String &path) {
  String value = url;
  if (value.startsWith("http://")) value.remove(0, 7);
  else if (value.startsWith("https://")) return false;
  const int slash = value.indexOf('/');
  String authority = slash >= 0 ? value.substring(0, slash) : value;
  path = slash >= 0 ? value.substring(slash) : "/";
  const int colon = authority.lastIndexOf(':');
  host = colon >= 0 ? authority.substring(0, colon) : authority;
  port = colon >= 0 ? authority.substring(colon + 1).toInt() : 80;
  return host.length() > 0 && port > 0;
}

bool networkConnected() {
  const IPAddress ip = Ethernet.localIP();
  return ip[0] || ip[1] || ip[2] || ip[3];
}

bool readHttpHead(EthernetClient &client, int &status, int &contentLength, uint16_t timeoutMs) {
  client.setTimeout(timeoutMs);
  String line = client.readStringUntil('\n');
  line.trim();
  const int firstSpace = line.indexOf(' ');
  status = firstSpace >= 0 ? line.substring(firstSpace + 1).toInt() : -1;
  contentLength = -1;
  while (client.connected()) {
    line = client.readStringUntil('\n');
    line.trim();
    if (!line.length()) break;
    if (line.startsWith("Content-Length:") || line.startsWith("content-length:")) {
      contentLength = line.substring(line.indexOf(':') + 1).toInt();
    }
  }
  return status > 0;
}

String readHttpBody(EthernetClient &client, int contentLength, uint16_t timeoutMs) {
  String body;
  if (contentLength > 0) body.reserve(contentLength);
  uint32_t lastData = millis();
  while ((client.connected() || client.available()) &&
         (contentLength < 0 || body.length() < (size_t)contentLength)) {
    while (client.available() && (contentLength < 0 || body.length() < (size_t)contentLength)) {
      body += char(client.read());
      lastData = millis();
    }
    if (millis() - lastData > timeoutMs) break;
    delay(1);
  }
  client.stop();
  return body;
}

String ethernetRequest(const String &method, const String &url, const String &body,
                       bool authenticated, bool provisioning, int &status,
                       uint16_t timeoutMs, EthernetClient *streamClient = nullptr,
                       int *responseLength = nullptr) {
  String host, path;
  uint16_t port;
  if (!parseHttpUrl(url, host, port, path)) { status = -1; return ""; }
  EthernetClient localClient;
  EthernetClient &client = streamClient ? *streamClient : localClient;
  client.setTimeout(timeoutMs);
  if (!client.connect(host.c_str(), port)) { status = -1; return ""; }
  client.print(method + " " + path + " HTTP/1.1\r\nHost: " + host + "\r\n");
  client.print("Connection: close\r\n");
  if (authenticated) {
    client.print("X-Vendo-Device: " + hardwareId + "\r\n");
    client.print("Authorization: Bearer " + deviceToken + "\r\n");
  }
  if (provisioning) client.print(String("X-Provision-Key: ") + VENDO_PROVISION_KEY + "\r\n");
  if (method == "POST") {
    client.print("Content-Type: application/json\r\nContent-Length: " + String(body.length()) + "\r\n");
  }
  client.print("\r\n");
  if (method == "POST") client.print(body);
  int contentLength = -1;
  if (!readHttpHead(client, status, contentLength, timeoutMs)) { client.stop(); return ""; }
  if (responseLength) *responseLength = contentLength;
  if (streamClient) return "";
  return readHttpBody(client, contentLength, timeoutMs);
}
#else
bool networkConnected() { return WiFi.status() == WL_CONNECTED; }
#endif

IRAM_ATTR void onCoinPulse() {
  const uint32_t now = micros();
  if (now - lastInterruptUs >= DEBOUNCE_US) {
    if (pendingPulses < 1000) pendingPulses++;
    lastInterruptUs = now;
  }
}

void setSlot(bool enabled) {
  const bool previous = slotEnabled;
  slotEnabled = enabled && !forcedDisabled;
  // The coin-slot enable input is active-HIGH. It must only be HIGH while a
  // customer has an open Insert Coin session.
  digitalWrite(enablePin, slotEnabled ? HIGH : LOW);
  if (previous != slotEnabled) {
    Serial.printf("Coin relay: requested=%s actual=%s GPIO=%u level=%s forced=%s\n",
      enabled ? "ON" : "OFF", slotEnabled ? "ON" : "OFF", enablePin,
      slotEnabled ? "HIGH" : "LOW", forcedDisabled ? "yes" : "no");
  }
}

void configurePins(uint8_t nextCoinPin, uint8_t nextEnablePin) {
  setSlot(false);
  detachInterrupt(digitalPinToInterrupt(coinPin));
  coinPin = nextCoinPin;
  enablePin = nextEnablePin;
  pinMode(enablePin, OUTPUT);
  digitalWrite(enablePin, LOW);
  pinMode(coinPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(coinPin), onCoinPulse, FALLING);
  Serial.printf("GPIO config: pulse=GPIO%u FALLING, relay=GPIO%u active-HIGH\n", coinPin, enablePin);
}

String postJson(const String &route, const String &body, bool authenticated, int &status, uint16_t timeoutMs = 5000) {
#if defined(VENDO_USE_W5500)
  return ethernetRequest("POST", serverBase + route, body, authenticated, false, status, timeoutMs);
#else
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, serverBase + route)) { status = -1; return ""; }
  http.setTimeout(timeoutMs);
  http.addHeader("Content-Type", "application/json");
  if (authenticated) {
    http.addHeader("X-Vendo-Device", hardwareId);
    http.addHeader("Authorization", "Bearer " + deviceToken);
  }
  status = http.POST(body);
  String response = status > 0 ? http.getString() : "";
  http.end();
  return response;
#endif
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
  request["coin_pin"] = coinPin;
  request["enable_pin"] = enablePin;
  request["board"] = BOARD_NAME;
  request["device_type"] = "coin";
  String body; serializeJson(request, body);
#if defined(VENDO_USE_W5500)
  int status;
  const String response = ethernetRequest("POST", serverBase + "/api/device/provision", body,
    false, true, status, 6000);
#else
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, serverBase + "/api/device/provision")) return false;
  http.setTimeout(6000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Provision-Key", VENDO_PROVISION_KEY);
  const int status = http.POST(body);
  const String response = status > 0 ? http.getString() : "";
  http.end();
#endif
  if (status != 200) return false;
  JsonDocument result;
  if (deserializeJson(result, response)) return false;
  deviceToken = result["token"].as<String>();
  if (deviceToken.length() < 20) return false;
  heartbeatIdleMs = result["heartbeat_idle_ms"] | heartbeatIdleMs;
  heartbeatActiveMs = result["heartbeat_active_ms"] | heartbeatActiveMs;
  heartbeatJitterMs = result["heartbeat_jitter_ms"] | heartbeatJitterMs;
  saveToken();
  return true;
}

bool installFirmware(const String &route, const String &expectedDigest) {
  setSlot(false);
#if defined(VENDO_USE_W5500)
  EthernetClient client;
  const String url = route.startsWith("http") ? route : serverBase + route;
  int status, length = -1;
  ethernetRequest("GET", url, "", true, false, status, 15000, &client, &length);
  if (status != 200) { client.stop(); return false; }
  const bool complete = writeVerifiedFirmware(client, length, expectedDigest);
  client.stop();
#else
  WiFiClient client;
  HTTPClient http;
  const String url = route.startsWith("http") ? route : serverBase + route;
  if (!http.begin(client, url)) return false;
  http.setTimeout(15000);
  http.addHeader("X-Vendo-Device", hardwareId);
  http.addHeader("Authorization", "Bearer " + deviceToken);
  const int status = http.GET();
  if (status != 200) { http.end(); return false; }
  const int length = http.getSize();
  const bool complete = writeVerifiedFirmware(*http.getStreamPtr(), length, expectedDigest);
  http.end();
#endif
  if (complete) { delay(300); ESP.restart(); }
  return complete;
}

bool acknowledge(uint32_t commandId) {
  JsonDocument ack;
  ack["firmware_version"] = String(VENDO_FIRMWARE_VERSION) + "-" + BOARD_NAME;
  ack["ack_command_ids"].to<JsonArray>().add(commandId);
  String body; serializeJson(ack, body);
  int status; postJson("/api/device/heartbeat", body, true, status, HEARTBEAT_HTTP_TIMEOUT_MS);
  return status == 200;
}

bool heartbeat() {
  JsonDocument request;
  request["firmware_version"] = String(VENDO_FIRMWARE_VERSION) + "-" + BOARD_NAME;
  request["uptime_seconds"] = millis() / 1000;
#ifdef ESP8266
  request["free_heap"] = ESP.getFreeHeap();
#else
  request["free_heap"] = ESP.getFreeHeap();
#endif
#if defined(VENDO_USE_W5500)
  request["rssi"] = 0;
  request["link"] = Ethernet.linkStatus() == LinkON ? "ethernet" : "unknown";
#else
  request["rssi"] = WiFi.RSSI();
#endif
  request["coin_slot"] = slotEnabled ? "enabled" : "disabled";
  String body; serializeJson(request, body);
  int status;
  const String response = postJson("/api/device/heartbeat", body, true, status, HEARTBEAT_HTTP_TIMEOUT_MS);
  if (status == 401) { Serial.println("Heartbeat: token rejected"); deviceToken = ""; LittleFS.remove("/token.txt"); return false; }
  if (status != 200) { Serial.printf("Heartbeat failed: HTTP %d\n", status); return false; }
  JsonDocument result;
  if (deserializeJson(result, response)) return false;
  const uint8_t assignedCoin = result["config"]["coin_pin"] | coinPin;
  const uint8_t assignedEnable = result["config"]["enable_pin"] | enablePin;
  heartbeatIdleMs = result["config"]["heartbeat_idle_ms"] | heartbeatIdleMs;
  heartbeatActiveMs = result["config"]["heartbeat_active_ms"] | heartbeatActiveMs;
  heartbeatJitterMs = result["config"]["heartbeat_jitter_ms"] | heartbeatJitterMs;
  if (assignedCoin != coinPin || assignedEnable != enablePin) configurePins(assignedCoin, assignedEnable);
  const bool requestedSlot = result["coin_slot_enabled"] | false;
  Serial.printf("Heartbeat: slot=%s session=%ld config=%u/%u\n", requestedSlot ? "ON" : "OFF",
    (long)(result["active_session_id"] | 0), assignedCoin, assignedEnable);
  setSlot(requestedSlot);
  for (JsonObject command : result["commands"].as<JsonArray>()) {
    const String action = command["command"].as<String>();
    const uint32_t commandId = command["id"] | 0;
    if (action == "disable_coin") forcedDisabled = true;
    if (action == "enable_coin") forcedDisabled = false;
    if (action == "restart") { acknowledge(commandId); delay(150); ESP.restart(); }
    if (action == "firmware_update") {
      const String url = command["payload"]["url"].as<String>();
      const String targetVersion = command["payload"]["version"].as<String>();
      const String expectedDigest = command["payload"]["sha256"].as<String>();
      const String signature = command["payload"]["signature"].as<String>();
      if (targetVersion == VENDO_FIRMWARE_VERSION) acknowledge(commandId);
      else if (!validOtaManifest(expectedDigest, signature)) Serial.println("OTA: rejected unsigned or invalid manifest");
      else if (url.length() && millis() >= nextFirmwareAttempt) {
        nextFirmwareAttempt = millis() + 60000;
        Serial.printf("OTA: installing version %s\n", targetVersion.c_str());
        installFirmware(url, expectedDigest);
      }
    } else acknowledge(commandId);
  }
  lastHeartbeatSuccess = millis();
  return true;
}

bool sendPulse(uint16_t count) {
  if (!currentPulseId.length()) currentPulseId = bootId + "-" + String(pulseSequence++);
  JsonDocument request;
  request["pulse_id"] = currentPulseId;
  request["value_centavos"] = uint32_t(VALUE_PER_PULSE_CENTAVOS) * count;
  String body; serializeJson(request, body);
  const uint32_t started = millis();
  int status; postJson("/api/device/pulse", body, true, status, PULSE_HTTP_TIMEOUT_MS);
  Serial.printf("Pulse upload: count=%u HTTP=%d latency=%lums\n", count, status, (unsigned long)(millis() - started));
  if (status == 409) setSlot(false);
  return status == 200;
}

void connectWiFi() {
#if defined(VENDO_USE_W5500)
  if (networkConnected()) {
    const int leaseStatus = Ethernet.maintain();
    if (leaseStatus == 2 || leaseStatus == 4) {
      serverBase = String("http://") + Ethernet.gatewayIP().toString() + ":3080";
    }
    return;
  }
  setSlot(false);
  pinMode(W5500_RESET_PIN, OUTPUT);
  digitalWrite(W5500_RESET_PIN, LOW);
  delay(50);
  digitalWrite(W5500_RESET_PIN, HIGH);
  delay(250);
  Ethernet.init(W5500_CS_PIN);
  const uint32_t chip = ESP.getChipId();
  byte mac[6] = { 0x02, 0x56, 0x4E, byte(chip >> 16), byte(chip >> 8), byte(chip) };
  Serial.println("Ethernet: requesting DHCP lease");
  if (Ethernet.begin(mac, 10000, 3000) == 0) {
    Serial.println("Ethernet: DHCP failed");
    return;
  }
  serverBase = String("http://") + Ethernet.gatewayIP().toString() + ":3080";
  Serial.println(String("Ethernet: IP ") + Ethernet.localIP().toString());
  Serial.println(String("Ethernet: gateway ") + Ethernet.gatewayIP().toString());
  Serial.println(String("Controller: ") + serverBase);
  return;
#else
  if (WiFi.status() == WL_CONNECTED) return;
  setSlot(false);
  WiFi.mode(WIFI_STA);

  // Prefer the installation's open management SSID. Calling begin() with
  // only the SSID deliberately clears any stale password saved by an older
  // WiFiManager setup while preserving the LittleFS device token.
  Serial.println(String("WiFi: connecting to open network ") + VENDO_DEFAULT_WIFI_SSID);
  WiFi.disconnect(false);
  delay(100);
  WiFi.begin(VENDO_DEFAULT_WIFI_SSID);
  const uint32_t defaultStarted = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - defaultStarted < 20000) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(String("WiFi: connected, IP ") + WiFi.localIP().toString());
    serverBase = String("http://") + WiFi.gatewayIP().toString() + ":3080";
    Serial.println(String("Controller: ") + serverBase);
    return;
  }

  Serial.println("WiFi: open network unavailable; starting setup portal");
  WiFiManager manager;
  manager.setConfigPortalTimeout(180);
  manager.setConnectTimeout(20);
  const String setupName = String("VendoOS-Setup-") + hardwareId.substring(hardwareId.length() - 4);
  if (!manager.autoConnect(setupName.c_str())) { delay(1000); ESP.restart(); }
  serverBase = String("http://") + WiFi.gatewayIP().toString() + ":3080";
  Serial.println(String("Controller: ") + serverBase);
#endif
}

void setup() {
  Serial.begin(115200);
  LittleFS.begin();
#ifdef ESP8266
  hardwareId = String("ESP8266-") + String(ESP.getChipId(), HEX);
  bootId = String(ESP.getChipId(), HEX) + "-" + String(ESP.random(), HEX);
#else
  const uint64_t chip = ESP.getEfuseMac();
  char id[13]; snprintf(id, sizeof(id), "%04X%08X", (uint16_t)(chip >> 32), (uint32_t)chip);
  hardwareId = String("ESP32-") + id;
  bootId = String(id) + "-" + String(esp_random(), HEX);
#endif
  hardwareId.toUpperCase();
  configurePins(coinPin, enablePin);
  loadToken();
  connectWiFi();
  if (deviceToken.length() < 20) provision();
  heartbeat();
  lastHeartbeatAttempt = millis();
  heartbeatDelayMs = heartbeatJitterMs ? random(heartbeatJitterMs + 1) : 0;
}

void loop() {
  connectWiFi();
  if (networkConnected() && deviceToken.length() < 20) provision();
  noInterrupts(); const bool hasPulse = pendingPulses > 0; interrupts();
  // Coin reports always take priority over heartbeat traffic. This prevents a
  // slow heartbeat request from delaying the customer's live portal update.
  if (hasPulse) {
    Serial.printf("Coin pulse detected: pending=%u slot=%s\n", pendingPulses, slotEnabled ? "ON" : "OFF");
    if (!currentPulseId.length()) {
      noInterrupts(); currentPulseCount = pendingPulses; interrupts();
    }
    if (slotEnabled && networkConnected() && sendPulse(currentPulseCount)) {
      noInterrupts();
      pendingPulses = pendingPulses > currentPulseCount ? pendingPulses - currentPulseCount : 0;
      interrupts();
      currentPulseId = "";
      currentPulseCount = 0;
    } else if (!slotEnabled) {
      noInterrupts(); pendingPulses = 0; interrupts();
      currentPulseId = "";
      currentPulseCount = 0;
    }
    else delay(250);
  }
  const uint32_t heartbeatInterval = slotEnabled ? heartbeatActiveMs : heartbeatIdleMs;
  if (networkConnected() && !hasPulse && millis() - lastHeartbeatAttempt >= heartbeatInterval + heartbeatDelayMs) {
    lastHeartbeatAttempt = millis();
    heartbeat();
    heartbeatDelayMs = heartbeatJitterMs ? random(heartbeatJitterMs + 1) : 0;
  }
  if (millis() - lastHeartbeatSuccess > FAIL_CLOSED_MS) setSlot(false);
  delay(5);
}
